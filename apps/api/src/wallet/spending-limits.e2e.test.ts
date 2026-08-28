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
import { ngn, usd } from '@xetral/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../app.module.js';
import { systemClock } from '../tokens.js';
import { testApiConfig } from '../test-support/api-config.js';
import { SettingsService } from '../settings/settings.service.js';
import { SpendingLimitService } from './spending-limits.service.js';

/**
 * The daily ceiling, against a real database.
 *
 * Every claim here is one that cannot be made against a mock: the limit is
 * computed from POSTINGS, so a test that stubbed the ledger would be asserting
 * about a number it had itself invented. And the replay case — the one that
 * would otherwise tell a customer they hit a limit for a transfer that
 * succeeded — depends on the ledger's real idempotency constraint.
 *
 * Requires DATABASE_URL with every migration and 009_admin.seed.sql applied.
 */
const DATABASE_URL = process.env['DATABASE_URL'];
if (DATABASE_URL === undefined || DATABASE_URL === '') {
  throw new Error('the spending-limit e2e suite needs DATABASE_URL with the migrations applied');
}

const PASSWORD = 'a-long-enough-password';
const PIN = '481902';

/** The lowest the schema allows: ₦1,000. The bound is a CHECK, so this suite
 *  cannot set a limit production could not. */
const LIMIT_KOBO = 100_000n;

let pool: Pool;
let ledger: LedgerService;
let app: INestApplication;
let settings: SettingsService;
let original: Map<string, string>;

interface Customer {
  identifier: string;
  userId: string;
  token: string;
}

async function onboard(): Promise<Customer> {
  const identifier = `limit-${randomUUID()}@example.ng`;

  const inserted = await pool.query<{ id: string }>(
    `INSERT INTO users (email, status) VALUES ($1, 'active') RETURNING id`,
    [identifier],
  );
  const userId = inserted.rows[0]?.id;
  if (userId === undefined) throw new Error('failed to seed user');

  await pool.query(`INSERT INTO user_credentials (user_id, password_hash) VALUES ($1, $2)`, [
    userId,
    await hashPassword(PASSWORD),
  ]);

  // VERIFIED, because this suite is about the FLOW limits and an unverified
  // customer's tier ceiling would be what refused instead — quietly turning
  // every assertion here into a test of something else. The dollar case below
  // is the one that showed it: tier 0 may move no dollars at all, so the
  // transfer was refused by a real USD limit rather than by the kobo one the
  // test exists to prove is not applied.
  await pool.query(`UPDATE users SET kyc_tier = 1 WHERE id = $1::bigint`, [userId]);

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

  return { identifier, userId, token };
}

