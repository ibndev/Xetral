import 'reflect-metadata';
import { randomBytes, randomUUID } from 'node:crypto';
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
import type { ApiConfig } from '../config.js';
import { systemClock } from '../tokens.js';

/**
 * The first real money flow, end to end over HTTP: sign in, set a PIN, read a
 * balance, move money, read the history.
 *
 * Against a real PostgreSQL, because everything that makes this safe — the
 * overdraft guard, the replay constraint, the PIN lockout — is enforced there.
 *
 * Requires DATABASE_URL with 001_ledger.sql and 002_identity.sql applied.
 */
const DATABASE_URL = process.env['DATABASE_URL'];
if (DATABASE_URL === undefined || DATABASE_URL === '') {
  throw new Error('the wallet e2e suite needs DATABASE_URL with the migrations applied');
}

const PASSWORD = 'a-long-enough-password';
const PIN = '374915';
const key = { version: 'v1', secret: randomBytes(32) };

function makeConfig(overrides: Partial<ApiConfig> = {}): ApiConfig {
  return {
    databaseUrl: DATABASE_URL as string,
    accessTokenKeyring: { current: key, accepted: [key] },
    accessTokenTtlSeconds: 900,
    refreshTokenTtlSeconds: 2_592_000,
    loginRateLimit: {
      perIdentifier: { max: 1000, windowSeconds: 900 },
      perIp: { max: 1000, windowSeconds: 900 },
    },
    trustProxyHops: 0,
    redisUrl: undefined,
    transferFeeBasisPoints: 0,
    bitnobBaseUrl: undefined,
    bitnobApiKey: undefined,
    bitnobWebhookSecret: undefined,
    ...overrides,
  };
}

let pool: Pool;
let ledger: LedgerService;
let app: INestApplication;

async function createApp(config: ApiConfig): Promise<INestApplication> {
  const mod = await Test.createTestingModule({
    imports: [AppModule.forRoot({ config, pool, clock: systemClock })],
  }).compile();
  const created = mod.createNestApplication(new ExpressAdapter());
  await created.init();
  return created;
}

interface Customer {
  identifier: string;
  userId: string;
  token: string;
}

/** Registers a customer, signs them in, and sets a transaction PIN. */
async function onboard(instance: INestApplication = app): Promise<Customer> {
  const identifier = `wallet-${randomUUID()}@example.ng`;

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

  const login = await request(instance.getHttpServer())
    .post('/v1/auth/login')
    .send({
      identifier,
      password: PASSWORD,
      device: { fingerprint: `fp-${randomUUID()}`, platform: 'ios' },
    })
    .expect(200);

  const token = login.body.access_token as string;

  await request(instance.getHttpServer())
    .post('/v1/auth/pin')
    .set('Authorization', `Bearer ${token}`)
    .send({ pin: PIN })
    .expect(204);

  return { identifier, userId, token };
}

/** Credits a wallet directly through the ledger.
 *
 *  Customer-facing NGN funding needs a bank rail, and none of the four live
 *  providers offers one — see PHASES.md. This stands in for that webhook so the
 *  rest of the flow can be exercised today. */
async function fund(userId: string, minor: number): Promise<void> {
  await ledger.post({
    idempotencyKey: `test-fund:${randomUUID()}`,
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

const transfer = (
  from: Customer,
  body: Record<string, unknown>,
  instance: INestApplication = app,
) =>
  request(instance.getHttpServer())
    .post('/v1/wallets/transfers')
    .set('Authorization', `Bearer ${from.token}`)
    .send(body);

const balancesOf = async (customer: Customer, instance: INestApplication = app) =>
  (
    await request(instance.getHttpServer())
      .get('/v1/wallets')
      .set('Authorization', `Bearer ${customer.token}`)
      .expect(200)
  ).body.balances as { currency: string; spendable: string; total: string }[];

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: DATABASE_URL, max: 8 });
  ledger = new LedgerService(pool);
  app = await createApp(makeConfig());
});

afterAll(async () => {
  await app?.close();
  await pool?.end();
});

describe('balances', () => {
  it('starts empty and reflects funding', async () => {
    const customer = await onboard();
    expect(await balancesOf(customer)).toEqual([]);

    await fund(customer.userId, 20_000_00);

    const balances = await balancesOf(customer);
    expect(balances).toHaveLength(1);
    expect(balances[0]).toMatchObject({
      currency: 'NGN',
      spendable: '20000.00',
      pending: '0.00',
      total: '20000.00',
    });
  });

  it('needs a token', async () => {
    const res = await request(app.getHttpServer()).get('/v1/wallets');
    expect(res.status).toBe(401);
  });
});

