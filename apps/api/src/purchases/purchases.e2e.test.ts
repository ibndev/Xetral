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
import { ProviderTimeoutError } from '@xetral/providers';
import type {
  CatalogueItem,
  CatalogueQuery,
  FulfilmentPort,
  PurchaseLookup,
  PurchaseRequest,
  PurchaseResult,
  ServiceKind,
  VerifiedTarget,
} from '@xetral/providers';
import { ngn } from '@xetral/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from '../app.module.js';
import type { ApiConfig } from '../config.js';
import { systemClock } from '../tokens.js';
import { testApiConfig } from '../test-support/api-config.js';

/**
 * Buying airtime, data, a utility token, an eSIM or a number — end to end over
 * HTTP, against a real PostgreSQL.
 *
 * The providers are stood in for, because what needs proving is on OUR side of
 * the port: that the money is committed before anything is ordered, that a
 * refusal gives it back through a reversal rather than an edit, that a TIMEOUT
 * does neither, and that a retry cannot buy the same thing twice. A live VTpass
 * would test none of those and would make the suite depend on their sandbox
 * being up.
 *
 * Requires DATABASE_URL with 001..004 applied.
 */
const DATABASE_URL = process.env['DATABASE_URL'];
if (DATABASE_URL === undefined || DATABASE_URL === '') {
  throw new Error('the purchase e2e suite needs DATABASE_URL with the migrations applied');
}

const PASSWORD = 'a-long-enough-password';
const PIN = '374915';

/**
 * A provider whose answer the test dictates.
 *
 * `calls` is asserted on as much as the responses are: "did we ask the
 * provider at all?" is the question behind both the reserve-first ordering and
 * the retry guard, and a fake that only records outcomes cannot answer it.
 */
class FakePort implements FulfilmentPort {
  readonly provider = 'fake';
  readonly calls: PurchaseRequest[] = [];

  #next: PurchaseResult | Error = {
    status: 'delivered',
    providerReference: 'fake-1',
    delivery: { token: '1111-2222-3333-4444' },
  };

  constructor(readonly service: ServiceKind) {}

  answerWith(next: PurchaseResult | Error): void {
    this.#next = next;
  }

  async catalogue(query: CatalogueQuery): Promise<readonly CatalogueItem[]> {
    return [
      {
        code: 'mtn:1gb',
        name: 'MTN 1GB',
        priceMinor: 350_00n,
        currency: 'NGN',
        metadata: { group: query.group ?? '' },
      },
    ];
  }

  async purchase(req: PurchaseRequest): Promise<PurchaseResult> {
    this.calls.push(req);
    if (this.#next instanceof Error) throw this.#next;
    return this.#next;
  }

  async status(lookup: PurchaseLookup): Promise<PurchaseResult> {
    return { status: 'pending', providerReference: lookup.reference, delivery: {} };
  }
}

/** Only some providers can confirm who a meter belongs to. This one can, and
 *  the eSIM port below deliberately cannot. */
class VerifyingPort extends FakePort {
  async verifyTarget(_itemCode: string, target: string): Promise<VerifiedTarget> {
    return { target, name: 'ADEBAYO O.', metadata: {} };
  }
}

let pool: Pool;
let ledger: LedgerService;
let app: INestApplication;
let data: VerifyingPort;
let esim: FakePort;

function makeConfig(overrides: Partial<ApiConfig> = {}): ApiConfig {
  return testApiConfig(DATABASE_URL as string, { ...overrides });
}

async function createApp(
  ports: ReadonlyMap<ServiceKind, FulfilmentPort>,
  config: ApiConfig = makeConfig(),
): Promise<INestApplication> {
  const mod = await Test.createTestingModule({
    imports: [
      AppModule.forRoot({ config, pool, clock: systemClock, fulfilmentPorts: ports }),
    ],
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

async function onboard(instance: INestApplication = app): Promise<Customer> {
  const identifier = `buy-${randomUUID()}@example.ng`;

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
      device: { fingerprint: `fp-${randomUUID()}`, platform: 'android' },
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

/** Stands in for the bank rail Phase 4 could not land. */
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

const buy = (
  customer: Customer,
  body: Record<string, unknown>,
  instance: INestApplication = app,
) =>
  request(instance.getHttpServer())
    .post('/v1/purchases')
    .set('Authorization', `Bearer ${customer.token}`)
    .send(body);

const airtimeBody = (overrides: Record<string, unknown> = {}) => ({
  service: 'data',
  item_code: 'mtn:1gb',
  target: '08030000000',
  amount: '350.00',
  transaction_pin: PIN,
  idempotency_key: randomUUID(),
  ...overrides,
});

async function balances(
  customer: Customer,
  instance: INestApplication = app,
): Promise<{ currency: string; spendable: string; pending: string; total: string }[]> {
  const res = await request(instance.getHttpServer())
    .get('/v1/wallets')
    .set('Authorization', `Bearer ${customer.token}`)
    .expect(200);
  return res.body.balances;
}

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: DATABASE_URL, max: 8 });
  ledger = new LedgerService(pool);
  data = new VerifyingPort('data');
  esim = new FakePort('esim');
  app = await createApp(
    new Map<ServiceKind, FulfilmentPort>([
      ['data', data],
      ['esim', esim],
    ]),
  );
});

