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
import type {
  CardPort,
  CardSecrets,
  IssueCardRequest,
  OperationOutcome,
  VirtualCard,
} from '@xetral/providers';
import { usd } from '@xetral/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from '../app.module.js';
import type { ApiConfig } from '../config.js';
import { systemClock } from '../tokens.js';
import { testApiConfig } from '../test-support/api-config.js';
import { enrolAndElevate } from '../test-support/staff-totp.js';
import { approveKyc } from '../test-support/kyc-fixture.js';

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
  /** WHAT WAS ASKED FOR, not just what came back. The name on a card is not in
   *  the response — it is in the request — so a test asserting the customer's
   *  verified name reached Bitnob has to read this side. */
  lastIssueRequest: IssueCardRequest | undefined;

  async issue(request: IssueCardRequest): Promise<VirtualCard> {
    this.calls.push('issue');
    this.lastIssueRequest = request;
    this.#maybeFail();
    this.lastIssued = this.#card();
    return this.lastIssued;
  }
  async fund(): Promise<OperationOutcome> {
    this.calls.push('fund');
    this.#maybeFail();
    return this.fundOutcome;
  }
  async reveal(): Promise<CardSecrets> {
    this.calls.push('reveal');
    this.#maybeFail();
    return {
      pan: '4242424242424242',
      cvv: '123',
      expiryMonth: 11,
      expiryYear: 2030,
      nameOnCard: 'A Customer',
    };
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
  return testApiConfig(DATABASE_URL as string, {
    bitnobWebhookSecret: WEBHOOK_SECRET,
  });
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
  // Verified, in the ONE place that knows what approval actually writes: an
  // approved `kyc_submissions` row (which is where a card's embossed name is
  // read from), the provider mapping, and the tier — all three, because
  // approval writes all three in one transaction.
  await approveKyc(pool, userId);

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

/**
 * Buying a card, then loading it — TWO REQUESTS, because they are two
 * decisions.
 *
 * Issuing used to take a starting balance and this helper passed one. It does
 * not any more: `POST /v1/cards` buys the card (and charges the issuance fee),
 * and `POST /v1/cards/:id/fund` puts money on it, which is what the customer
 * does from the card screen the moment the card exists.
 */
async function issueCard(
  customer: Customer,
  initial = '25.00',
): Promise<{ id: string; providerCardId: string }> {
  const res = await request(app.getHttpServer())
    .post('/v1/cards')
    .set('Authorization', `Bearer ${customer.token}`)
    .send({ transaction_pin: PIN, idempotency_key: randomUUID() })
    .expect(201);

  const providerCardId = cardPort.lastIssued?.providerCardId;
  if (providerCardId === undefined) throw new Error('fake port did not record a card');
  const id = res.body.id as string;

  if (initial !== '0.00') {
    await request(app.getHttpServer())
      .post(`/v1/cards/${id}/fund`)
      .set('Authorization', `Bearer ${customer.token}`)
      .send({ amount: initial, transaction_pin: PIN, idempotency_key: randomUUID() })
      .expect(200);
  }

  return { id, providerCardId };
}

/** Signs and posts a Bitnob webhook exactly as the provider would. */
async function deliverWebhook(
  event: string,
  providerCardId: string,
  amountMicro: string,
  options: {
    signature?: string;
    /** The provider's id for THIS transaction. Passed when a later event has
     *  to name it — a settlement carries the authorization's id, which is how
     *  the two halves of one card spend are connected. */
    txnId?: string;
    /** The authorization this event resolves. */
    authorizationId?: string;
  } = {},
): Promise<request.Response> {
  const raw = JSON.stringify({
    event_id: `evt_${randomUUID()}`,
    event,
    created_at: new Date().toISOString(),
    data: {
      id: options.txnId ?? `txn_${randomUUID()}`,
      card_id: providerCardId,
      customer_id: 'cus_x',
      amount: amountMicro,
      currency: 'USD',
      merchant: 'Netflix',
      ...(options.authorizationId === undefined
        ? {}
        : { authorization_id: options.authorizationId }),
    },
  });

  return request(app.getHttpServer())
    .post('/v1/webhooks/bitnob')
    .set('content-type', 'application/json')
    .set(
      'x-bitnob-signature',
      options.signature ?? createHmac('sha512', WEBHOOK_SECRET).update(raw).digest('hex'),
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
  it('charges the price, then moves what the customer loads onto the card', async () => {
    const customer = await onboard();
    await fundWallet(customer.userId, 100_00);

    const card = await issueCard(customer, '25.00');

    expect(card.id).toMatch(/^[0-9a-f-]{36}$/);
    // $100 − $2.00 price − $25.00 loaded. The price is the new figure here: it
    // used to be $100 − $25.00, because nothing charged for issuance and the
    // screen's "$5.00 one-time payment" was a starting balance in a price's
    // clothes.
    expect(await balance(wallet(customer.userId))).toBe(7300n);
    expect(await balance(cardAccount(customer.userId))).toBe(2500n);
  });

  it('books the price as a card_creation entry, and the tax as a LIABILITY', async () => {
    /*
     * TAX IS NOT REVENUE. Part of a fee charged by a Nigerian company is VAT,
     * which is owed onward — booking all of it as revenue overstates what the
     * business earned and understates what it owes, both errors pointing the
     * flattering way. The split is INCLUSIVE, so the customer pays exactly the
     * advertised $2.00 either way.
     */
    const customer = await onboard();
    await fundWallet(customer.userId, 100_00);

    const before = {
      fees: await balance({ kind: 'revenue_fees', currency: 'USD' }),
      tax: await balance({ kind: 'liability_tax_payable', currency: 'USD' }),
    };

    await issueCard(customer, '0.00');

    const legs = await pool.query<{ kind: string; amount: string; currency: string }>(
      `SELECT a.kind::text AS kind, p.amount_minor::text AS amount, p.currency
         FROM postings p
         JOIN journal_entries e ON e.id = p.journal_entry_id
         JOIN accounts a        ON a.id = p.account_id
        WHERE e.kind = 'card_creation'
          AND e.idempotency_key LIKE 'card-issue-fee:%'
          AND (a.owner_id = $1::bigint OR a.owner_id IS NULL)
        ORDER BY p.amount_minor`,
      [customer.userId],
    );
    // Three legs in one currency: the customer pays 200, we keep part and owe
    // the rest. `card_creation` has been in `entry_kind` since 001 and this is
    // the first thing ever to post one.
    expect(legs.rows.map((r) => r.kind)).toContain('customer_wallet');
    expect(legs.rows.every((r) => r.currency === 'USD')).toBe(true);
    expect(legs.rows.find((r) => r.kind === 'customer_wallet')?.amount).toBe('-200');

    const after = {
      fees: await balance({ kind: 'revenue_fees', currency: 'USD' }),
      tax: await balance({ kind: 'liability_tax_payable', currency: 'USD' }),
    };
    // What we KEEP and what we OWE, together, are exactly what the customer
    // paid. Netting them into one number would hide both.
    expect(after.fees - before.fees + (after.tax - before.tax)).toBe(200n);
    expect(after.tax).toBeGreaterThan(before.tax);
  });

  it('tells the customer the price on the same request as the list', async () => {
    // One source. A figure carried in the screen would show the old price from
    // the moment an operator changed the setting.
    const customer = await onboard();
    const res = await request(app.getHttpServer())
      .get('/v1/cards')
      .set('Authorization', `Bearer ${customer.token}`)
      .expect(200);

    expect(res.body.issuance_fee).toBe('2.00');
  });

  it('asks Bitnob for a card in the customer VERIFIED name, never one they typed', async () => {
    /*
     * A card is issued in a person's legal name, which lives in
     * `kyc_submissions.full_name` — read off a document by a reviewer.
     * `users.full_name` is what somebody typed about themselves, and a
     * free-text box on the form let the two disagree on the one screen where
     * they must match.
     */
    const customer = await onboard();
    await fundWallet(customer.userId, 100_00);
    await pool.query(`UPDATE users SET full_name = 'Not This Name' WHERE id = $1::bigint`, [
      customer.userId,
    ]);

    await issueCard(customer, '0.00');

    expect(cardPort.lastIssueRequest?.nameOnCard).toBe('Ada Obi');
    // AND NOTHING GOES ON IT AT ISSUE. Loading is the second decision.
    expect(cardPort.lastIssueRequest?.initialFunding.amount).toBe(0n);
  });

  it('refuses to sell a card to a wallet that cannot pay for it', async () => {
    /*
     * THE PRICE IS CHARGED BEFORE BITNOB IS ASKED FOR ANYTHING, so the
     * overdraft guard is what decides — not a pre-check, which is a second,
     * weaker copy of the rule plus a race.
     *
     * This suite used to prove the same thing about the STARTING BALANCE,
     * which issuing no longer takes. The claim worth keeping is that a
     * customer who cannot afford the transaction does not get a card, and it
     * is now the fee that says so.
     */
    const customer = await onboard();
    // Nothing at all. Every other customer here is funded first.

    const res = await request(app.getHttpServer())
      .post('/v1/cards')
      .set('Authorization', `Bearer ${customer.token}`)
      .send({ transaction_pin: PIN, idempotency_key: randomUUID() });

    expect(res.status).toBe(422);
    expect(res.body.error).toBe('insufficient_funds');
    // AND NOTHING WAS SENT. A card requested from the provider on money that
    // turns out not to be there is a card the customer holds and has not paid
    // for.
    expect(cardPort.calls).toEqual([]);
  });

  it('requires a transaction PIN', async () => {
    const customer = await onboard();
    await fundWallet(customer.userId, 100_00);

    const res = await request(app.getHttpServer())
      .post('/v1/cards')
      .set('Authorization', `Bearer ${customer.token}`)
      .send({ idempotency_key: randomUUID() });

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
      .send({ transaction_pin: PIN, idempotency_key: randomUUID() });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('kyc_required');
    // Names what the customer was reaching for, so the screen can say
    // "verify to get a USD card" rather than a bare "kyc required".
    expect(res.body.product).toBe('card');
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
    // $100 − $2.00 price − $10.00 − $15.00. The price is the term that is new:
    // issuing a card now charges one.
    expect(await balance(wallet(customer.userId))).toBe(7300n);
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

    // $100 − $2.00 price − $25.00 loaded.
    expect(await balance(wallet(customer.userId))).toBe(7300n);

    const res = await request(app.getHttpServer())
      .post(`/v1/cards/${card.id}/terminate`)
      .set('Authorization', `Bearer ${customer.token}`)
      .send({ transaction_pin: PIN })
      .expect(200);

    expect(res.body.status).toBe('terminated');
    expect(await balance(cardAccount(customer.userId))).toBe(0n);
    // What was ON the card comes back. THE PRICE DOES NOT — it was paid for a
    // card that was issued and used, and refunding it on termination would
    // make the card free to anybody who opened and closed one.
    expect(await balance(wallet(customer.userId))).toBe(9800n);
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
    const signature = createHmac('sha512', WEBHOOK_SECRET).update(raw).digest('hex');

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

describe('revealing a card', () => {
  const reveal = (customer: Customer, cardId: string, body: Record<string, unknown> = {}) =>
    request(app.getHttpServer())
      .post(`/v1/cards/${cardId}/reveal`)
      .set('Authorization', `Bearer ${customer.token}`)
      .send({ transaction_pin: PIN, ...body });

  it('returns the number, the CVV and the expiry', async () => {
    // The gap this closes: `003_cards.sql` stores `last4` and an expiry and
    // nothing else, so every card issued since Phase 5 was unusable — there
    // was no way for a customer to read the number.
    const customer = await onboard();
    await fundWallet(customer.userId, 100_00);
    const card = await issueCard(customer, '10.00');

    const res = await reveal(customer, card.id).expect(200);

    expect(res.body.pan).toBe('4242424242424242');
    expect(res.body.cvv).toBe('123');
    expect(res.body.expiry_month).toBe(11);
    expect(res.body.expiry_year).toBe(2030);
  });

  it('asks for the PIN', async () => {
    // A card number, a CVV and an expiry together are everything needed to
    // spend online, and unlike a transfer there is no ledger entry afterwards
    // for anybody to notice.
    const customer = await onboard();
    await fundWallet(customer.userId, 100_00);
    const card = await issueCard(customer, '10.00');

    const res = await request(app.getHttpServer())
      .post(`/v1/cards/${card.id}/reveal`)
      .set('Authorization', `Bearer ${customer.token}`)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('transaction_pin_required');
  });

  it('refuses another customer card', async () => {
    const owner = await onboard();
    const stranger = await onboard();
    await fundWallet(owner.userId, 100_00);
    const card = await issueCard(owner, '10.00');

    const res = await reveal(stranger, card.id);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('card_not_found');
  });

  it('STORES NOTHING — the number is nowhere in the database', async () => {
    // The whole design in one assertion. The reveal is a pass-through: the
    // schema has no column that could hold a PAN, so this is a property of
    // the database rather than a rule somebody has to keep.
    const customer = await onboard();
    await fundWallet(customer.userId, 100_00);
    const card = await issueCard(customer, '10.00');
    await reveal(customer, card.id).expect(200);

    const cardRow = await pool.query<Record<string, unknown>>(
      `SELECT * FROM cards WHERE uuid = $1`,
      [card.id],
    );
    const revealRow = await pool.query<Record<string, unknown>>(
      `SELECT * FROM card_reveals WHERE card_id = (SELECT id FROM cards WHERE uuid = $1)`,
      [card.id],
    );

    const everything = JSON.stringify([cardRow.rows, revealRow.rows]);
    expect(everything).not.toContain('4242424242424242');
    expect(everything).not.toContain('"123"');
    // And the record of the reveal DOES exist — the fact, never the contents.
    expect(revealRow.rows).toHaveLength(1);
  });

  it('records who asked, so an investigator can answer when it was last shown', async () => {
    const customer = await onboard();
    await fundWallet(customer.userId, 100_00);
    const card = await issueCard(customer, '10.00');
    await reveal(customer, card.id).expect(200);

    const row = await pool.query<{ user_id: string; revealed_at: Date }>(
      `SELECT user_id, revealed_at FROM card_reveals
        WHERE card_id = (SELECT id FROM cards WHERE uuid = $1)`,
      [card.id],
    );
    expect(row.rows[0]?.user_id).toBe(customer.userId);
    expect(row.rows[0]?.revealed_at).toBeInstanceOf(Date);
  });

  it('stops after five reveals of one card', async () => {
    // A reveal endpoint is a PAN oracle for anybody holding a stolen session.
    // The ceiling counts ROWS rather than an in-memory counter, because an
    // attacker's loop outlives a pod restart and a counter does not.
    const customer = await onboard();
    await fundWallet(customer.userId, 100_00);
    const card = await issueCard(customer, '10.00');

    for (let i = 0; i < 5; i += 1) {
      await reveal(customer, card.id).expect(200);
    }

    const blocked = await reveal(customer, card.id);
    expect(blocked.status).toBe(429);
    expect(blocked.body.error).toBe('too_many_reveals');
  });

  it('stops a session walking through every card on the account', async () => {
    // The per-card ceiling would never see this: five reveals each across
    // three cards is fifteen numbers and no single card over its limit.
    const customer = await onboard();
    await fundWallet(customer.userId, 500_00);

    const cards = [
      await issueCard(customer, '10.00'),
      await issueCard(customer, '10.00'),
      await issueCard(customer, '10.00'),
    ];

    let refusals = 0;
    for (const card of cards) {
      for (let i = 0; i < 5; i += 1) {
        const res = await reveal(customer, card.id);
        if (res.status === 429) refusals += 1;
      }
    }
    expect(refusals).toBeGreaterThan(0);
  });

  it('refuses a terminated card', async () => {
    // Its number is dead at the provider, so revealing would either fail or
    // hand back something that no longer works — and a customer would spend an
    // afternoon trying to use it.
    const customer = await onboard();
    await fundWallet(customer.userId, 100_00);
    const card = await issueCard(customer, '10.00');

    await request(app.getHttpServer())
      .post(`/v1/cards/${card.id}/terminate`)
      .set('Authorization', `Bearer ${customer.token}`)
      .send({ transaction_pin: PIN })
      .expect(200);

    const res = await reveal(customer, card.id);
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('card_terminated');
  });

  it('still reveals a FROZEN card', async () => {
    // Freezing stops spending, not looking. Refusing would push a customer to
    // unfreeze the card just to read it, which is the opposite of what the
    // freeze was for.
    const customer = await onboard();
    await fundWallet(customer.userId, 100_00);
    const card = await issueCard(customer, '10.00');

    await request(app.getHttpServer())
      .post(`/v1/cards/${card.id}/freeze`)
      .set('Authorization', `Bearer ${customer.token}`)
      .send({})
      .expect(200);

    await reveal(customer, card.id).expect(200);
  });
});

describe('a card history', () => {
  const eventsOf = async (
    cardUuid: string,
  ): Promise<readonly { kind: string; actor: string; actor_id: string | null }[]> =>
    (
      await pool.query<{ kind: string; actor: string; actor_id: string | null }>(
        `SELECT e.kind::text AS kind, e.actor::text AS actor, e.actor_id::text
           FROM card_events e
           JOIN cards c ON c.id = e.card_id
          WHERE c.uuid = $1::uuid
          ORDER BY e.id`,
        [cardUuid],
      )
    ).rows;

  it('records every status change, and who caused it', async () => {
    // `cards` carries three timestamps and no actor, so a card frozen on
    // Monday and unfrozen on Tuesday had ONE `updated_at` and nothing saying
    // which happened or who did it. The first question in every card dispute
    // — "was this frozen at the time, and who unfroze it?" — had no answer.
    const customer = await onboard();
    await fundWallet(customer.userId, 100_00);
    const card = await issueCard(customer, '10.00');

    await request(app.getHttpServer())
      .post(`/v1/cards/${card.id}/freeze`)
      .set('Authorization', `Bearer ${customer.token}`)
      .send({})
      .expect(200);

    await request(app.getHttpServer())
      .post(`/v1/cards/${card.id}/unfreeze`)
      .set('Authorization', `Bearer ${customer.token}`)
      .send({ transaction_pin: PIN })
      .expect(200);

    const events = await eventsOf(card.id);
    expect(events.map((e) => e.kind)).toEqual(['issued', 'frozen', 'unfrozen']);

    // And the two the customer caused name the customer. Lifting a freeze is a
    // different event from activating, which is the distinction a dispute
    // turns on.
    expect(events[1]).toMatchObject({ actor: 'customer', actor_id: customer.userId });
    expect(events[2]).toMatchObject({ actor: 'customer', actor_id: customer.userId });

    // The issue event is still `system`: nothing yet attributes it, and the
    // honest answer is that something created this card and did not say who.
    expect(events[0]).toMatchObject({ actor: 'system', actor_id: null });
  });
});

describe('naming a card', () => {
  it('takes NO transaction PIN, because nothing moves', async () => {
    /*
     * A label is the customer's own note on their own list. Demanding the
     * secret that authorises payments in order to write one trains people to
     * type it for things that are not payments — which is the habit an
     * attacker asking for it relies on.
     */
    const customer = await onboard();
    await fundWallet(customer.userId, 100_00);
    const card = await issueCard(customer, '0.00');

    const res = await request(app.getHttpServer())
      .post(`/v1/cards/${card.id}/label`)
      .set('Authorization', `Bearer ${customer.token}`)
      .send({ label: 'Subscriptions' })
      .expect(200);

    expect(res.body.label).toBe('Subscriptions');
  });

  it('clears the name with null rather than with a blank', async () => {
    // The database refuses whitespace, so "" arriving as a label would be a
    // 400 on the obvious way to undo this. Both clients send null.
    const customer = await onboard();
    await fundWallet(customer.userId, 100_00);
    const card = await issueCard(customer, '0.00');

    await request(app.getHttpServer())
      .post(`/v1/cards/${card.id}/label`)
      .set('Authorization', `Bearer ${customer.token}`)
      .send({ label: 'Work travel' })
      .expect(200);

    const res = await request(app.getHttpServer())
      .post(`/v1/cards/${card.id}/label`)
      .set('Authorization', `Bearer ${customer.token}`)
      .send({ label: null })
      .expect(200);

    expect(res.body.label).toBeNull();
  });

  it('refuses to name somebody else card, with the same 404 as a card that does not exist', async () => {
    const owner = await onboard();
    const stranger = await onboard();
    await fundWallet(owner.userId, 100_00);
    const card = await issueCard(owner, '0.00');

    await request(app.getHttpServer())
      .post(`/v1/cards/${card.id}/label`)
      .set('Authorization', `Bearer ${stranger.token}`)
      .send({ label: 'Mine now' })
      .expect(404);
  });
});

describe('replacing a card', () => {
  it('kills the old number, carries the balance, and links the pair', async () => {
    const customer = await onboard();
    await fundWallet(customer.userId, 200_00);
    const old = await issueCard(customer, '40.00');

    const res = await request(app.getHttpServer())
      .post(`/v1/cards/${old.id}/reissue`)
      .set('Authorization', `Bearer ${customer.token}`)
      .send({
        name_on_card: 'Ada Obi',
        transaction_pin: PIN,
        idempotency_key: randomUUID(),
      })
      .expect(200);

    const replacement = res.body.id as string;
    expect(replacement).not.toBe(old.id);

    // THE LEAKED NUMBER IS DEAD. Issuing first would have left the customer
    // holding a live replacement AND a live compromised card if the
    // termination then failed — the exact state they came here to escape.
    const oldRow = await pool.query<{ status: string }>(
      `SELECT status::text FROM cards WHERE uuid = $1::uuid`,
      [old.id],
    );
    expect(oldRow.rows[0]?.status).toBe('terminated');

    // The balance came with it, so replacing a card does not silently empty
    // it.
    expect(res.body.balance).toBe('40.00');

    // And the pair reads in both directions, so the history is one card's life
    // rather than an unexplained termination and an unrelated new card.
    const linked = await pool.query<{ replaces: string | null; replaced_by: string | null }>(
      `SELECT replaces_card_id::text AS replaces, replaced_by_card_id::text AS replaced_by
         FROM card_history WHERE card_id = $1::uuid`,
      [replacement],
    );
    expect(linked.rows[0]?.replaces).toBe(old.id);
  });

  it('calls the new card a REISSUE, not an ordinary issue', async () => {
    // Two different facts about the same row: "the customer wanted another
    // card" and "we replaced one whose number leaked".
    const customer = await onboard();
    await fundWallet(customer.userId, 100_00);
    const old = await issueCard(customer, '10.00');

    const res = await request(app.getHttpServer())
      .post(`/v1/cards/${old.id}/reissue`)
      .set('Authorization', `Bearer ${customer.token}`)
      .send({
        name_on_card: 'Ada Obi',
        transaction_pin: PIN,
        idempotency_key: randomUUID(),
      })
      .expect(200);

    const kinds = await pool.query<{ kind: string }>(
      `SELECT e.kind::text AS kind FROM card_events e
         JOIN cards c ON c.id = e.card_id
        WHERE c.uuid = $1::uuid ORDER BY e.id`,
      [res.body.id],
    );
    expect(kinds.rows[0]?.kind).toBe('reissued');

    // The old card's termination says why, rather than reading as a customer
    // who simply stopped using it.
    const reason = await pool.query<{ reason: string | null }>(
      `SELECT e.reason FROM card_events e
         JOIN cards c ON c.id = e.card_id
        WHERE c.uuid = $1::uuid AND e.kind = 'terminated'`,
      [old.id],
    );
    expect(reason.rows[0]?.reason).toContain('replaced');
  });

  it('refuses to reissue somebody else card', async () => {
    const owner = await onboard();
    const stranger = await onboard();
    await fundWallet(owner.userId, 100_00);
    const card = await issueCard(owner, '10.00');

    const res = await request(app.getHttpServer())
      .post(`/v1/cards/${card.id}/reissue`)
      .set('Authorization', `Bearer ${stranger.token}`)
      .send({
        name_on_card: 'Someone Else',
        transaction_pin: PIN,
        idempotency_key: randomUUID(),
      });
    expect(res.status).toBe(404);
  });
});

describe('what support can see and do', () => {
  /** A compliance operator, enrolled and elevated — every staff route needs a
   *  second factor, including the read-only ones. */
  async function makeOperator(role: string): Promise<Customer> {
    const person = await onboard();
    await pool.query(
      `INSERT INTO staff_roles (user_id, role, granted_by) VALUES ($1, $2::staff_role, $1)
       ON CONFLICT DO NOTHING`,
      [person.userId, role],
    );
    await enrolAndElevate(app, pool, person.token, person.userId);
    return person;
  }

  it('shows a card, its history, and never the number', async () => {
    // A customer ringing about a declined card was a conversation nobody on
    // this side could follow: no status, no history, no way to tell whether
    // the card had been frozen or by whom.
    const operator = await makeOperator('support');
    const customer = await onboard();
    await fundWallet(customer.userId, 100_00);
    const card = await issueCard(customer, '10.00');

    await request(app.getHttpServer())
      .post(`/v1/cards/${card.id}/freeze`)
      .set('Authorization', `Bearer ${customer.token}`)
      .send({})
      .expect(200);

    const res = await request(app.getHttpServer())
      .get(`/v1/admin/cards/${card.id}`)
      .set('Authorization', `Bearer ${operator.token}`)
      .expect(200);

    expect(res.body.status).toBe('frozen');
    expect((res.body.events as { kind: string }[]).map((e) => e.kind)).toEqual([
      'issued',
      'frozen',
    ]);
    // Four digits and no more. This response is read over shoulders and
    // screenshotted into tickets.
    expect(String(res.body.last4)).toMatch(/^[0-9]{4}$/);
    expect(JSON.stringify(res.body)).not.toMatch(/[0-9]{12,}/);
  });

  it('lets compliance freeze a card, and records why', async () => {
    const operator = await makeOperator('compliance');
    const customer = await onboard();
    await fundWallet(customer.userId, 100_00);
    const card = await issueCard(customer, '10.00');

    await request(app.getHttpServer())
      .post(`/v1/admin/cards/${card.id}/freeze`)
      .set('Authorization', `Bearer ${operator.token}`)
      .send({
        reason: 'customer reports charges they did not make',
        transaction_pin: PIN,
      })
      .expect(204);

    const events = await pool.query<{ kind: string; actor: string; reason: string | null }>(
      `SELECT e.kind::text AS kind, e.actor::text AS actor, e.reason
         FROM card_events e JOIN cards c ON c.id = e.card_id
        WHERE c.uuid = $1::uuid ORDER BY e.id DESC LIMIT 1`,
      [card.id],
    );
    expect(events.rows[0]).toMatchObject({ kind: 'frozen', actor: 'staff' });
    // A customer WILL ring back to ask why their card stopped working, and
    // "a member of staff froze it" is not an answer.
    expect(events.rows[0]?.reason).toContain('did not make');
  });

  it('refuses a freeze with no reason', async () => {
    const operator = await makeOperator('compliance');
    const customer = await onboard();
    await fundWallet(customer.userId, 100_00);
    const card = await issueCard(customer, '10.00');

    const res = await request(app.getHttpServer())
      .post(`/v1/admin/cards/${card.id}/freeze`)
      .set('Authorization', `Bearer ${operator.token}`)
      .send({ reason: 'x', transaction_pin: PIN });
    expect(res.status).toBe(400);
  });

  it('has NO staff terminate at all', async () => {
    // Not a missing endpoint — a decision. Freezing stops spending and the
    // customer can undo it; terminating moves their money and cannot be
    // undone, and there is no support conversation in which doing that
    // without them is right. The guard denies an undeclared route.
    const operator = await makeOperator('compliance');
    const customer = await onboard();
    await fundWallet(customer.userId, 100_00);
    const card = await issueCard(customer, '10.00');

    const res = await request(app.getHttpServer())
      .post(`/v1/admin/cards/${card.id}/terminate`)
      .set('Authorization', `Bearer ${operator.token}`)
      .send({ reason: 'because I can', transaction_pin: PIN });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('is refused to a signed-in customer', async () => {
    const customer = await onboard();
    const other = await onboard();
    await fundWallet(other.userId, 100_00);
    const card = await issueCard(other, '10.00');

    const res = await request(app.getHttpServer())
      .get(`/v1/admin/cards/${card.id}`)
      .set('Authorization', `Bearer ${customer.token}`);
    expect(res.status).toBe(403);
  });
});

describe('the two halves of a card spend', () => {
  const stuckHolds = async (cardUuid: string): Promise<number> =>
    Number(
      (
        await pool.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM card_holds_stuck WHERE card_id = $1::uuid`,
          [cardUuid],
        )
      ).rows[0]?.n ?? '0',
    );

  /** Ages a hold past the settlement window, because waiting sixteen days is
   *  not a test. The window itself is asserted by the invariant suite. */
  const age = async (providerTxnId: string): Promise<void> => {
    await pool.query(
      `UPDATE card_authorizations SET occurred_at = now() - interval '40 days'
        WHERE provider_txn_id = $1`,
      [providerTxnId],
    );
  };

  it('connects a settlement to the hold it resolves', async () => {
    // Before this the two halves were never connected: the authorization
    // recorded its entry, the settlement posted its own, and nothing could
    // answer "which holds are still open?".
    const customer = await onboard();
    await fundWallet(customer.userId, 200_00);
    const card = await issueCard(customer, '50.00');

    const authTxn = `txn_auth_${randomUUID()}`;
    expect((await deliverWebhook(BITNOB_EVENTS.cardAuthorization, card.providerCardId, '10000000', {
      txnId: authTxn,
    })).status).toBe(200);

    expect((await deliverWebhook(BITNOB_EVENTS.cardSettlement, card.providerCardId, '10000000', {
      authorizationId: authTxn,
    })).status).toBe(200);

    const closed = await pool.query<{ outcome: string; amount_minor: string }>(
      `SELECT s.outcome::text, s.amount_minor::text
         FROM card_settlements s
         JOIN card_authorizations a ON a.id = s.authorization_id
        WHERE a.provider_txn_id = $1`,
      [authTxn],
    );
    expect(closed.rows[0]).toMatchObject({ outcome: 'settled', amount_minor: '1000' });
  });

  it('reports a hold whose settlement never came', async () => {
    // THE FAILURE NOTHING ELSE SEES. The money sits in customer_pending: the
    // customer cannot spend it, the ledger balances perfectly, and
    // `ledger_drift` reports nothing at all.
    const customer = await onboard();
    await fundWallet(customer.userId, 200_00);
    const card = await issueCard(customer, '50.00');

    const authTxn = `txn_lost_${randomUUID()}`;
    expect((await deliverWebhook(BITNOB_EVENTS.cardAuthorization, card.providerCardId, '10000000', {
      txnId: authTxn,
    })).status).toBe(200);

    // Young: not yet anybody's problem.
    expect(await stuckHolds(card.id)).toBe(0);

    await age(authTxn);
    expect(await stuckHolds(card.id)).toBe(1);
  });

  it('stops reporting it once the settlement finally arrives', async () => {
    // A late webhook is the commonest cause, and the queue has to empty when
    // one turns up — otherwise the list only ever grows and stops being read.
    const customer = await onboard();
    await fundWallet(customer.userId, 200_00);
    const card = await issueCard(customer, '50.00');

    const authTxn = `txn_late_${randomUUID()}`;
    expect((await deliverWebhook(BITNOB_EVENTS.cardAuthorization, card.providerCardId, '10000000', {
      txnId: authTxn,
    })).status).toBe(200);
    await age(authTxn);
    expect(await stuckHolds(card.id)).toBe(1);

    expect((await deliverWebhook(BITNOB_EVENTS.cardSettlement, card.providerCardId, '10000000', {
      authorizationId: authTxn,
    })).status).toBe(200);
    expect(await stuckHolds(card.id)).toBe(0);
  });

  it('records a settlement that does not match what was authorised', async () => {
    // A tip added after the card was presented is a few percent; a settlement
    // many times the authorisation is a merchant error or a compromised
    // terminal, and nothing compared the two before.
    const customer = await onboard();
    await fundWallet(customer.userId, 500_00);
    const card = await issueCard(customer, '200.00');

    const authTxn = `txn_tip_${randomUUID()}`;
    // Authorised $10.00.
    expect((await deliverWebhook(BITNOB_EVENTS.cardAuthorization, card.providerCardId, '10000000', {
      txnId: authTxn,
    })).status).toBe(200);
    // Settled $40.00.
    expect((await deliverWebhook(BITNOB_EVENTS.cardSettlement, card.providerCardId, '40000000', {
      authorizationId: authTxn,
    })).status).toBe(200);

    const differences = await pool.query<{ authorised_minor: string; settled_minor: string }>(
      `SELECT authorised_minor::text, settled_minor::text
         FROM card_settlement_differences WHERE card_id = $1::uuid`,
      [card.id],
    );
    expect(differences.rows[0]).toMatchObject({
      authorised_minor: '1000',
      settled_minor: '4000',
    });
  });

  it('REFUSES a settlement for a hold it has no record of, so it is retried', async () => {
    // Written the other way round first, and the assertion was wrong.
    //
    // A settlement naming an authorization this card never saw means we missed
    // the authorization webhook. There is nothing in `customer_pending` to
    // release, so the entry cannot post at all — and acknowledging would drop
    // a real spend from the books permanently. Rethrowing makes Bitnob retry,
    // and webhooks arrive out of order: the authorization landing a moment
    // later makes the retry succeed on its own. That is the rule this codebase
    // already states about an authorization the card cannot cover, and it
    // applies unchanged here.
    const customer = await onboard();
    await fundWallet(customer.userId, 200_00);
    const card = await issueCard(customer, '50.00');

    expect(
      (
        await deliverWebhook(BITNOB_EVENTS.cardSettlement, card.providerCardId, '10000000', {
          authorizationId: 'txn_this_card_never_saw',
        })
      ).status,
    ).toBe(500);
  });

  it('succeeds on the retry once the missing authorization arrives', async () => {
    // The reason refusing above is right rather than merely strict: the
    // ordering fixes itself, and a provider that keeps retrying is what makes
    // that possible.
    const customer = await onboard();
    await fundWallet(customer.userId, 200_00);
    const card = await issueCard(customer, '50.00');

    const authTxn = `txn_ooo_${randomUUID()}`;

    // The settlement first, out of order.
    expect(
      (
        await deliverWebhook(BITNOB_EVENTS.cardSettlement, card.providerCardId, '10000000', {
          authorizationId: authTxn,
        })
      ).status,
    ).toBe(500);

    expect(
      (
        await deliverWebhook(BITNOB_EVENTS.cardAuthorization, card.providerCardId, '10000000', {
          txnId: authTxn,
        })
      ).status,
    ).toBe(200);

    // Bitnob's retry, which now finds the hold it needs.
    expect(
      (
        await deliverWebhook(BITNOB_EVENTS.cardSettlement, card.providerCardId, '10000000', {
          authorizationId: authTxn,
        })
      ).status,
    ).toBe(200);

    const closed = await pool.query<{ outcome: string }>(
      `SELECT s.outcome::text FROM card_settlements s
         JOIN card_authorizations a ON a.id = s.authorization_id
        WHERE a.provider_txn_id = $1`,
      [authTxn],
    );
    expect(closed.rows[0]?.outcome).toBe('settled');
  });
});
