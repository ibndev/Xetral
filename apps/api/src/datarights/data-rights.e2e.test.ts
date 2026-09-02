import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { ExpressAdapter } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import pg from 'pg';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LedgerService, posting } from '@xetral/ledger';
import { ngn } from '@xetral/shared';
import { AppModule } from '../app.module.js';
import { systemClock } from '../tokens.js';
import { testApiConfig } from '../test-support/api-config.js';
import { enrolAndElevate } from '../test-support/staff-totp.js';

/**
 * A customer's data, over HTTP.
 *
 * THE ASSERTION THAT MATTERS is the one scanning a real export for secrets.
 * Everything else here could be right and the feature still be a disaster: an
 * export is a bearer document the moment it is downloaded, and a password hash
 * or a sealed BVN riding along in it undoes the reason for hashing and sealing
 * them. The scan is over the SERIALISED body, not over named fields, because
 * the failure being guarded against is a field nobody thought to name.
 */
const DATABASE_URL = process.env['DATABASE_URL'];
if (DATABASE_URL === undefined || DATABASE_URL === '') {
  throw new Error('the data rights e2e suite needs DATABASE_URL with the migrations applied');
}

const PASSWORD = 'a-long-enough-password';
const PIN = '374915';

let pool: Pool;
let ledger: LedgerService;
let app: INestApplication;

interface Customer {
  identifier: string;
  userId: string;
  token: string;
}

async function register(): Promise<Customer> {
  const identifier = `rights-${randomUUID()}@example.ng`;
  const res = await request(app.getHttpServer())
    .post('/v1/auth/register')
    .send({
      email: identifier,
      password: PASSWORD,
      // 040 made these required. A registration is now a name, a place
      // and a reachable number as well as an address.
      full_name: 'E2E Test Person',
      country: 'NG',
      phone: String(8000000000 + Math.floor(Math.random() * 999999999)),
      device: { fingerprint: `fp-${randomUUID()}`, platform: 'ios' },
    })
    .expect(201);
  const token = res.body.access_token as string;

  await request(app.getHttpServer())
    .post('/v1/auth/pin')
    .set('Authorization', `Bearer ${token}`)
    .send({ pin: PIN })
    .expect(204);

  const found = await pool.query<{ id: string }>(`SELECT id FROM users WHERE email = $1`, [
    identifier,
  ]);
  return { identifier, userId: found.rows[0]?.id as string, token };
}

const exportFor = (customer: Customer, pin: string = PIN) =>
  request(app.getHttpServer())
    .post('/v1/me/export')
    .set('Authorization', `Bearer ${customer.token}`)
    .send({ transaction_pin: pin });

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: DATABASE_URL, max: 8 });
  ledger = new LedgerService(pool);
  const mod = await Test.createTestingModule({
    imports: [
      AppModule.forRoot({ config: testApiConfig(DATABASE_URL as string), pool, clock: systemClock }),
    ],
  }).compile();
  app = mod.createNestApplication(new ExpressAdapter());
  await app.init();
});

afterAll(async () => {
  await app?.close();
  await pool?.end();
});

