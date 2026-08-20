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
import { ProviderTimeoutError, ProviderUnavailableError } from '@xetral/providers';
import type {
  CatalogueItem,
  CatalogueQuery,
  FulfilmentPort,
  PurchaseRequest,
  PurchaseResult,
  ServiceKind,
} from '@xetral/providers';
import { ngn } from '@xetral/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from '../app.module.js';
import type { ApiConfig } from '../config.js';
import { ReconciliationService } from './reconciliation.service.js';
import { systemClock } from '../tokens.js';
import { testApiConfig } from '../test-support/api-config.js';

/**
 * Resolving purchases that were left holding a customer's money.
 *
 * A note on the counts. This suite shares its database with the others, and a
 * sweep is global by design — it resolves every held purchase it can see,
 * including ones an earlier suite left behind. So the report counts are
 * asserted as lower bounds and the real assertions are on THIS test's
 * purchase: its status, and its customer's balance. A worker whose correctness
 * was expressed as an exact global count would be a worker that only works on
 * an empty database.
 *
 * Every case here starts by producing a REAL held purchase — a timeout during
 * a real HTTP purchase, against the real ledger — rather than by inserting a
 * row that looks like one. The bug this worker exists to prevent is money
 * stuck in `customer_pending`, and a fixture row would not have any.
 */
const DATABASE_URL = process.env['DATABASE_URL'];
if (DATABASE_URL === undefined || DATABASE_URL === '') {
  throw new Error('the reconciliation e2e suite needs DATABASE_URL with the migrations applied');
}

const PASSWORD = 'a-long-enough-password';
const PIN = '374915';

class FakePort implements FulfilmentPort {
  readonly provider = 'fake';
  readonly service: ServiceKind = 'data';
  readonly statusCalls: string[] = [];

  /** What `purchase()` does. Defaults to a timeout, since that is what leaves
   *  a purchase held in the first place. */
  purchaseAnswer: PurchaseResult | Error = new ProviderTimeoutError('fake', 'no response');
  /** What `status()` later says happened. */
  statusAnswer: PurchaseResult | Error = {
    status: 'pending',
    providerReference: 'fake-pending',
    delivery: {},
  };

  async catalogue(_query: CatalogueQuery): Promise<readonly CatalogueItem[]> {
    return [];
  }

  async purchase(_req: PurchaseRequest): Promise<PurchaseResult> {
    if (this.purchaseAnswer instanceof Error) throw this.purchaseAnswer;
    return this.purchaseAnswer;
  }

  async status(reference: string): Promise<PurchaseResult> {
    this.statusCalls.push(reference);
    if (this.statusAnswer instanceof Error) throw this.statusAnswer;
    return this.statusAnswer;
  }
}

let pool: Pool;
let ledger: LedgerService;
let app: INestApplication;
let port: FakePort;
let reconciler: ReconciliationService;

async function boot(config: ApiConfig): Promise<INestApplication> {
  const mod = await Test.createTestingModule({
    imports: [
      AppModule.forRoot({
        config,
        pool,
        clock: systemClock,
        fulfilmentPorts: new Map<ServiceKind, FulfilmentPort>([['data', port]]),
      }),
    ],
  }).compile();
  const created = mod.createNestApplication(new ExpressAdapter());
  await created.init();
  return created;
}

interface Customer {
  userId: string;
  token: string;
}

async function onboard(): Promise<Customer> {
  const identifier = `recon-${randomUUID()}@example.ng`;
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

  const login = await request(app.getHttpServer())
    .post('/v1/auth/login')
    .send({
      identifier,
      password: PASSWORD,
      device: { fingerprint: `fp-${randomUUID()}`, platform: 'android' },
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

/** Drives a real purchase to the held state through the actual HTTP route. */
async function heldPurchase(): Promise<Customer> {
  const customer = await onboard();
  await fund(customer.userId, 10_000_00);

  const res = await request(app.getHttpServer())
    .post('/v1/purchases')
    .set('Authorization', `Bearer ${customer.token}`)
    .send({
      service: 'data',
      item_code: 'mtn:1gb',
      target: '08030000000',
      amount: '350.00',
      transaction_pin: PIN,
      idempotency_key: randomUUID(),
    })
    .expect(200);

  expect(res.body.status).toBe('reserved');
  return customer;
}

async function balanceOf(
  customer: Customer,
): Promise<{ spendable: string; pending: string } | undefined> {
  const res = await request(app.getHttpServer())
    .get('/v1/wallets')
    .set('Authorization', `Bearer ${customer.token}`)
    .expect(200);
  return res.body.balances[0];
}

async function statusOf(userId: string): Promise<string> {
  const res = await pool.query<{ status: string }>(
    `SELECT status FROM purchases WHERE user_id = $1::bigint ORDER BY id DESC LIMIT 1`,
    [userId],
  );
  const row = res.rows[0];
  if (row === undefined) throw new Error('no purchase');
  return row.status;
}

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: DATABASE_URL, max: 8 });
  ledger = new LedgerService(pool);
  port = new FakePort();
  app = await boot(testApiConfig(DATABASE_URL as string));
  reconciler = app.get(ReconciliationService);
});

afterAll(async () => {
  await app?.close();
  await pool?.end();
});

