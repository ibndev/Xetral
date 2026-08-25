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
 * Disputes end to end: a customer raises one, a reviewer answers it, and the
 * money moves only when it is upheld.
 *
 * The rules themselves live in triggers and constraints, and
 * `018_disputes.test.sql` proves them there. What this suite covers is the
 * half only an HTTP request can reach: that the refusals become codes a
 * customer can act on, that a claim against somebody else's entry is
 * indistinguishable from one against an entry that does not exist, and that
 * upholding one posts an APPENDED refund rather than editing anything.
 */
const DATABASE_URL = process.env['DATABASE_URL'];
if (DATABASE_URL === undefined || DATABASE_URL === '') {
  throw new Error('the disputes e2e suite needs DATABASE_URL with the migrations applied');
}

const PASSWORD = 'a-long-enough-password';
const PIN = '904271';

let pool: Pool;
let ledger: LedgerService;
let app: INestApplication;

interface Customer {
  identifier: string;
  userId: string;
  uuid: string;
  token: string;
}

async function onboard(): Promise<Customer> {
  const identifier = `dispute-${randomUUID()}@example.ng`;
  const inserted = await pool.query<{ id: string; uuid: string }>(
    `INSERT INTO users (email, status) VALUES ($1, 'active') RETURNING id, uuid`,
    [identifier],
  );
  const row = inserted.rows[0];
  if (row === undefined) throw new Error('failed to seed user');

  await pool.query(`INSERT INTO user_credentials (user_id, password_hash) VALUES ($1, $2)`, [
    row.id,
    await hashPassword(PASSWORD),
  ]);

  const login = await request(app.getHttpServer())
    .post('/v1/auth/login')
    .send({
      identifier,
      password: PASSWORD,
      device: { fingerprint: `fp-${randomUUID()}`, platform: 'ios' },
    })
    .expect(200);

  const token = login.body.access_token as string;
  await request(app.getHttpServer())
    .post('/v1/auth/pin')
    .set('Authorization', `Bearer ${token}`)
    .send({ pin: PIN })
    .expect(204);

  return { identifier, userId: row.id, uuid: row.uuid, token };
}

async function makeReviewer(): Promise<Customer> {
  const reviewer = await onboard();
  await pool.query(`INSERT INTO staff_roles (user_id, role) VALUES ($1, 'dispute_reviewer')`, [
    reviewer.userId,
  ]);
  await enrolAndElevate(app, pool, reviewer.token, reviewer.userId);
  return reviewer;
}

async function fund(userId: string, minor: number): Promise<void> {
  await ledger.post({
    idempotencyKey: `dispute-fund:${randomUUID()}`,
    kind: 'wallet_funding',
    occurredAt: new Date(),
    description: 'test funding',
    metadata: {},
    postings: [
      posting({ kind: 'customer_wallet', ownerId: userId, currency: 'NGN' }, ngn(minor)),
      posting({ kind: 'provider_float', currency: 'NGN' }, ngn(-minor)),
    ],
  });
}

/** A transfer from `from` to `to`, returning the entry UUID to dispute. */
async function transfer(from: Customer, to: Customer, minor = 5_000_00): Promise<string> {
  const sent = await request(app.getHttpServer())
    .post('/v1/wallets/transfers')
    .set('Authorization', `Bearer ${from.token}`)
    .send({
      recipient: to.identifier,
      amount: (minor / 100).toFixed(2),
      currency: 'NGN',
      transaction_pin: PIN,
      idempotency_key: randomUUID(),
    })
    .expect(200);
  return sent.body.entry_id as string;
}

const raise = (customer: Customer, body: Record<string, unknown>) =>
  request(app.getHttpServer())
    .post('/v1/disputes')
    .set('Authorization', `Bearer ${customer.token}`)
    .send(body);

const spendable = async (customer: Customer): Promise<string> => {
  const res = await request(app.getHttpServer())
    .get('/v1/wallets')
    .set('Authorization', `Bearer ${customer.token}`)
    .expect(200);
  const ngnRow = (res.body.balances as { currency: string; spendable: string }[]).find(
    (b) => b.currency === 'NGN',
  );
  return ngnRow?.spendable ?? '0.00';
};

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: DATABASE_URL, max: 8 });
  ledger = new LedgerService(pool);
  app = await Test.createTestingModule({
    imports: [
      AppModule.forRoot({
        config: testApiConfig(DATABASE_URL as string),
        pool,
        clock: systemClock,
      }),
    ],
  })
    .compile()
    .then(async (mod) => {
      const created = mod.createNestApplication(new ExpressAdapter());
      await created.init();
      return created;
    });
});

