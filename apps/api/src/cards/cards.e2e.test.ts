import 'reflect-metadata';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { ExpressAdapter } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import pg from 'pg';
import type { Pool } from 'pg';
import { hashPassword } from '@xetral/identity';
import { LedgerService, posting } from '@xetral/ledger';
import type { AccountRef } from '@xetral/ledger';
import { BITNOB_EVENTS } from '@xetral/providers';
import type { CardPort, OperationOutcome, VirtualCard } from '@xetral/providers';
import { usd } from '@xetral/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from '../app.module.js';
import type { ApiConfig } from '../config.js';
import { systemClock } from '../tokens.js';

/**
 * Virtual USD cards end to end: issue, fund, freeze, terminate, and the
 * auth/settlement webhooks landing in the ledger.
 *
 * The CardPort is a stand-in rather than a live Bitnob — card issuing needs
 * their approval, and a suite that could only run against a real provider
 * account would not run at all. Everything on OUR side of the port is real:
 * the ledger entries, the overdraft guard, the signature check, the replay
 * constraint.
 */
const DATABASE_URL = process.env['DATABASE_URL'];
if (DATABASE_URL === undefined || DATABASE_URL === '') {
  throw new Error('the cards e2e suite needs DATABASE_URL with the migrations applied');
}

const PASSWORD = 'a-long-enough-password';
const PIN = '374915';
const WEBHOOK_SECRET = 'whsec_cards_e2e';
const key = { version: 'v1', secret: randomBytes(32) };

/** Records what the port was asked to do, and can be made to fail. */
class FakeCardPort implements CardPort {
  readonly calls: string[] = [];
  fundOutcome: OperationOutcome = { state: 'settled' };
  failNext: Error | undefined;

  #card(overrides: Partial<VirtualCard> = {}): VirtualCard {
    return {
      providerCardId: `bnc_${randomUUID()}`,
      status: 'active',
      last4: '4242',
      expiryMonth: 11,
      expiryYear: 2030,
      balance: usd(0),
      ...overrides,
    };
  }

  #maybeFail(): void {
    if (this.failNext !== undefined) {
      const error = this.failNext;
      this.failNext = undefined;
      throw error;
    }
  }

  lastIssued: VirtualCard | undefined;

  async issue(): Promise<VirtualCard> {
    this.calls.push('issue');
    this.#maybeFail();
    this.lastIssued = this.#card();
    return this.lastIssued;
  }
  async fund(): Promise<OperationOutcome> {
    this.calls.push('fund');
    this.#maybeFail();
    return this.fundOutcome;
  }
  async freeze(id: string): Promise<VirtualCard> {
    this.calls.push('freeze');
    this.#maybeFail();
    return this.#card({ providerCardId: id, status: 'frozen' });
  }
  async unfreeze(id: string): Promise<VirtualCard> {
    this.calls.push('unfreeze');
    this.#maybeFail();
    return this.#card({ providerCardId: id, status: 'active' });
  }
  async terminate(id: string): Promise<VirtualCard> {
    this.calls.push('terminate');
    this.#maybeFail();
    return this.#card({ providerCardId: id, status: 'terminated' });
  }
  async get(id: string): Promise<VirtualCard> {
    this.calls.push('get');
    return this.#card({ providerCardId: id });
  }
}

let pool: Pool;
let ledger: LedgerService;
let app: INestApplication;
let cardPort: FakeCardPort;

function makeConfig(): ApiConfig {
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
    bitnobWebhookSecret: WEBHOOK_SECRET,
  };
}

interface Customer {
  userId: string;
  token: string;
}

async function onboard(): Promise<Customer> {
  const identifier = `cards-${randomUUID()}@example.ng`;
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
  // The Bitnob customer mapping is a KYC step, so the service refuses to
  // create it silently. Seeded here as onboarding would.
  await pool.query(
    `INSERT INTO provider_customers (user_id, provider, provider_customer_id)
     VALUES ($1, 'bitnob', $2)`,
    [userId, `cus_${randomUUID()}`],
  );

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

  return { userId, token };
}