afterAll(async () => {
  await app?.close();
  await pool?.end();
});

beforeEach(() => {
  data.calls.length = 0;
  data.answerWith({
    status: 'delivered',
    providerReference: 'fake-1',
    delivery: { token: '1111-2222-3333-4444' },
  });
});

describe('catalogue', () => {
  it('lists what can be bought', async () => {
    const customer = await onboard();
    const res = await request(app.getHttpServer())
      .get('/v1/purchases/catalogue?service=data&group=mtn-data')
      .set('Authorization', `Bearer ${customer.token}`)
      .expect(200);

    expect(res.body.items[0]).toMatchObject({ code: 'mtn:1gb', price: '350.00', currency: 'NGN' });
  });

  it('needs a session', async () => {
    // Not because a price list is secret, but because an open endpoint naming
    // our providers and their product codes is a map of our supply chain.
    const res = await request(app.getHttpServer()).get('/v1/purchases/catalogue?service=data');
    expect(res.status).toBe(401);
  });

  it('refuses a service this instance is not configured for', async () => {
    const customer = await onboard();
    const res = await request(app.getHttpServer())
      .get('/v1/purchases/catalogue?service=number')
      .set('Authorization', `Bearer ${customer.token}`);

    expect(res.status).toBe(503);
    expect(res.body.error).toBe('service_not_configured');
  });
});

describe('verifying a target', () => {
  it('names the account holder before any money moves', async () => {
    const customer = await onboard();
    const res = await request(app.getHttpServer())
      .post('/v1/purchases/verify')
      .set('Authorization', `Bearer ${customer.token}`)
      .send({ service: 'data', item_code: 'mtn:1gb', target: '08030000000' })
      .expect(200);

    expect(res.body).toMatchObject({ name: 'ADEBAYO O.' });
  });

  it('says so plainly when a provider cannot verify', async () => {
    // Rather than inventing a confirmation. "Verified" is a claim a customer
    // acts on, and a fabricated one is worse than none.
    const customer = await onboard();
    const res = await request(app.getHttpServer())
      .post('/v1/purchases/verify')
      .set('Authorization', `Bearer ${customer.token}`)
      .send({ service: 'esim', item_code: 'ng-1gb', target: 'NG' });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('verification_not_supported');
  });
});