async function fundNgn(userId: string, minor: number): Promise<void> {
  await ledger.post({
    idempotencyKey: `limit-fund:${randomUUID()}`,
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

async function fundUsd(userId: string, minor: number): Promise<void> {
  await ledger.post({
    idempotencyKey: `limit-fund-usd:${randomUUID()}`,
    kind: 'wallet_funding',
    occurredAt: new Date(),
    description: 'test funding',
    metadata: {},
    postings: [
      posting({ kind: 'customer_wallet', ownerId: userId, currency: 'USD' }, usd(minor)),
      posting({ kind: 'provider_float', currency: 'USD' }, usd(-minor)),
    ],
  });
}

const transfer = (from: Customer, body: Record<string, unknown>) =>
  request(app.getHttpServer())
    .post('/v1/wallets/transfers')
    .set('Authorization', `Bearer ${from.token}`)
    .send(body);

async function spendableNgn(customer: Customer): Promise<string> {
  const res = await request(app.getHttpServer())
    .get('/v1/wallets')
    .set('Authorization', `Bearer ${customer.token}`)
    .expect(200);
  const balances = res.body.balances as { currency: string; spendable: string }[];
  return balances.find((b) => b.currency === 'NGN')?.spendable ?? '0.00';
}

/**
 * Writes a setting and makes the running app see it.
 *
 * The refresh is required: the service caches for thirty seconds, which is
 * right in production and would have this suite assert against a stale number.
 */
async function setSetting(key: string, value: string): Promise<void> {
  await pool.query(`UPDATE platform_settings SET value = $1 WHERE key = $2`, [value, key]);
  await settings.refresh();
}

/**
 * Every setting this suite's assertions depend on, pinned rather than assumed.
 *
 * The fee is here because leaving it to the seed made these tests depend on
 * global state they do not own — and on a database shared with the invariant
 * suite, which deliberately changes the fee to prove the history trigger
 * fires, they read a fee somebody else set and failed with an arithmetic
 * error that said nothing about limits. A suite that asserts on exact balances
 * has to state the fee.
 */
const PINNED: Readonly<Record<string, string>> = {
  transfer_fee_basis_points: '0',
  transfer_daily_limit_kobo: LIMIT_KOBO.toString(),
};

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
  settings = app.get(SettingsService);

  const current = await pool.query<{ key: string; value: string }>(
    `SELECT key, value FROM platform_settings WHERE key = ANY($1::text[])`,
    [Object.keys(PINNED)],
  );
  if (current.rows.length !== Object.keys(PINNED).length) {
    throw new Error('009_admin.seed.sql has not been applied to this database');
  }
  original = new Map(current.rows.map((row) => [row.key, row.value]));

  for (const [key, value] of Object.entries(PINNED)) await setSetting(key, value);
});

afterAll(async () => {
  // Restore, or every suite that runs after this one against the same database
  // sends transfers against a ₦1,000 ceiling and fails for a reason that has
  // nothing to do with what it is testing.
  for (const [key, value] of original ?? []) await setSetting(key, value);
  await app?.close();
  await pool?.end();
});

describe('the daily transfer ceiling', () => {
  it('refuses a single transfer above it, and moves nothing', async () => {
    const alice = await onboard();
    const bob = await onboard();
    await fundNgn(alice.userId, 50_000_00);

    const res = await transfer(alice, {
      recipient: bob.identifier,
      amount: '1500.00',
      currency: 'NGN',
      transaction_pin: PIN,
      idempotency_key: `limit-over-${randomUUID()}`,
    });

    expect(res.status).toBe(422);
    expect(res.body.error).toBe('daily_limit_exceeded');

    // The refusal has to be BEFORE the posting, not a message after it.
    expect(await spendableNgn(alice)).toBe('50000.00');
  });

  it('carries no figure', async () => {
    const alice = await onboard();
    const bob = await onboard();
    await fundNgn(alice.userId, 50_000_00);

    const res = await transfer(alice, {
      recipient: bob.identifier,
      amount: '1200.00',
      currency: 'NGN',
      transaction_pin: PIN,
      idempotency_key: `limit-quiet-${randomUUID()}`,
    });

    expect(res.status).toBe(422);
    // Same reasoning as InsufficientFundsError: "₦412 of your ₦1,000 left
    // today" is a report on the customer's activity, and a stolen session must
    // not be able to farm one out of an error body.
    expect(Object.keys(res.body)).toEqual(['error']);
  });

  it('adds up across the day rather than checking each transfer alone', async () => {
    const alice = await onboard();
    const bob = await onboard();
    await fundNgn(alice.userId, 50_000_00);

    // Two transfers, each comfortably under the ₦1,000 ceiling, together over.
    const first = await transfer(alice, {
      recipient: bob.identifier,
      amount: '600.00',
      currency: 'NGN',
      transaction_pin: PIN,
      idempotency_key: `limit-sum-a-${randomUUID()}`,
    });
    expect(first.status).toBe(200);

    const second = await transfer(alice, {
      recipient: bob.identifier,
      amount: '600.00',
      currency: 'NGN',
      transaction_pin: PIN,
      idempotency_key: `limit-sum-b-${randomUUID()}`,
    });
    expect(second.status).toBe(422);
    expect(second.body.error).toBe('daily_limit_exceeded');

    expect(await spendableNgn(alice)).toBe('49400.00');
  });

  it('answers two overlapping transfers consistently', async () => {
    const alice = await onboard();
    const bob = await onboard();
    await fundNgn(alice.userId, 50_000_00);

    const [a, b] = await Promise.all([
      transfer(alice, {
        recipient: bob.identifier,
        amount: '700.00',
        currency: 'NGN',
        transaction_pin: PIN,
        idempotency_key: `limit-race-a-${randomUUID()}`,
      }),
      transfer(alice, {
        recipient: bob.identifier,
        amount: '700.00',
        currency: 'NGN',
        transaction_pin: PIN,
        idempotency_key: `limit-race-b-${randomUUID()}`,
      }),
    ]);

    // NOTE what this does and does not prove. Exactly one gets through, which
    // is the right answer — but it would be the right answer without the lock
    // too, because verifying a transaction PIN is a scrypt hash and scrypt is
    // deliberately slow and CPU-bound. Two requests through one Node process
    // queue behind each other on the event loop long before either reaches the
    // limit check, so this cannot race no matter how it is written.
    //
    // The lock is proved below, at the service, where nothing stands between
    // the two callers. Leaving this case here anyway is worth it: it is the
    // shape a customer actually produces by double-tapping Send.
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 422]);
    expect(await spendableNgn(alice)).toBe('49300.00');
  });

  it('still answers a retry of a transfer that already went through', async () => {
    const alice = await onboard();
    const bob = await onboard();
    await fundNgn(alice.userId, 50_000_00);

    const key = `limit-replay-${randomUUID()}`;
    const body = {
      recipient: bob.identifier,
      amount: '900.00',
      currency: 'NGN',
      transaction_pin: PIN,
      idempotency_key: key,
    };

    expect((await transfer(alice, body)).status).toBe(200);

    // The customer is now at ₦900 of ₦1,000. Their connection dropped and the
    // app retries. A naive check would compare 900 + 900 against 1,000 and
    // refuse — telling them they hit a limit for a transfer that succeeded,
    // which invites them to send it again tomorrow.
    const retry = await transfer(alice, body);
    expect(retry.status).toBe(200);
    expect(retry.body.replayed).toBe(true);

    // And exactly one transfer's worth of money moved.
    expect(await spendableNgn(alice)).toBe('49100.00');
  });

  it('does not apply a kobo ceiling to dollars', async () => {
    const alice = await onboard();
    const bob = await onboard();
    await fundUsd(alice.userId, 500_00);

    // The limit is published in kobo. $50 is 5,000 minor units, which would
    // sail past a ₦1,000 ceiling read as a bare integer — the same class of
    // mistake as adding kobo to cents, and the reason the guard names its
    // currency.
    //
    // The customer is verified, so their TIER allows dollars. Without that
    // this passes or fails on the tier ceiling and proves nothing about the
    // kobo one.
    const res = await transfer(alice, {
      recipient: bob.identifier,
      amount: '50.00',
      currency: 'USD',
      transaction_pin: PIN,
      idempotency_key: `limit-usd-${randomUUID()}`,
    });

    expect(res.status).toBe(200);
  });
});