const wallet = (userId: string): AccountRef => ({
  kind: 'customer_wallet',
  ownerId: userId,
  currency: 'USD',
});
const cardAccount = (userId: string): AccountRef => ({
  kind: 'customer_card',
  ownerId: userId,
  currency: 'USD',
});
const pendingAccount = (userId: string): AccountRef => ({
  kind: 'customer_pending',
  ownerId: userId,
  currency: 'USD',
});

async function fundWallet(userId: string, minor: number): Promise<void> {
  await ledger.post({
    idempotencyKey: `cards-fund:${randomUUID()}`,
    kind: 'wallet_funding',
    occurredAt: new Date(),
    description: 'test funding',
    metadata: {},
    postings: [
      posting(wallet(userId), usd(minor)),
      posting({ kind: 'provider_float', currency: 'USD' }, usd(-minor)),
    ],
  });
}

const balance = async (ref: AccountRef): Promise<bigint> =>
  (await ledger.balanceOf(ref))?.balanceMinor ?? 0n;

async function issueCard(
  customer: Customer,
  initial = '25.00',
): Promise<{ id: string; providerCardId: string }> {
  const res = await request(app.getHttpServer())
    .post('/v1/cards')
    .set('Authorization', `Bearer ${customer.token}`)
    .send({
      name_on_card: 'Ada Obi',
      initial_funding: initial,
      transaction_pin: PIN,
      idempotency_key: randomUUID(),
    })
    .expect(201);

  const providerCardId = cardPort.lastIssued?.providerCardId;
  if (providerCardId === undefined) throw new Error('fake port did not record a card');
  return { id: res.body.id as string, providerCardId };
}

/** Signs and posts a Bitnob webhook exactly as the provider would. */
async function deliverWebhook(
  event: string,
  providerCardId: string,
  amountMicro: string,
  options: { signature?: string } = {},
): Promise<request.Response> {
  const raw = JSON.stringify({
    event_id: `evt_${randomUUID()}`,
    event,
    created_at: new Date().toISOString(),
    data: {
      id: `txn_${randomUUID()}`,
      card_id: providerCardId,
      customer_id: 'cus_x',
      amount: amountMicro,
      currency: 'USD',
      merchant: 'Netflix',
    },
  });

  return request(app.getHttpServer())
    .post('/v1/webhooks/bitnob')
    .set('content-type', 'application/json')
    .set(
      'x-bitnob-signature',
      options.signature ?? createHmac('sha256', WEBHOOK_SECRET).update(raw).digest('hex'),
    )
    .send(raw);
}

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: DATABASE_URL, max: 8 });
  ledger = new LedgerService(pool);
  cardPort = new FakeCardPort();

  const mod = await Test.createTestingModule({
    imports: [AppModule.forRoot({ config: makeConfig(), pool, clock: systemClock, cardPort })],
  }).compile();
  app = mod.createNestApplication(new ExpressAdapter(), { rawBody: true });
  await app.init();
});

beforeEach(() => {
  cardPort.calls.length = 0;
  cardPort.fundOutcome = { state: 'settled' };
  cardPort.failNext = undefined;
});

afterAll(async () => {
  await app?.close();
  await pool?.end();
});