describe('buying', () => {
  it('takes the money, delivers, and seals the token', async () => {
    const customer = await onboard();
    await fund(customer.userId, 10_000_00);

    const res = await buy(customer, airtimeBody());
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'delivered', amount: '350.00', currency: 'NGN' });
    expect(res.body.delivery).toEqual({ token: '1111-2222-3333-4444' });

    expect((await balances(customer))[0]).toMatchObject({
      spendable: '9650.00',
      // Reserved, then settled — nothing left held.
      pending: '0.00',
    });

    // The token is a bearer instrument. It reaches the customer and must NOT
    // sit in the database in the clear.
    const stored = await pool.query<{ delivery_sealed: string }>(
      `SELECT delivery_sealed FROM purchases WHERE user_id = $1::bigint`,
      [customer.userId],
    );
    expect(stored.rows[0]?.delivery_sealed).toMatch(/^v1:/);
    expect(stored.rows[0]?.delivery_sealed).not.toContain('1111');
  });

  it('needs a transaction PIN, and refuses a wrong one', async () => {
    const customer = await onboard();
    await fund(customer.userId, 10_000_00);

    const missing = await buy(customer, { ...airtimeBody(), transaction_pin: undefined });
    expect(missing.status).toBe(400);

    // A wrong PIN is the case worth having: it proves AuthGuard actually
    // verifies the route's `pin: true` rather than merely requiring the field
    // to be present, which zod would satisfy on its own.
    const wrong = await buy(customer, airtimeBody({ transaction_pin: '999119' }));
    expect(wrong.status).toBe(401);
    expect(wrong.body.error).toBe('invalid_pin');

    // Neither request ordered anything. The provider is asked only after the
    // customer's intent has been authenticated AND their money committed.
    expect(data.calls).toHaveLength(0);
    expect((await balances(customer))[0]?.spendable).toBe('10000.00');
  });

  it('refuses a purchase the wallet cannot cover, and asks the provider nothing', async () => {
    const customer = await onboard();
    await fund(customer.userId, 100_00);

    const res = await buy(customer, airtimeBody());
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('insufficient_funds');
    // The order of operations IS the protection: money first, provider second.
    expect(data.calls).toHaveLength(0);
  });

  it('gives the money back by reversal when the provider declines', async () => {
    const customer = await onboard();
    await fund(customer.userId, 10_000_00);
    data.answerWith({
      status: 'failed',
      providerReference: 'fake-declined',
      delivery: {},
      failureReason: 'invalid phone number',
    });

    const res = await buy(customer, airtimeBody());
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'reversed', failure_reason: 'invalid phone number' });

    // Whole balance back, nothing held.
    expect((await balances(customer))[0]).toMatchObject({
      spendable: '10000.00',
      pending: '0.00',
    });

    // Appended, not edited: the reserve entry is still there and a reversal
    // NAMES it. An auditor can follow that; a deleted row tells them nothing.
    const entries = await pool.query<{ kind: string; reverses_id: string | null }>(
      `SELECT kind, reverses_id FROM journal_entries
        WHERE metadata->>'reference' = $1 ORDER BY id`,
      [await referenceOf(customer.userId)],
    );
    expect(entries.rows.map((r) => r.kind)).toEqual(['bill_payment', 'reversal']);
    expect(entries.rows[1]?.reverses_id).not.toBeNull();
  });

  it('leaves a TIMEOUT reserved, for reconciliation rather than a guess', async () => {
    const customer = await onboard();
    await fund(customer.userId, 10_000_00);
    data.answerWith(new ProviderTimeoutError('fake', 'no response in 15000ms'));

    const res = await buy(customer, airtimeBody());
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('reserved');

    // The money is HELD, not returned and not spent. We do not know which of
    // those is true, and pretending otherwise either refunds a delivered
    // purchase or keeps payment for one that never happened.
    expect((await balances(customer))[0]).toMatchObject({
      spendable: '9650.00',
      pending: '350.00',
    });

    const queued = await pool.query(
      `SELECT 1 FROM pending_purchases WHERE user_id = $1::bigint`,
      [customer.userId],
    );
    expect(queued.rowCount).toBe(1);
  });

  it('charges once for a retried request', async () => {
    const customer = await onboard();
    await fund(customer.userId, 10_000_00);
    const body = airtimeBody();

    const first = await buy(customer, body);
    const second = await buy(customer, body);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body.id).toBe(first.body.id);
    // And the provider was asked exactly once. A retry that re-orders is how a
    // customer ends up with two eSIMs and one of them unrefundable.
    expect(data.calls).toHaveLength(1);
    expect((await balances(customer))[0]?.spendable).toBe('9650.00');
  });

  it('does not let one customer key collide with another customer', async () => {
    // A client counting from one makes this inevitable. It was a globally
    // unique column until this test existed.
    const alice = await onboard();
    const bob = await onboard();
    await fund(alice.userId, 10_000_00);
    await fund(bob.userId, 10_000_00);

    const key = `shared-${randomUUID()}`;
    const first = await buy(alice, airtimeBody({ idempotency_key: key }));
    const second = await buy(bob, airtimeBody({ idempotency_key: key }));

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body.id).not.toBe(first.body.id);
    expect(data.calls).toHaveLength(2);
  });

  it('rejects an amount that is not a decimal string', async () => {
    const customer = await onboard();
    await fund(customer.userId, 10_000_00);

    const res = await buy(customer, airtimeBody({ amount: '350.005' }));
    expect(res.status).toBe(400);
    expect(data.calls).toHaveLength(0);
  });

  it('lists a customer only their own purchases', async () => {
    const alice = await onboard();
    const bob = await onboard();
    await fund(alice.userId, 10_000_00);
    await buy(alice, airtimeBody());

    const mine = await request(app.getHttpServer())
      .get('/v1/purchases')
      .set('Authorization', `Bearer ${alice.token}`)
      .expect(200);
    const theirs = await request(app.getHttpServer())
      .get('/v1/purchases')
      .set('Authorization', `Bearer ${bob.token}`)
      .expect(200);

    expect(mine.body.purchases).toHaveLength(1);
    expect(theirs.body.purchases).toHaveLength(0);
  });
});

/** The reference is derived, not returned, so the reversal test reads it back
 *  rather than reconstructing the hash. */
async function referenceOf(userId: string): Promise<string> {
  const res = await pool.query<{ reference: string }>(
    `SELECT reference FROM purchases WHERE user_id = $1::bigint ORDER BY id DESC LIMIT 1`,
    [userId],
  );
  const row = res.rows[0];
  if (row === undefined) throw new Error('no purchase for that customer');
  return row.reference;
}