/**
 * The race itself, with nothing in the way.
 *
 * Same reasoning as the Redis rate limiter's twenty-concurrent-attempts test:
 * the claim is about what happens when several callers read the same state
 * before any of them writes, and a test that cannot produce that overlap
 * cannot support the claim. Over HTTP the scrypt PIN check serialises the
 * requests for us; here the calls go straight at the service.
 *
 * Ten callers, each asking to spend a fifth of the ceiling. Without the lock
 * all ten read a total of zero, all ten find room, and the customer spends
 * twice the limit.
 */
describe('the lock under real concurrency', () => {
  it('lets exactly as many through as fit', async () => {
    const alice = await onboard();
    await fundNgn(alice.userId, 50_000_00);

    const limits = app.get(SpendingLimitService);
    const shareMinor = Number(LIMIT_KOBO) / 5; // ₦200 against a ₦1,000 ceiling

    const attempts = Array.from({ length: 10 }, async (_unused, index) => {
      const key = `limit-concurrent:${randomUUID()}:${index}`;
      const precondition = await limits.precondition({
        userId: alice.userId,
        scope: 'transfer',
        amount: ngn(shareMinor),
        idempotencyKey: key,
      });
      if (precondition === undefined) throw new Error('naira must be limited');

      try {
        // A REAL posting, because the limit is computed from postings. A
        // no-op body would leave the day's total at zero and every caller
        // would be allowed however the lock behaved.
        await ledger.post(
          {
            idempotencyKey: key,
            kind: 'wallet_transfer',
            occurredAt: new Date(),
            description: `concurrent ${index}`,
            metadata: {},
            postings: [
              posting(
                { kind: 'customer_wallet', ownerId: alice.userId, currency: 'NGN' },
                ngn(-shareMinor),
              ),
              posting({ kind: 'provider_float', currency: 'NGN' }, ngn(shareMinor)),
            ],
          },
          { precondition },
        );
        return 'allowed' as const;
      } catch {
        return 'refused' as const;
      }
    });

    const results = await Promise.all(attempts);
    expect(results.filter((r: string) => r === 'allowed')).toHaveLength(5);
    expect(results.filter((r: string) => r === 'refused')).toHaveLength(5);

    // And the ledger agrees: five times ₦200 left the wallet, not ten.
    expect(await spendableNgn(alice)).toBe('49000.00');
  });
});
