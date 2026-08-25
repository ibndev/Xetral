import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { ExpressAdapter } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import pg from 'pg';
import type { Pool } from 'pg';
import { hashPassword } from '@xetral/identity';
import { LedgerService, posting } from '@xetral/ledger';
import { ngn } from '@xetral/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../app.module.js';
import { systemClock } from '../tokens.js';
import { testApiConfig } from '../test-support/api-config.js';
import { enrolAndElevate } from '../test-support/staff-totp.js';

/**
 * Registration, identity, and the operations backend, over HTTP.
 *
 * These five things each, on their own, made the platform unable to serve a
 * customer: there was no way to open an account, nothing wrote the provider
 * mapping that cards and account numbers require, nothing could set
 * `users.status`, suspense money had no exit, and there was no readiness
 * endpoint. They are tested together because they are one story — a person
 * signing up and being made able to hold money.
 *
 * Requires DATABASE_URL with every migration and 009_admin.seed.sql applied.
 */
const DATABASE_URL = process.env['DATABASE_URL'];
if (DATABASE_URL === undefined || DATABASE_URL === '') {
  throw new Error('the admin e2e suite needs DATABASE_URL with the migrations applied');
}

const PASSWORD = 'a-long-enough-password';
const PIN = '903184';

let pool: Pool;
let ledger: LedgerService;
let app: INestApplication;

interface Person {
  email: string;
  userId: string;
  uuid: string;
  token: string;
}

/** Opens an account THROUGH THE ENDPOINT, which is the point: every other
 *  suite seeds users with an INSERT, so none of them would notice if
 *  registration stopped working. */
async function register(): Promise<Person> {
  const email = `admin-e2e-${randomUUID()}@example.ng`;

  const created = await request(app.getHttpServer())
    .post('/v1/auth/register')
    .send({
      email,
      password: PASSWORD,
      device: { fingerprint: `fp-${randomUUID()}`, platform: 'web' },
    })
    .expect(201);

  const token = created.body.access_token as string;
  const row = await pool.query<{ id: string; uuid: string }>(
    `SELECT id, uuid FROM users WHERE email = $1`,
    [email],
  );
  const found = row.rows[0];
  if (found === undefined) throw new Error('registration created no user');

  await request(app.getHttpServer())
    .post('/v1/auth/pin')
    .set('Authorization', `Bearer ${token}`)
    .send({ pin: PIN })
    .expect(204);

  return { email, userId: found.id, uuid: found.uuid, token };
}

/** Grants a role directly, because the first grant on a fresh deployment has
 *  no `admin` to make it — which is the same reason `deploy/` documents it. */
async function grant(person: Person, role: string): Promise<void> {
  await pool.query(
    `INSERT INTO staff_roles (user_id, role, granted_by) VALUES ($1, $2::staff_role, $1)
     ON CONFLICT DO NOTHING`,
    [person.userId, role],
  );

  // Every staff route now requires a second factor, including the read-only
  // ones — so a role with no authenticator is a role that cannot be used.
  // Enrolment here goes through the real endpoints; see the helper for what
  // it does and does not exercise.
  await enrolAndElevate(app, pool, person.token, person.userId);
}

const submitKyc = (person: Person, overrides: Record<string, string> = {}) =>
  request(app.getHttpServer())
    .post('/v1/kyc')
    .set('Authorization', `Bearer ${person.token}`)
    .send({
      full_name: 'Adaeze Okonkwo',
      date_of_birth: '1994-03-11',
      phone: '+2348012345678',
      bvn: '22345678901',
      address: '14 Bode Thomas Street, Surulere, Lagos',
      ...overrides,
    });

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: DATABASE_URL, max: 8 });
  ledger = new LedgerService(pool);

  const mod = await Test.createTestingModule({
    imports: [
      AppModule.forRoot({
        config: testApiConfig(DATABASE_URL as string),
        pool,
        clock: systemClock,
      }),
    ],
  }).compile();
  app = mod.createNestApplication(new ExpressAdapter());
  await app.init();
});

afterAll(async () => {
  await app?.close();
  await pool?.end();
});