describe('the export', () => {
  it('carries nothing secret', async () => {
    const person = await register();

    // Real secrets, on this customer's rows, so the scan has something to
    // find rather than proving an absence twice.
    const secrets = await pool.query<{ password_hash: string; pin_hash: string }>(
      `SELECT c.password_hash, p.pin_hash
         FROM user_credentials c JOIN transaction_pins p ON p.user_id = c.user_id
        WHERE c.user_id = $1::bigint`,
      [person.userId],
    );
    const passwordHash = secrets.rows[0]?.password_hash as string;
    const pinHash = secrets.rows[0]?.pin_hash as string;
    expect(passwordHash).toBeTruthy();
    expect(pinHash).toBeTruthy();

    const res = await exportFor(person).expect(200);
    const serialised = JSON.stringify(res.body);

    // Over the WHOLE body, not over named fields: what is being guarded
    // against is a field nobody thought to name.
    expect(serialised).not.toContain(passwordHash);
    expect(serialised).not.toContain(pinHash);
    expect(serialised).not.toContain(PIN);
    expect(serialised).not.toContain(PASSWORD);
    expect(serialised).not.toContain('password_hash');
    expect(serialised).not.toContain('pin_hash');
    expect(serialised).not.toContain('bvn_sealed');
    expect(serialised).not.toContain('token_hash');
  });

  it('says what it does NOT include', async () => {
    // An export that silently omits things is indistinguishable from a
    // complete one, and a customer checking whether we hold their BVN
    // deserves an answer rather than an absence.
    const person = await register();
    const res = await exportFor(person).expect(200);
    expect((res.body.not_included as string[]).length).toBeGreaterThan(0);
    expect(JSON.stringify(res.body.not_included)).toContain('BVN');
  });

  it('includes what the customer actually has', async () => {
    const person = await register();
    const res = await exportFor(person).expect(200);

    expect(res.body.profile).toMatchObject({ status: 'active' });
    // Registration recorded these, so a complete export has them.
    expect((res.body.consents as { kind: string }[]).map((c) => c.kind).sort()).toEqual([
      'privacy',
      'terms',
    ]);
    expect(Array.isArray(res.body.transactions)).toBe(true);
  });

  it('needs the transaction PIN', async () => {
    // A departure from every other read here, and deliberate: this is every
    // balance, every transaction and every place they have signed in from, in
    // one file — the single read a stolen session most wants.
    const person = await register();
    const res = await request(app.getHttpServer())
      .post('/v1/me/export')
      .set('Authorization', `Bearer ${person.token}`)
      .send({});
    expect(res.status).toBe(400);
  });

  it('refuses a wrong PIN', async () => {
    const person = await register();
    const res = await exportFor(person, '000000');
    expect(res.status).toBe(401);
  });

  it('needs a token', async () => {
    const res = await request(app.getHttpServer()).post('/v1/me/export').send({});
    expect(res.status).toBe(401);
  });
});

describe('asking', () => {
  it('records the request with a deadline we set', async () => {
    const person = await register();
    const res = await request(app.getHttpServer())
      .post('/v1/me/requests')
      .set('Authorization', `Bearer ${person.token}`)
      .send({ kind: 'erasure' })
      .expect(201);

    expect(res.body.status).toBe('open');
    const deadline = new Date(res.body.deadline_at as string).getTime();
    // Within the statutory month, whatever the caller sent.
    expect(deadline).toBeGreaterThan(Date.now());
    expect(deadline).toBeLessThan(Date.now() + 31 * 24 * 60 * 60 * 1000);
  });

  it('takes no PIN', async () => {
    // The customer most likely to ask is one who has just found somebody else
    // in their account, and demanding the factor that person may already have
    // is worst exactly then. Nothing is destroyed by asking.
    const person = await register();
    await request(app.getHttpServer())
      .post('/v1/me/requests')
      .set('Authorization', `Bearer ${person.token}`)
      .send({ kind: 'export' })
      .expect(201);
  });

  it('tells a customer their request is already open', async () => {
    const person = await register();
    await request(app.getHttpServer())
      .post('/v1/me/requests')
      .set('Authorization', `Bearer ${person.token}`)
      .send({ kind: 'erasure' })
      .expect(201);

    const again = await request(app.getHttpServer())
      .post('/v1/me/requests')
      .set('Authorization', `Bearer ${person.token}`)
      .send({ kind: 'erasure' });
    expect(again.status).toBe(409);
    expect(again.body.error).toBe('request_already_open');
  });

  it('publishes what can and cannot be erased, to the customer', async () => {
    // Being refused with no way to learn what would change is what turns a
    // right into a support ticket — the same argument GET /v1/kyc/limits
    // rests on.
    const person = await register();
    const res = await request(app.getHttpServer())
      .get('/v1/me/erasure-scope')
      .set('Authorization', `Bearer ${person.token}`)
      .expect(200);

    const scope = res.body.scope as { table_name: string; scope: string; rationale: string }[];
    const ledger = scope.find((row) => row.table_name === 'journal_entries');
    expect(ledger?.scope).toBe('retained');
    // The reason comes from `retention_decisions`, the same table the deletion
    // sweep reads, so the promise and the job that keeps it cannot describe
    // different systems.
    expect(ledger?.rationale.length).toBeGreaterThan(20);
  });
});

/** Grants a role directly, because the first grant on a fresh deployment has
 *  no `admin` to make it — the same reason `deploy/` documents it. Every staff
 *  route needs a second factor, reads included, so a role with no
 *  authenticator is a role that cannot be used. */
async function makeStaff(person: Customer, role: string): Promise<void> {
  await pool.query(
    `INSERT INTO staff_roles (user_id, role, granted_by) VALUES ($1, $2::staff_role, $1)
     ON CONFLICT DO NOTHING`,
    [person.userId, role],
  );
  await enrolAndElevate(app, pool, person.token, person.userId);
}