afterAll(async () => {
  await app?.close();
  await pool?.end();
});

describe('raising a dispute', () => {
  it('records the claim and moves NO money', async () => {
    // A claim is an assertion about a fact, not a fact. Crediting on the
    // strength of one would make "dispute everything" a free withdrawal.
    const sender = await onboard();
    const recipient = await onboard();
    await fund(sender.userId, 20_000_00);

    const entryId = await transfer(sender, recipient);
    const before = await spendable(sender);

    const raised = await raise(sender, {
      entry_id: entryId,
      reason: 'not_authorised',
      detail: 'I did not send this and I do not know the recipient',
    }).expect(200);

    expect(raised.body.status).toBe('open');
    expect(raised.body.entry_id).toBe(entryId);
    // The deadline comes from the database, so it is real and in the future.
    expect(new Date(raised.body.due_at).getTime()).toBeGreaterThan(Date.now());

    expect(await spendable(sender)).toBe(before);
  });

  it('takes NO transaction PIN', async () => {
    // Deliberate. The customer most likely to raise a dispute has just found
    // out somebody else is in their account — demanding the factor that person
    // may already have is worst at exactly that moment. Same reasoning that
    // freezes a card without a PIN.
    const sender = await onboard();
    const recipient = await onboard();
    await fund(sender.userId, 20_000_00);
    const entryId = await transfer(sender, recipient);

    await raise(sender, {
      entry_id: entryId,
      reason: 'not_authorised',
      detail: 'no pin in this body at all',
    }).expect(200);
  });

  it('answers the SAME WAY for a stranger entry and one that does not exist', async () => {
    // THE ENUMERATION TEST. Distinguishing the two would turn the complaints
    // form into a way to discover which transaction ids are real, and put a
    // stranger's entry into a queue staff will then go and read.
    const sender = await onboard();
    const recipient = await onboard();
    const outsider = await onboard();
    await fund(sender.userId, 20_000_00);
    const entryId = await transfer(sender, recipient);

    const notTheirs = await raise(outsider, {
      entry_id: entryId,
      reason: 'not_authorised',
      detail: 'this is somebody else transaction',
    }).expect(404);

    const notReal = await raise(outsider, {
      entry_id: randomUUID(),
      reason: 'not_authorised',
      detail: 'this entry does not exist',
    }).expect(404);

    expect(notTheirs.body).toEqual(notReal.body);
    expect(notTheirs.body.error).toBe('entry_not_found');
  });

  it('refuses a SECOND live dispute against the same entry', async () => {
    const sender = await onboard();
    const recipient = await onboard();
    await fund(sender.userId, 20_000_00);
    const entryId = await transfer(sender, recipient);

    await raise(sender, { entry_id: entryId, reason: 'duplicate', detail: 'charged twice' })
      .expect(200);

    const again = await raise(sender, {
      entry_id: entryId,
      reason: 'wrong_amount',
      detail: 'and the amount is wrong too',
    }).expect(409);
    expect(again.body.error).toBe('dispute_already_open');
  });
});