describe('opening an account', () => {
  it('creates a user, a credential and a live session in one request', async () => {
    const email = `register-${randomUUID()}@example.ng`;

    const res = await request(app.getHttpServer())
      .post('/v1/auth/register')
      .send({
        email,
        password: PASSWORD,
        device: { fingerprint: `fp-${randomUUID()}`, platform: 'web' },
      })
      .expect(201);

    expect(typeof res.body.access_token).toBe('string');
    expect(typeof res.body.refresh_token).toBe('string');

    // And the session works immediately. Registration that returns tokens the
    // holder cannot use is a sign-in form with extra steps.
    await request(app.getHttpServer())
      .get('/v1/auth/session')
      .set('Authorization', `Bearer ${res.body.access_token as string}`)
      .expect(200);
  });

  it('refuses an address that is already taken, without saying more', async () => {
    const email = `dupe-${randomUUID()}@example.ng`;
    const body = {
      email,
      password: PASSWORD,
      device: { fingerprint: `fp-${randomUUID()}`, platform: 'web' },
    };

    await request(app.getHttpServer()).post('/v1/auth/register').send(body).expect(201);

    const second = await request(app.getHttpServer()).post('/v1/auth/register').send(body);
    expect(second.status).toBe(409);
    expect(second.body.error).toBe('email_taken');
  });

  it('refuses a password too short to be worth hashing', async () => {
    const res = await request(app.getHttpServer())
      .post('/v1/auth/register')
      .send({
        email: `weak-${randomUUID()}@example.ng`,
        password: 'short',
        device: { fingerprint: `fp-${randomUUID()}`, platform: 'web' },
      });

    expect([400, 422]).toContain(res.status);
    expect(['weak_password', 'invalid_request']).toContain(res.body.error);
  });
});

describe('setting a transaction PIN', () => {
  /*
   * EVERY suite before this one used a valid PIN, so nothing ever reached the
   * policy's failing branch — and it turned out to escape as an unhandled
   * error, giving a bare 500 on the one step a customer must complete before
   * they can move any money. Found by typing a wrong-length PIN by hand.
   */
  const REJECTED: readonly [string, string][] = [
    ['12345', 'five digits'],
    ['1234567', 'seven digits'],
    ['111111', 'the same digit repeated'],
    ['123456', 'a run of consecutive digits'],
  ];

  for (const [pin, why] of REJECTED) {
    it(`refuses ${why} with a reason, not a 500`, async () => {
      const person = await register();

      const res = await request(app.getHttpServer())
        .post('/v1/auth/pin')
        .set('Authorization', `Bearer ${person.token}`)
        .send({ pin, current_pin: PIN });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('weak_pin');
      // The detail names the RULE, which is what lets somebody pick another
      // PIN. It must never quote the PIN back.
      expect(typeof res.body.detail).toBe('string');
      expect(JSON.stringify(res.body)).not.toContain(pin);
    });
  }

  it('accepts a PIN that satisfies the policy', async () => {
    const person = await register();
    await request(app.getHttpServer())
      .post('/v1/auth/pin')
      .set('Authorization', `Bearer ${person.token}`)
      .send({ pin: '571394', current_pin: PIN })
      .expect(204);
  });
});

describe('liveness and readiness', () => {
  it('answers liveness without touching anything', async () => {
    const res = await request(app.getHttpServer()).get('/health').expect(200);
    expect(res.body.status).toBe('ok');
  });

  it('answers readiness by actually asking the database', async () => {
    const res = await request(app.getHttpServer()).get('/ready').expect(200);
    expect(res.body.database).toBe('ok');
  });

  it('needs no token for either', async () => {
    // A load balancer has no session. A health endpoint behind auth is a
    // health endpoint that reports the whole fleet as unhealthy.
    await request(app.getHttpServer()).get('/health').expect(200);
    await request(app.getHttpServer()).get('/ready').expect(200);
  });
});