describe('what a reviewer does with it', () => {
  it('erases, and records what stayed as the audit reason', async () => {
    const subject = await register();
    await request(app.getHttpServer())
      .post('/v1/me/requests')
      .set('Authorization', `Bearer ${subject.token}`)
      .send({ kind: 'erasure' })
      .expect(201);

    const found = await pool.query<{ uuid: string }>(
      `SELECT uuid FROM data_requests WHERE user_id = $1::bigint AND kind = 'erasure'`,
      [subject.userId],
    );
    const requestUuid = found.rows[0]?.uuid as string;

    const reviewer = await register();
    await makeStaff(reviewer, 'compliance');

    const res = await request(app.getHttpServer())
      .post(`/v1/admin/data-requests/${requestUuid}/erase`)
      .set('Authorization', `Bearer ${reviewer.token}`)
      .send({ transaction_pin: PIN })
      .expect(200);

    // The outcome names what went AND what stayed. An answer listing only the
    // deletions would read as a complete erasure, which this is not.
    expect(res.body.outcome as string).toContain('Erased');
    expect(res.body.outcome as string).toContain('Retained');

    // The account is closed and the address is a tombstone rather than a
    // null: `users.email` is how a duplicate account is refused.
    const after = await pool.query<{ email: string; status: string }>(
      `SELECT email, status::text AS status FROM users WHERE id = $1::bigint`,
      [subject.userId],
    );
    expect(after.rows[0]?.status).toBe('closed');
    expect(after.rows[0]?.email).not.toBe(subject.identifier);
    expect(after.rows[0]?.email).toContain('@invalid');

    // Destructive, so a reason is required by CHECK — and the reason IS the
    // outcome, which is the answer the customer receives.
    const audit = await pool.query<{ reason: string }>(
      `SELECT reason FROM admin_audit_log
        WHERE action = 'data.erase' AND subject_id = $1`,
      [requestUuid],
    );
    expect(audit.rows[0]?.reason).toContain('Retained');
  });

  it('REFUSES while the customer still holds money', async () => {
    // Erasing the person we owe money to does not discharge the debt, it
    // loses the creditor.
    const subject = await register();
    /*
     * FUNDED THROUGH THE LEDGER, not by writing `account_balances`.
     *
     * The first version of this fixture set the balance directly, which is a
     * materialised balance no posting explains — and `ledger_drift` is
     * precisely the view that reports one. The provider e2e suite, running
     * later against the same shared database, failed on it: the fixture broke
     * a test in another workspace that was doing its job. A balance that
     * arrives from nowhere is the exact thing 011 exists to make impossible.
     */
    await ledger.post({
      idempotencyKey: `rights-fund:${randomUUID()}`,
      kind: 'wallet_funding',
      occurredAt: new Date(),
      description: 'test funding',
      metadata: {},
      postings: [
        posting({ kind: 'customer_wallet', ownerId: subject.userId, currency: 'NGN' }, ngn(1_000_00)),
        posting({ kind: 'provider_float', currency: 'NGN' }, ngn(-1_000_00)),
      ],
    });

    await request(app.getHttpServer())
      .post('/v1/me/requests')
      .set('Authorization', `Bearer ${subject.token}`)
      .send({ kind: 'erasure' })
      .expect(201);

    const found = await pool.query<{ uuid: string }>(
      `SELECT uuid FROM data_requests WHERE user_id = $1::bigint AND kind = 'erasure'`,
      [subject.userId],
    );

    const reviewer = await register();
    await makeStaff(reviewer, 'compliance');

    const res = await request(app.getHttpServer())
      .post(`/v1/admin/data-requests/${found.rows[0]?.uuid as string}/erase`)
      .set('Authorization', `Bearer ${reviewer.token}`)
      .send({ transaction_pin: PIN });

    expect(res.status).toBe(422);
    // ONE code for two reasons. The other is an open investigation, and
    // distinguishing them here would reintroduce the tipping-off the schema
    // went out of its way to avoid.
    expect(res.body.error).toBe('erasure_blocked');

    // And nothing was destroyed on the way to refusing.
    const after = await pool.query<{ status: string }>(
      `SELECT status::text AS status FROM users WHERE id = $1::bigint`,
      [subject.userId],
    );
    expect(after.rows[0]?.status).toBe('active');
  });
});