describe('resolving one', () => {
  it('upholding it APPENDS a refund and credits the customer', async () => {
    const sender = await onboard();
    const recipient = await onboard();
    const reviewer = await makeReviewer();
    await fund(sender.userId, 20_000_00);

    const entryId = await transfer(sender, recipient);
    const afterTransfer = await spendable(sender);

    const raised = await raise(sender, {
      entry_id: entryId,
      reason: 'not_authorised',
      detail: 'somebody else did this',
    }).expect(200);

    const resolved = await request(app.getHttpServer())
      .post(`/v1/admin/disputes/${raised.body.id}/resolve`)
      .set('Authorization', `Bearer ${reviewer.token}`)
      .send({
        outcome: 'accepted',
        resolution: 'the device fingerprint was not the customer',
        refund_amount: '5000.00',
        idempotency_key: randomUUID(),
        transaction_pin: PIN,
      })
      .expect(200);

    expect(resolved.body.status).toBe('accepted');

    const after = await spendable(sender);
    expect(Number(after.replace(/,/g, ''))).toBeCloseTo(
      Number(afterTransfer.replace(/,/g, '')) + 5000,
      2,
    );

    // THE DISPUTED ENTRY IS UNTOUCHED. The refund is a separate entry, so the
    // original stays a true statement about what happened whatever we decided
    // about who should bear it.
    const original = await pool.query<{ kind: string }>(
      `SELECT kind::text AS kind FROM journal_entries WHERE uuid = $1::uuid`,
      [entryId],
    );
    expect(original.rows[0]?.kind).toBe('wallet_transfer');

    const refund = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM journal_entries WHERE kind = 'dispute_refund'`,
    );
    expect(Number(refund.rows[0]?.n)).toBeGreaterThan(0);
  });

  it('rejecting it moves NOTHING', async () => {
    const sender = await onboard();
    const recipient = await onboard();
    const reviewer = await makeReviewer();
    await fund(sender.userId, 20_000_00);

    const entryId = await transfer(sender, recipient);
    const before = await spendable(sender);

    const raised = await raise(sender, {
      entry_id: entryId,
      reason: 'not_received',
      detail: 'they say they never got it',
    }).expect(200);

    await request(app.getHttpServer())
      .post(`/v1/admin/disputes/${raised.body.id}/resolve`)
      .set('Authorization', `Bearer ${reviewer.token}`)
      .send({
        outcome: 'rejected',
        resolution: 'the recipient confirmed receipt',
        transaction_pin: PIN,
      })
      .expect(200);

    expect(await spendable(sender)).toBe(before);
  });

  it('cannot be resolved TWICE', async () => {
    // An outcome is final. Reopening an accepted dispute would let the refund
    // be paid a second time.
    const sender = await onboard();
    const recipient = await onboard();
    const reviewer = await makeReviewer();
    await fund(sender.userId, 20_000_00);
    const entryId = await transfer(sender, recipient);

    const raised = await raise(sender, {
      entry_id: entryId,
      reason: 'duplicate',
      detail: 'charged twice',
    }).expect(200);

    const resolve = (outcome: 'accepted' | 'rejected') =>
      request(app.getHttpServer())
        .post(`/v1/admin/disputes/${raised.body.id}/resolve`)
        .set('Authorization', `Bearer ${reviewer.token}`)
        .send({
          outcome,
          resolution: 'decided',
          transaction_pin: PIN,
          ...(outcome === 'accepted'
            ? { refund_amount: '5000.00', idempotency_key: randomUUID() }
            : {}),
        });

    await resolve('rejected').expect(200);
    await resolve('accepted').expect(404);
  });

  it('is refused to a customer who is not a dispute reviewer', async () => {
    // Under /v1/admin/, so `staff()` gates it — and route-coverage.test.ts
    // fails the build if it were ever declared with `authenticated()`.
    const sender = await onboard();
    const recipient = await onboard();
    const nosy = await onboard();
    await fund(sender.userId, 20_000_00);
    const entryId = await transfer(sender, recipient);

    const raised = await raise(sender, {
      entry_id: entryId,
      reason: 'not_authorised',
      detail: 'not mine',
    }).expect(200);

    await request(app.getHttpServer())
      .get('/v1/admin/disputes')
      .set('Authorization', `Bearer ${nosy.token}`)
      .expect(403);

    await request(app.getHttpServer())
      .post(`/v1/admin/disputes/${raised.body.id}/resolve`)
      .set('Authorization', `Bearer ${nosy.token}`)
      .send({ outcome: 'accepted', resolution: 'pay me', refund_amount: '5000.00',
              idempotency_key: randomUUID(), transaction_pin: PIN })
      .expect(403);
  });
});

describe('the customer own view', () => {
  it('lists only their own disputes', async () => {
    const sender = await onboard();
    const recipient = await onboard();
    const other = await onboard();
    await fund(sender.userId, 20_000_00);
    await fund(other.userId, 20_000_00);

    const mine = await transfer(sender, recipient);
    const theirs = await transfer(other, recipient);

    await raise(sender, { entry_id: mine, reason: 'duplicate', detail: 'mine' }).expect(200);
    await raise(other, { entry_id: theirs, reason: 'duplicate', detail: 'theirs' }).expect(200);

    const listed = await request(app.getHttpServer())
      .get('/v1/disputes')
      .set('Authorization', `Bearer ${sender.token}`)
      .expect(200);

    expect(listed.body).toHaveLength(1);
    expect(listed.body[0].entry_id).toBe(mine);
  });

  it('can withdraw one, which posts nothing', async () => {
    const sender = await onboard();
    const recipient = await onboard();
    await fund(sender.userId, 20_000_00);
    const entryId = await transfer(sender, recipient);
    const before = await spendable(sender);

    const raised = await raise(sender, {
      entry_id: entryId,
      reason: 'wrong_amount',
      detail: 'actually it is right',
    }).expect(200);

    const withdrawn = await request(app.getHttpServer())
      .post(`/v1/disputes/${raised.body.id}/withdraw`)
      .set('Authorization', `Bearer ${sender.token}`)
      .send({ resolution: 'I found the receipt' })
      .expect(200);

    expect(withdrawn.body.status).toBe('withdrawn');
    expect(await spendable(sender)).toBe(before);
  });
});