describe('identity verification', () => {
  it('seals the BVN and returns only its last four digits', async () => {
    const person = await register();
    const res = await submitKyc(person).expect(200);

    expect(res.body.bvn_last4).toBe('8901');
    expect(JSON.stringify(res.body)).not.toContain('22345678901');

    const stored = await pool.query<{ bvn_sealed: string; bvn_last4: string }>(
      `SELECT bvn_sealed, bvn_last4 FROM kyc_submissions WHERE user_id = $1`,
      [person.userId],
    );
    // Structural, not customary: the CHECK refuses a value without a key
    // version, so a plaintext BVN cannot reach the row even by accident.
    expect(stored.rows[0]?.bvn_sealed).toMatch(/^v[0-9]+:/);
    expect(stored.rows[0]?.bvn_sealed).not.toContain('22345678901');
  });

  it('refuses somebody too young to hold an account', async () => {
    const person = await register();
    const child = new Date();
    child.setFullYear(child.getFullYear() - 12);

    const res = await submitKyc(person, {
      date_of_birth: child.toISOString().slice(0, 10),
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('below_minimum_age');
  });

  it('APPROVING is what creates the provider mapping', async () => {
    const person = await register();
    const reviewer = await register();
    await grant(reviewer, 'compliance');

    await submitKyc(person).expect(200);

    // Before: no mapping, so a card or an account number is refused. This is
    // the state every customer was permanently stuck in.
    const before = await pool.query(
      `SELECT 1 FROM provider_customers WHERE user_id = $1`,
      [person.userId],
    );
    expect(before.rowCount).toBe(0);

    const queue = await request(app.getHttpServer())
      .get('/v1/admin/kyc')
      .set('Authorization', `Bearer ${reviewer.token}`)
      .expect(200);

    const submission = (queue.body.queue as { id: string; email: string }[]).find(
      (s) => s.email === person.email,
    );
    expect(submission).toBeDefined();
    // `id`, not `uuid`. The reviewer's approve button posts to
    // `/kyc/<id>/review`, and this field being named differently from every
    // other view in the service made that path `/kyc/undefined/review`.
    expect(typeof submission?.id).toBe('string');

    await request(app.getHttpServer())
      .post(`/v1/admin/kyc/${submission?.id ?? ''}/review`)
      .set('Authorization', `Bearer ${reviewer.token}`)
      .send({ decision: 'approve', transaction_pin: PIN })
      .expect(200);

    const after = await pool.query(
      `SELECT provider FROM provider_customers WHERE user_id = $1`,
      [person.userId],
    );
    expect(after.rowCount).toBe(1);
  });

  it('will not let a reviewer approve their own submission', async () => {
    const person = await register();
    await grant(person, 'compliance');
    await submitKyc(person).expect(200);

    const queue = await request(app.getHttpServer())
      .get('/v1/admin/kyc')
      .set('Authorization', `Bearer ${person.token}`)
      .expect(200);

    const own = (queue.body.queue as { id: string; email: string }[]).find(
      (s) => s.email === person.email,
    );

    const res = await request(app.getHttpServer())
      .post(`/v1/admin/kyc/${own?.id ?? ''}/review`)
      .set('Authorization', `Bearer ${person.token}`)
      .send({ decision: 'approve', transaction_pin: PIN });

    // Refused by a CHECK on the table, not by a page hiding a button.
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});

describe('the operations surface', () => {
  it('refuses a signed-in customer with no role', async () => {
    const customer = await register();

    for (const path of ['/v1/admin/overview', '/v1/admin/users', '/v1/admin/settings']) {
      const res = await request(app.getHttpServer())
        .get(path)
        .set('Authorization', `Bearer ${customer.token}`);
      expect(res.status).toBe(403);
    }
  });

  it('refuses an unsigned caller with 401 rather than 403', async () => {
    // The difference matters: 403 to an anonymous caller confirms the route
    // exists and is staff-only, which is a map for somebody probing.
    const res = await request(app.getHttpServer()).get('/v1/admin/overview');
    expect(res.status).toBe(401);
  });

  it('graduates roles rather than having one admin flag', async () => {
    const support = await register();
    await grant(support, 'support');

    // Support reads customers...
    await request(app.getHttpServer())
      .get('/v1/admin/users')
      .set('Authorization', `Bearer ${support.token}`)
      .expect(200);

    // ...and cannot change a fee. Somebody answering the phone does not need
    // the ability to reprice every transfer.
    const res = await request(app.getHttpServer())
      .get('/v1/admin/settings')
      .set('Authorization', `Bearer ${support.token}`);
    expect(res.status).toBe(403);
  });

  it('reads roles fresh, so revoking one bites on the next request', async () => {
    const person = await register();
    await grant(person, 'support');

    await request(app.getHttpServer())
      .get('/v1/admin/users')
      .set('Authorization', `Bearer ${person.token}`)
      .expect(200);

    await pool.query(
      `UPDATE staff_roles SET revoked_at = now() WHERE user_id = $1 AND role = 'support'`,
      [person.userId],
    );

    // The SAME access token, which is still perfectly valid and unexpired.
    // A role carried inside it would keep working for another fifteen minutes
    // — and the moment you most want somebody's access gone is the moment you
    // have just found out why.
    const after = await request(app.getHttpServer())
      .get('/v1/admin/users')
      .set('Authorization', `Bearer ${person.token}`);
    expect(after.status).toBe(403);
  });
});

describe('freezing an account', () => {
  it('stops money moving without touching the balance', async () => {
    const customer = await register();
    const recipient = await register();
    const officer = await register();
    await grant(officer, 'compliance');

    await ledger.post({
      idempotencyKey: `admin-e2e-fund:${randomUUID()}`,
      kind: 'wallet_funding',
      occurredAt: new Date(),
      description: 'test funding',
      metadata: {},
      postings: [
        posting({ kind: 'customer_wallet', ownerId: customer.userId, currency: 'NGN' }, ngn(5_000_00)),
        posting({ kind: 'provider_float', currency: 'NGN' }, ngn(-5_000_00)),
      ],
    });

    await request(app.getHttpServer())
      .post(`/v1/admin/users/${customer.uuid}/status`)
      .set('Authorization', `Bearer ${officer.token}`)
      .send({ status: 'frozen', reason: 'suspected account takeover', transaction_pin: PIN })
      .expect(200);

    // The money is STILL THEIRS. Freezing stops it moving; conflating that
    // with taking it is how a support action becomes a seizure.
    const balance = await pool.query<{ balance_minor: string }>(
      `SELECT b.balance_minor::text FROM account_balances b
         JOIN accounts a ON a.id = b.account_id
        WHERE a.kind = 'customer_wallet' AND a.owner_id = $1::bigint AND a.currency = 'NGN'`,
      [customer.userId],
    );
    expect(balance.rows[0]?.balance_minor).toBe('500000');

    // Freezing revokes live sessions, so it bites now rather than at the next
    // refresh — which means this token is gone as well as the account.
    const transfer = await request(app.getHttpServer())
      .post('/v1/wallets/transfers')
      .set('Authorization', `Bearer ${customer.token}`)
      .send({
        recipient: recipient.email,
        amount: '100.00',
        currency: 'NGN',
        transaction_pin: PIN,
        idempotency_key: `frozen-${randomUUID()}`,
      });
    expect([401, 403]).toContain(transfer.status);
  });

  it('records who froze it and why, in a row that requires a reason', async () => {
    const customer = await register();
    const officer = await register();
    await grant(officer, 'compliance');

    await request(app.getHttpServer())
      .post(`/v1/admin/users/${customer.uuid}/status`)
      .set('Authorization', `Bearer ${officer.token}`)
      .send({ status: 'frozen', reason: 'chargeback pattern on funding', transaction_pin: PIN })
      .expect(200);

    const change = await pool.query<{ reason: string; to_status: string }>(
      `SELECT reason, to_status FROM user_status_changes WHERE user_id = $1`,
      [customer.userId],
    );
    expect(change.rows[0]?.to_status).toBe('frozen');
    expect(change.rows[0]?.reason).toBe('chargeback pattern on funding');
  });

  it('refuses without a reason', async () => {
    const customer = await register();
    const officer = await register();
    await grant(officer, 'compliance');

    const res = await request(app.getHttpServer())
      .post(`/v1/admin/users/${customer.uuid}/status`)
      .set('Authorization', `Bearer ${officer.token}`)
      .send({ status: 'frozen', transaction_pin: PIN });

    expect(res.status).toBe(400);
  });
});

describe('settings', () => {
  it('records every change with who made it', async () => {
    const officer = await register();
    await grant(officer, 'finance');

    const original = await pool.query<{ value: string }>(
      `SELECT value FROM platform_settings WHERE key = 'reconcile_stale_hours'`,
    );

    await request(app.getHttpServer())
      .post('/v1/admin/settings/reconcile_stale_hours')
      .set('Authorization', `Bearer ${officer.token}`)
      .send({ value: '36', transaction_pin: PIN })
      .expect(200);

    const history = await request(app.getHttpServer())
      .get('/v1/admin/settings/reconcile_stale_hours/history')
      .set('Authorization', `Bearer ${officer.token}`)
      .expect(200);

    const latest = (history.body.history as { new_value: string; changed_by: string }[])[0];
    expect(latest?.new_value).toBe('36');
    expect(latest?.changed_by).toBe(officer.email);

    // Restore, or the next suite against this database inherits a setting it
    // never chose.
    await pool.query(`UPDATE platform_settings SET value = $1 WHERE key = 'reconcile_stale_hours'`, [
      original.rows[0]?.value ?? '24',
    ]);
  });

  it('refuses a value outside its bounds, at the database', async () => {
    const officer = await register();
    await grant(officer, 'finance');

    // 1500 basis points is 15%, typed where somebody meant 1.5%. The one
    // mistake that takes money from every customer at once.
    const res = await request(app.getHttpServer())
      .post('/v1/admin/settings/transfer_fee_basis_points')
      .set('Authorization', `Bearer ${officer.token}`)
      .send({ value: '1500', transaction_pin: PIN });

    // 400: the request was understood and the VALUE is wrong, which is a fact
    // about the payload rather than about the system's state.
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_setting');

    const stored = await pool.query<{ value: string }>(
      `SELECT value FROM platform_settings WHERE key = 'transfer_fee_basis_points'`,
    );
    expect(stored.rows[0]?.value).not.toBe('1500');
  });

  it('refuses a value of the wrong type', async () => {
    const officer = await register();
    await grant(officer, 'finance');

    const res = await request(app.getHttpServer())
      .post('/v1/admin/settings/gift_cards_enabled')
      .set('Authorization', `Bearer ${officer.token}`)
      .send({ value: 'yes', transaction_pin: PIN });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_setting');
  });
});

describe('the audit log', () => {
  it('records what an operator did, with their reason', async () => {
    const customer = await register();
    const officer = await register();
    await grant(officer, 'compliance');
    await grant(officer, 'admin');

    await request(app.getHttpServer())
      .post(`/v1/admin/users/${customer.uuid}/status`)
      .set('Authorization', `Bearer ${officer.token}`)
      .send({ status: 'frozen', reason: 'audit trail check', transaction_pin: PIN })
      .expect(200);

    const log = await request(app.getHttpServer())
      .get('/v1/admin/audit?limit=20')
      .set('Authorization', `Bearer ${officer.token}`)
      .expect(200);

    const entry = (log.body.entries as { action: string; actor: string; reason: string }[]).find(
      (e) => e.reason === 'audit trail check',
    );
    expect(entry).toBeDefined();
    expect(entry?.actor).toBe(officer.email);
  });

  it('cannot be edited or deleted, even by the database owner', async () => {
    // The whole value of the log rests on this. A log a privileged user can
    // edit tells you what the last person with access wanted you to believe.
    await expect(
      pool.query(`UPDATE admin_audit_log SET action = 'nothing' WHERE id = (SELECT min(id) FROM admin_audit_log)`),
    ).rejects.toThrow();

    await expect(
      pool.query(`DELETE FROM admin_audit_log WHERE id = (SELECT min(id) FROM admin_audit_log)`),
    ).rejects.toThrow();
  });
});