describe('issuing', () => {
  it('moves the initial funding from the wallet onto the card', async () => {
    const customer = await onboard();
    await fundWallet(customer.userId, 100_00);

    const card = await issueCard(customer, '25.00');

    expect(card.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(await balance(wallet(customer.userId))).toBe(7500n);
    expect(await balance(cardAccount(customer.userId))).toBe(2500n);
  });

  it('refuses to fund a card the wallet cannot cover', async () => {
    const customer = await onboard();
    await fundWallet(customer.userId, 10_00);

    const res = await request(app.getHttpServer())
      .post('/v1/cards')
      .set('Authorization', `Bearer ${customer.token}`)
      .send({
        name_on_card: 'Ada Obi',
        initial_funding: '500.00',
        transaction_pin: PIN,
        idempotency_key: randomUUID(),
      });

    expect(res.status).toBe(422);
    expect(res.body.error).toBe('insufficient_funds');
  });

  it('requires a transaction PIN', async () => {
    const customer = await onboard();
    await fundWallet(customer.userId, 100_00);

    const res = await request(app.getHttpServer())
      .post('/v1/cards')
      .set('Authorization', `Bearer ${customer.token}`)
      .send({ name_on_card: 'Ada Obi', initial_funding: '10.00', idempotency_key: randomUUID() });

    expect(res.status).toBe(400);
    expect(cardPort.calls).toEqual([]);
  });

  it('refuses a customer with no provider identity', async () => {
    // Registering with Bitnob means sending identity documents. That is a KYC
    // step with its own consent, not a side effect of tapping "get a card".
    const identifier = `nokyc-${randomUUID()}@example.ng`;
    const inserted = await pool.query<{ id: string }>(
      `INSERT INTO users (email, status) VALUES ($1, 'active') RETURNING id`,
      [identifier],
    );
    const userId = inserted.rows[0]?.id;
    await pool.query(`INSERT INTO user_credentials (user_id, password_hash) VALUES ($1, $2)`, [
      userId,
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
    await request(app.getHttpServer())
      .post('/v1/auth/pin')
      .set('Authorization', `Bearer ${login.body.access_token}`)
      .send({ pin: PIN })
      .expect(204);

    const res = await request(app.getHttpServer())
      .post('/v1/cards')
      .set('Authorization', `Bearer ${login.body.access_token}`)
      .send({
        name_on_card: 'No KYC',
        initial_funding: '1.00',
        transaction_pin: PIN,
        idempotency_key: randomUUID(),
      });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('provider_customer_not_registered');
  });
});

describe('funding an existing card', () => {
  it('moves more money from the wallet onto the card', async () => {
    const customer = await onboard();
    await fundWallet(customer.userId, 100_00);
    const card = await issueCard(customer, '10.00');

    await request(app.getHttpServer())
      .post(`/v1/cards/${card.id}/fund`)
      .set('Authorization', `Bearer ${customer.token}`)
      .send({ amount: '15.00', transaction_pin: PIN, idempotency_key: randomUUID() })
      .expect(200);

    expect(await balance(cardAccount(customer.userId))).toBe(2500n);
    expect(await balance(wallet(customer.userId))).toBe(7500n);
  });

  it('does not treat a pending provider response as a failure', async () => {
    // Bitnob answers immediately with pending and settles later. The money has
    // left the wallet in our ledger either way; the top-up is what is pending.
    const customer = await onboard();
    await fundWallet(customer.userId, 100_00);
    const card = await issueCard(customer, '10.00');

    cardPort.fundOutcome = { state: 'pending', providerReference: 'txn_pending' };

    const res = await request(app.getHttpServer())
      .post(`/v1/cards/${card.id}/fund`)
      .set('Authorization', `Bearer ${customer.token}`)
      .send({ amount: '5.00', transaction_pin: PIN, idempotency_key: randomUUID() });

    expect(res.status).toBe(200);
    expect(await balance(cardAccount(customer.userId))).toBe(1500n);
  });

  it('is idempotent on a retry', async () => {
    const customer = await onboard();
    await fundWallet(customer.userId, 100_00);
    const card = await issueCard(customer, '10.00');

    const body = { amount: '5.00', transaction_pin: PIN, idempotency_key: randomUUID() };
    const send = () =>
      request(app.getHttpServer())
        .post(`/v1/cards/${card.id}/fund`)
        .set('Authorization', `Bearer ${customer.token}`)
        .send(body);

    await send().expect(200);
    await send().expect(200);

    // $10 + $5, not $10 + $5 + $5.
    expect(await balance(cardAccount(customer.userId))).toBe(1500n);
  });

  it('refuses another customer card', async () => {
    const owner = await onboard();
    const stranger = await onboard();
    await fundWallet(owner.userId, 100_00);
    const card = await issueCard(owner, '10.00');

    const res = await request(app.getHttpServer())
      .post(`/v1/cards/${card.id}/fund`)
      .set('Authorization', `Bearer ${stranger.token}`)
      .send({ amount: '5.00', transaction_pin: PIN, idempotency_key: randomUUID() });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('card_not_found');
  });
});

describe('freeze, unfreeze and terminate', () => {
  it('freezes without asking for a PIN', async () => {
    // The protective action has to be frictionless.
    const customer = await onboard();
    await fundWallet(customer.userId, 100_00);
    const card = await issueCard(customer, '10.00');

    const res = await request(app.getHttpServer())
      .post(`/v1/cards/${card.id}/freeze`)
      .set('Authorization', `Bearer ${customer.token}`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('frozen');
    expect(cardPort.calls).toContain('freeze');
  });

  it('requires a PIN to unfreeze', async () => {
    const customer = await onboard();
    await fundWallet(customer.userId, 100_00);
    const card = await issueCard(customer, '10.00');

    await request(app.getHttpServer())
      .post(`/v1/cards/${card.id}/freeze`)
      .set('Authorization', `Bearer ${customer.token}`)
      .send({})
      .expect(200);

    const noPin = await request(app.getHttpServer())
      .post(`/v1/cards/${card.id}/unfreeze`)
      .set('Authorization', `Bearer ${customer.token}`)
      .send({});
    expect(noPin.status).toBe(400);

    const withPin = await request(app.getHttpServer())
      .post(`/v1/cards/${card.id}/unfreeze`)
      .set('Authorization', `Bearer ${customer.token}`)
      .send({ transaction_pin: PIN });
    expect(withPin.status).toBe(200);
    expect(withPin.body.status).toBe('active');
  });

  it('returns the remaining balance to the wallet on termination', async () => {
    const customer = await onboard();
    await fundWallet(customer.userId, 100_00);
    const card = await issueCard(customer, '25.00');

    expect(await balance(wallet(customer.userId))).toBe(7500n);

    const res = await request(app.getHttpServer())
      .post(`/v1/cards/${card.id}/terminate`)
      .set('Authorization', `Bearer ${customer.token}`)
      .send({ transaction_pin: PIN })
      .expect(200);

    expect(res.body.status).toBe('terminated');
    expect(await balance(cardAccount(customer.userId))).toBe(0n);
    expect(await balance(wallet(customer.userId))).toBe(10000n);
  });

  it('refuses to fund a terminated card', async () => {
    const customer = await onboard();
    await fundWallet(customer.userId, 100_00);
    const card = await issueCard(customer, '10.00');

    await request(app.getHttpServer())
      .post(`/v1/cards/${card.id}/terminate`)
      .set('Authorization', `Bearer ${customer.token}`)
      .send({ transaction_pin: PIN })
      .expect(200);

    const res = await request(app.getHttpServer())
      .post(`/v1/cards/${card.id}/fund`)
      .set('Authorization', `Bearer ${customer.token}`)
      .send({ amount: '5.00', transaction_pin: PIN, idempotency_key: randomUUID() });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('card_terminated');
  });
});

describe('the auth/settlement webhooks', () => {
  it('an authorization holds the card balance, not the wallet', async () => {
    const customer = await onboard();
    await fundWallet(customer.userId, 100_00);
    const card = await issueCard(customer, '25.00');

    const walletBefore = await balance(wallet(customer.userId));

    const res = await deliverWebhook(
      BITNOB_EVENTS.cardAuthorization,
      card.providerCardId,
      '10000000',
    );

    expect(res.status).toBe(200);
    expect(res.body.entry_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(await balance(cardAccount(customer.userId))).toBe(1500n);
    expect(await balance(pendingAccount(customer.userId))).toBe(1000n);
    // The wallet is untouched: a card spends what it holds.
    expect(await balance(wallet(customer.userId))).toBe(walletBefore);
  });

  it('a settlement turns the hold into a real spend', async () => {
    const customer = await onboard();
    await fundWallet(customer.userId, 100_00);
    const card = await issueCard(customer, '25.00');

    await deliverWebhook(BITNOB_EVENTS.cardAuthorization, card.providerCardId, '10000000');
    await deliverWebhook(BITNOB_EVENTS.cardSettlement, card.providerCardId, '10000000');

    expect(await balance(pendingAccount(customer.userId))).toBe(0n);
    expect(await balance(cardAccount(customer.userId))).toBe(1500n);
  });

  it('an expiry returns the hold to the card', async () => {
    const customer = await onboard();
    await fundWallet(customer.userId, 100_00);
    const card = await issueCard(customer, '25.00');

    await deliverWebhook(BITNOB_EVENTS.cardAuthorization, card.providerCardId, '10000000');
    await deliverWebhook(
      BITNOB_EVENTS.cardAuthorizationExpired,
      card.providerCardId,
      '10000000',
    );

    expect(await balance(pendingAccount(customer.userId))).toBe(0n);
    expect(await balance(cardAccount(customer.userId))).toBe(2500n);
  });

  it('cannot authorise more than the card holds', async () => {
    // The overdraft guard covers customer_card, so this needs no new rule --
    // only the right account on the posting.
    const customer = await onboard();
    await fundWallet(customer.userId, 100_00);
    const card = await issueCard(customer, '10.00');

    const res = await deliverWebhook(
      BITNOB_EVENTS.cardAuthorization,
      card.providerCardId,
      '50000000',
    );

    expect(res.status).toBe(500);
    expect(await balance(cardAccount(customer.userId))).toBe(1000n);
  });

  it('rejects a webhook with a bad signature, and posts nothing', async () => {
    const customer = await onboard();
    await fundWallet(customer.userId, 100_00);
    const card = await issueCard(customer, '25.00');

    const res = await deliverWebhook(
      BITNOB_EVENTS.cardAuthorization,
      card.providerCardId,
      '10000000',
      { signature: 'deadbeef' },
    );

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('invalid_signature');
    expect(await balance(cardAccount(customer.userId))).toBe(2500n);
  });

  it('needs no bearer token: the signature is the authentication', async () => {
    const customer = await onboard();
    await fundWallet(customer.userId, 100_00);
    const card = await issueCard(customer, '25.00');

    const res = await deliverWebhook(
      BITNOB_EVENTS.cardAuthorization,
      card.providerCardId,
      '1000000',
    );
    expect(res.status).toBe(200);
  });

  it('acknowledges an event for a card we never issued', async () => {
    // Nothing we can do with it. A permanent failure that keeps being
    // redelivered buries the events that matter.
    const res = await deliverWebhook(
      BITNOB_EVENTS.cardAuthorization,
      `bnc_unknown_${randomUUID()}`,
      '1000000',
    );
    expect(res.status).toBe(200);
    expect(res.body.entry_id).toBeUndefined();
  });

  it('posts one entry for a redelivered webhook', async () => {
    const customer = await onboard();
    await fundWallet(customer.userId, 100_00);
    const card = await issueCard(customer, '25.00');

    const raw = JSON.stringify({
      event_id: `evt_${randomUUID()}`,
      event: BITNOB_EVENTS.cardAuthorization,
      created_at: new Date().toISOString(),
      data: {
        id: 'txn_replay',
        card_id: card.providerCardId,
        customer_id: 'cus_x',
        amount: '5000000',
        currency: 'USD',
      },
    });
    const signature = createHmac('sha256', WEBHOOK_SECRET).update(raw).digest('hex');

    const send = () =>
      request(app.getHttpServer())
        .post('/v1/webhooks/bitnob')
        .set('content-type', 'application/json')
        .set('x-bitnob-signature', signature)
        .send(raw);

    const first = await send().expect(200);
    const second = await send().expect(200);

    expect(second.body.entry_id).toBe(first.body.entry_id);
    expect(second.body.replayed).toBe(true);
    // $25 - $5 once, not twice.
    expect(await balance(cardAccount(customer.userId))).toBe(2000n);
  });

  it('leaves no drift behind', async () => {
    const drift = await pool.query(`SELECT COUNT(*)::int AS n FROM ledger_drift`);
    expect(drift.rows[0]?.n).toBe(0);
  });
});