beforeEach(() => {
  port.statusCalls.length = 0;
  port.purchaseAnswer = new ProviderTimeoutError('fake', 'no response');
  port.statusAnswer = { status: 'pending', providerReference: 'fake-pending', delivery: {} };
});

describe('resolving held purchases', () => {
  it('settles one the provider says was delivered', async () => {
    const customer = await heldPurchase();
    expect(await balanceOf(customer)).toMatchObject({ spendable: '9650.00', pending: '350.00' });

    port.statusAnswer = {
      status: 'delivered',
      providerReference: 'vt-9911',
      delivery: { token: '5555-6666-7777-8888' },
    };

    const report = await reconciler.sweep();
    expect(report.settled).toBeGreaterThanOrEqual(1);
    expect(report.reversed).toBe(0);

    expect(await statusOf(customer.userId)).toBe('delivered');
    // The hold is gone and the money is spent, not returned.
    expect(await balanceOf(customer)).toMatchObject({ spendable: '9650.00', pending: '0.00' });

    // And the token it belatedly learned about is sealed, exactly as it would
    // have been had the answer arrived during the request.
    const stored = await pool.query<{ delivery_sealed: string | null }>(
      `SELECT delivery_sealed FROM purchases WHERE user_id = $1::bigint`,
      [customer.userId],
    );
    expect(stored.rows[0]?.delivery_sealed).toMatch(/^v1:/);
    expect(stored.rows[0]?.delivery_sealed).not.toContain('5555');
  });

  it('reverses one the provider says failed, and the money comes back', async () => {
    const customer = await heldPurchase();
    port.statusAnswer = {
      status: 'failed',
      providerReference: 'vt-dead',
      delivery: {},
      failureReason: 'network rejected the number',
    };

    const report = await reconciler.sweep();
    expect(report.reversed).toBeGreaterThanOrEqual(1);
    expect(report.settled).toBe(0);

    expect(await statusOf(customer.userId)).toBe('reversed');
    expect(await balanceOf(customer)).toMatchObject({ spendable: '10000.00', pending: '0.00' });
  });

  it('leaves one alone while the provider still says pending', async () => {
    // The rule the whole worker rests on: it never DECIDES an outcome, it only
    // relays one. Money stays held until somebody knows what happened.
    const customer = await heldPurchase();

    const report = await reconciler.sweep();
    expect(report.stillPending).toBeGreaterThanOrEqual(1);
    expect(report.settled).toBe(0);
    expect(report.reversed).toBe(0);

    expect(await statusOf(customer.userId)).toBe('reserved');
    expect(await balanceOf(customer)).toMatchObject({ spendable: '9650.00', pending: '350.00' });
  });

  it('holds the money when the provider cannot be reached at all', async () => {
    const customer = await heldPurchase();
    port.statusAnswer = new ProviderUnavailableError('fake', 'connection refused');

    const report = await reconciler.sweep();
    expect(report.failed).toBeGreaterThanOrEqual(1);
    expect(report.settled).toBe(0);
    expect(report.reversed).toBe(0);

    // An unreachable provider is not a failed purchase. Treating it as one
    // would refund every delivered purchase during an outage.
    expect(await statusOf(customer.userId)).toBe('reserved');
    expect(await balanceOf(customer)).toMatchObject({ pending: '350.00' });
  });

  it('is safe to run twice — the second pass is a no-op, not a double settle', async () => {
    const customer = await heldPurchase();
    port.statusAnswer = { status: 'delivered', providerReference: 'vt-1', delivery: {} };

    await reconciler.sweep();
    const second = await reconciler.sweep();

    expect(second).toMatchObject({ examined: 0 });
    expect(await statusOf(customer.userId)).toBe('delivered');
    expect(await balanceOf(customer)).toMatchObject({ spendable: '9650.00', pending: '0.00' });
  });

  it('does not touch a purchase inside its grace period', async () => {
    // A row seconds old is probably still in flight in a request handler about
    // to settle it. Sweeping it races that handler for no benefit.
    const customer = await heldPurchase();
    const graced = await boot(
      testApiConfig(DATABASE_URL as string, { reconcileGraceSeconds: 3600 }),
    );
    try {
      const report = await graced.get(ReconciliationService).sweep();
      expect(report.examined).toBe(0);
      expect(port.statusCalls).toHaveLength(0);
    } finally {
      await graced.close();
    }

    expect(await statusOf(customer.userId)).toBe('reserved');
  });

  it('escalates a purchase held too long instead of guessing', async () => {
    const customer = await heldPurchase();
    const strict = await boot(
      testApiConfig(DATABASE_URL as string, { reconcileStaleSeconds: 0 }),
    );
    try {
      const report = await strict.get(ReconciliationService).sweep();
      expect(report.stale).toBeGreaterThanOrEqual(1);
      // Nothing was resolved on the strength of age alone.
      expect(report.settled).toBe(0);
      expect(report.reversed).toBe(0);
    } finally {
      await strict.close();
    }

    // Escalation is a log line and a human, NOT an automatic reversal. Both
    // remaining answers can be the wrong one by this point, so the money stays
    // exactly where it is.
    expect(await statusOf(customer.userId)).toBe('reserved');
    expect(await balanceOf(customer)).toMatchObject({ pending: '350.00' });
  });
});