describe('transfers', () => {
  it('moves money between customers', async () => {
    const alice = await onboard();
    const bob = await onboard();
    await fund(alice.userId, 10_000_00);

    const res = await transfer(alice, {
      recipient: bob.identifier,
      amount: '2500.50',
      currency: 'NGN',
      transaction_pin: PIN,
      idempotency_key: randomUUID(),
    });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ amount: '2500.50', fee: '0.00', currency: 'NGN' });

    expect((await balancesOf(alice))[0]?.spendable).toBe('7499.50');
    expect((await balancesOf(bob))[0]?.spendable).toBe('2500.50');
  });

  it('refuses without a transaction PIN', async () => {
    // The route declares pin: true. Until Phase 4 that made it refuse to serve
    // at all; now it refuses the request that omits the PIN.
    const alice = await onboard();
    await fund(alice.userId, 1_000_00);

    const res = await transfer(alice, {
      recipient: alice.identifier,
      amount: '10.00',
      currency: 'NGN',
      idempotency_key: randomUUID(),
    });

    expect(res.status).toBe(400);
    expect(['invalid_request', 'transaction_pin_required']).toContain(res.body.error);
  });

  it('refuses a wrong PIN and counts the attempt', async () => {
    const alice = await onboard();
    const bob = await onboard();
    await fund(alice.userId, 1_000_00);

    const res = await transfer(alice, {
      recipient: bob.identifier,
      amount: '10.00',
      currency: 'NGN',
      transaction_pin: '999999',
      idempotency_key: randomUUID(),
    });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('invalid_pin');
    expect(res.body.attempts_remaining).toBe(4);

    // And nothing moved.
    expect((await balancesOf(alice))[0]?.spendable).toBe('1000.00');
  });

  it('locks the PIN after five failures and refuses even the right one', async () => {
    const alice = await onboard();
    const bob = await onboard();
    await fund(alice.userId, 1_000_00);

    const attempt = (pin: string) =>
      transfer(alice, {
        recipient: bob.identifier,
        amount: '10.00',
        currency: 'NGN',
        transaction_pin: pin,
        idempotency_key: randomUUID(),
      });

    for (let i = 0; i < 4; i++) expect((await attempt('999999')).status).toBe(401);

    const fifth = await attempt('999999');
    expect(fifth.status).toBe(423);
    expect(fifth.body.error).toBe('pin_locked');

    // A correct PIN during a lockout must not lift it.
    const correct = await attempt(PIN);
    expect(correct.status).toBe(423);
  });

  it('refuses an overdraft without revealing the balance', async () => {
    const alice = await onboard();
    const bob = await onboard();
    await fund(alice.userId, 100_00);

    const res = await transfer(alice, {
      recipient: bob.identifier,
      amount: '5000.00',
      currency: 'NGN',
      transaction_pin: PIN,
      idempotency_key: randomUUID(),
    });

    expect(res.status).toBe(422);
    expect(res.body.error).toBe('insufficient_funds');
    expect(JSON.stringify(res.body)).not.toContain('100');
  });

  it('is idempotent: a retried transfer moves money once', async () => {
    // The client cannot tell a lost response from a lost request, so it retries.
    // The key is what stops that from being a second transfer.
    const alice = await onboard();
    const bob = await onboard();
    await fund(alice.userId, 10_000_00);

    const body = {
      recipient: bob.identifier,
      amount: '1000.00',
      currency: 'NGN',
      transaction_pin: PIN,
      idempotency_key: randomUUID(),
    };

    const first = await transfer(alice, body);
    expect(first.status).toBe(200);
    expect(first.body.replayed).toBe(false);

    const retry = await transfer(alice, body);
    expect(retry.status).toBe(200);
    expect(retry.body.replayed).toBe(true);
    expect(retry.body.entry_id).toBe(first.body.entry_id);

    expect((await balancesOf(alice))[0]?.spendable).toBe('9000.00');
    expect((await balancesOf(bob))[0]?.spendable).toBe('1000.00');
  });

  it('charges a fee when one is configured', async () => {
    const withFee = await createApp(makeConfig({ transferFeeBasisPoints: 150 }));
    try {
      const alice = await onboard(withFee);
      const bob = await onboard(withFee);
      await fund(alice.userId, 10_000_00);

      const res = await transfer(
        alice,
        {
          recipient: bob.identifier,
          amount: '1000.00',
          currency: 'NGN',
          transaction_pin: PIN,
          idempotency_key: randomUUID(),
        },
        withFee,
      );

      // 1.5% of N1,000 is N15.00. The recipient receives the full amount; the
      // sender pays amount + fee.
      expect(res.status).toBe(200);
      expect(res.body.fee).toBe('15.00');
      expect((await balancesOf(alice, withFee))[0]?.spendable).toBe('8985.00');
      expect((await balancesOf(bob, withFee))[0]?.spendable).toBe('1000.00');
    } finally {
      await withFee.close();
    }
  });

  it('refuses a transfer to yourself', async () => {
    const alice = await onboard();
    await fund(alice.userId, 1_000_00);

    const res = await transfer(alice, {
      recipient: alice.identifier,
      amount: '10.00',
      currency: 'NGN',
      transaction_pin: PIN,
      idempotency_key: randomUUID(),
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('cannot_transfer_to_self');
  });

  it('answers an unknown recipient without confirming who exists', async () => {
    const alice = await onboard();
    await fund(alice.userId, 1_000_00);

    const res = await transfer(alice, {
      recipient: `nobody-${randomUUID()}@example.ng`,
      amount: '10.00',
      currency: 'NGN',
      transaction_pin: PIN,
      idempotency_key: randomUUID(),
    });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('recipient_not_found');
  });

  it('refuses a frozen account at the point of the action', async () => {
    // The access token stays valid until it expires -- freezing has to bite
    // before the money moves, not at the next refresh.
    const alice = await onboard();
    const bob = await onboard();
    await fund(alice.userId, 1_000_00);
    await pool.query(`UPDATE users SET status = 'frozen' WHERE id = $1`, [alice.userId]);

    const res = await transfer(alice, {
      recipient: bob.identifier,
      amount: '10.00',
      currency: 'NGN',
      transaction_pin: PIN,
      idempotency_key: randomUUID(),
    });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('account_not_active');
  });

  it('rejects an amount with more precision than the currency has', async () => {
    // Truncating "10.005" to 10.00 is how a customer is charged something other
    // than what they typed.
    const alice = await onboard();
    const bob = await onboard();
    await fund(alice.userId, 1_000_00);

    const res = await transfer(alice, {
      recipient: bob.identifier,
      amount: '10.005',
      currency: 'NGN',
      transaction_pin: PIN,
      idempotency_key: randomUUID(),
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_amount');
  });

  it('rejects a zero or negative amount', async () => {
    const alice = await onboard();
    const bob = await onboard();
    await fund(alice.userId, 1_000_00);

    for (const amount of ['0.00', '-10.00']) {
      const res = await transfer(alice, {
        recipient: bob.identifier,
        amount,
        currency: 'NGN',
        transaction_pin: PIN,
        idempotency_key: randomUUID(),
      });
      expect(res.status).toBe(400);
    }
  });
});

describe('history', () => {
  it('shows only the customer own leg, newest first', async () => {
    const alice = await onboard();
    const bob = await onboard();
    await fund(alice.userId, 10_000_00);

    for (const amount of ['100.00', '200.00', '300.00']) {
      await transfer(alice, {
        recipient: bob.identifier,
        amount,
        currency: 'NGN',
        transaction_pin: PIN,
        idempotency_key: randomUUID(),
      }).expect(200);
    }

    const res = await request(app.getHttpServer())
      .get('/v1/wallets/transactions?currency=NGN&limit=3')
      .set('Authorization', `Bearer ${alice.token}`)
      .expect(200);

    const amounts = (res.body.entries as { amount: string }[]).map((e) => e.amount);
    expect(amounts).toEqual(['-300.00', '-200.00', '-100.00']);

    // Bob sees the positive side of the same transfers, and nothing of Alice's.
    const bobHistory = await request(app.getHttpServer())
      .get('/v1/wallets/transactions?currency=NGN')
      .set('Authorization', `Bearer ${bob.token}`)
      .expect(200);
    expect(
      (bobHistory.body.entries as { amount: string }[]).every((e) => !e.amount.startsWith('-')),
    ).toBe(true);
  });

  it('paginates with a cursor rather than an offset', async () => {
    const alice = await onboard();
    const bob = await onboard();
    await fund(alice.userId, 10_000_00);

    for (let i = 0; i < 4; i++) {
      await transfer(alice, {
        recipient: bob.identifier,
        amount: '10.00',
        currency: 'NGN',
        transaction_pin: PIN,
        idempotency_key: randomUUID(),
      }).expect(200);
    }

    const first = await request(app.getHttpServer())
      .get('/v1/wallets/transactions?currency=NGN&limit=2')
      .set('Authorization', `Bearer ${alice.token}`)
      .expect(200);

    expect(first.body.entries).toHaveLength(2);
    expect(first.body.next_cursor).not.toBeNull();

    const second = await request(app.getHttpServer())
      .get(`/v1/wallets/transactions?currency=NGN&limit=2&before=${first.body.next_cursor}`)
      .set('Authorization', `Bearer ${alice.token}`)
      .expect(200);

    const firstIds = (first.body.entries as { id: string }[]).map((e) => e.id);
    const secondIds = (second.body.entries as { id: string }[]).map((e) => e.id);
    expect(secondIds.some((id) => firstIds.includes(id))).toBe(false);
  });
});
