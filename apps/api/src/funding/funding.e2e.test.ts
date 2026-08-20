import 'reflect-metadata';
import { createHmac, randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { ExpressAdapter } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import pg from 'pg';
import type { Pool } from 'pg';
import { hashPassword } from '@xetral/identity';
import { ProviderTimeoutError } from '@xetral/providers';
import type {
  CreateVirtualAccountRequest,
  FundingPort,
  ProviderDeposit,
  VirtualAccount,
} from '@xetral/providers';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from '../app.module.js';
import type { ApiConfig } from '../config.js';
import { DepositReconciliationService } from './deposit-reconciliation.service.js';
import { systemClock } from '../tokens.js';
import { testApiConfig } from '../test-support/api-config.js';

/**
 * The funding rail, end to end — the first money that ENTERS the platform.
 *
 * Everything before this moved balances that a test helper conjured. These
 * tests conjure nothing: a webhook arrives, is verified, and a customer's
 * spendable balance changes. That is the whole phase.
 *
 * Requires DATABASE_URL with 001..006 applied.
 */
const DATABASE_URL = process.env['DATABASE_URL'];
if (DATABASE_URL === undefined || DATABASE_URL === '') {
  throw new Error('the funding e2e suite needs DATABASE_URL with the migrations applied');
}

const PASSWORD = 'a-long-enough-password';
const WEBHOOK_SECRET = 'a-test-webhook-secret';

/** A stand-in for Bitnob. Deterministic account numbers so a test can assert
 *  on the exact one a customer would be shown. */
class FakeFundingPort implements FundingPort {
  readonly provider = 'bitnob';
  readonly created: CreateVirtualAccountRequest[] = [];
  /**
   * Keyed by account, as the real endpoint is.
   *
   * A flat list here would return the same deposit for EVERY account the sweep
   * walks, and the first account processed would be credited with money that
   * belongs to another customer — which is both a wrong test and, if the real
   * adapter ever ignored the id, a very real bug.
   */
  readonly deposits = new Map<string, ProviderDeposit[]>();
  failNextWith: Error | undefined;

  /**
   * Unique per RUN, not per instance.
   *
   * A counter starting at 1 collides with the rows a previous run left in a
   * shared database — and the collision is on `provider_account_id`, which
   * surfaces as a 500 that looks like a bug in the issuing path and is not.
   * The same lesson the ledger suites learned about synthetic owner ids.
   */
  readonly #run = randomUUID().slice(0, 8);
  #seq = 0;

  async createVirtualAccount(req: CreateVirtualAccountRequest): Promise<VirtualAccount> {
    this.created.push(req);
    if (this.failNextWith !== undefined) {
      const error = this.failNextWith;
      this.failNextWith = undefined;
      throw error;
    }
    this.#seq += 1;
    return {
      providerAccountId: `bva_${this.#run}_${this.#seq}`,
      // Ten digits, unique per run: derived from the run id so two runs cannot
      // both claim a NUBAN, which is UNIQUE across the whole table.
      accountNumber: String(
        1_000_000_000 + (Number.parseInt(this.#run, 16) % 900_000_000) + this.#seq,
      ),
      bankName: 'Providus Bank',
      accountName: 'XETRAL/TEST CUSTOMER',
      currency: 'NGN',
      active: true,
    };
  }

  async getVirtualAccount(id: string): Promise<VirtualAccount> {
    return {
      providerAccountId: id,
      accountNumber: '1000000001',
      bankName: 'Providus Bank',
      accountName: 'XETRAL/TEST CUSTOMER',
      currency: 'NGN',
      active: true,
    };
  }

  async listDeposits(providerAccountId: string): Promise<readonly ProviderDeposit[]> {
    return this.deposits.get(providerAccountId) ?? [];
  }
}

let pool: Pool;
let app: INestApplication;
let port: FakeFundingPort;

function makeConfig(overrides: Partial<ApiConfig> = {}): ApiConfig {
  return testApiConfig(DATABASE_URL as string, {
    bitnobWebhookSecret: WEBHOOK_SECRET,
    ...overrides,
  });
}

async function boot(config: ApiConfig): Promise<INestApplication> {
  const mod = await Test.createTestingModule({
    imports: [AppModule.forRoot({ config, pool, clock: systemClock, fundingPort: port })],
  }).compile();
  // rawBody, because the signature covers the exact bytes Bitnob sent.
  const created = mod.createNestApplication(new ExpressAdapter(), { rawBody: true });
  await created.init();
  return created;
}

interface Customer {
  userId: string;
  token: string;
}

/** Onboards a customer. `kyc` controls whether they have a Bitnob identity —
 *  without one, no bank account can be issued. */
async function onboard(kyc = true): Promise<Customer> {
  const identifier = `fund-${randomUUID()}@example.ng`;
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

  if (kyc) {
    await pool.query(
      `INSERT INTO provider_customers (user_id, provider, provider_customer_id)
       VALUES ($1::bigint, 'bitnob', $2)`,
      [userId, `cus_${userId}`],
    );
  }

  const login = await request(app.getHttpServer())
    .post('/v1/auth/login')
    .send({
      identifier,
      password: PASSWORD,
      device: { fingerprint: `fp-${randomUUID()}`, platform: 'android' },
    })
    .expect(200);

  return { userId, token: login.body.access_token as string };
}

const getAccount = (customer: Customer) =>
  request(app.getHttpServer())
    .post('/v1/funding/account')
    .set('Authorization', `Bearer ${customer.token}`)
    .send({});

/** Sends a signed deposit webhook, exactly as Bitnob would. */
async function deposit(
  overrides: Record<string, unknown> = {},
  data: Record<string, unknown> = {},
) {
  const body = JSON.stringify({
    event_id: `evt_${randomUUID()}`,
    event: 'virtualaccount.deposit.completed',
    created_at: new Date().toISOString(),
    data: {
      id: `dep_${randomUUID()}`,
      amount: '5000000',
      currency: 'NGN',
      sender_name: 'ADEBAYO OLUWASEUN',
      sender_bank: 'GTBank',
      sender_account_number: '0987654321',
      ...data,
    },
    ...overrides,
  });

  const signature = createHmac('sha512', WEBHOOK_SECRET).update(body).digest('hex');

  return request(app.getHttpServer())
    .post('/v1/webhooks/bitnob/deposits')
    .set('content-type', 'application/json')
    .set('x-bitnob-signature', signature)
    .send(body);
}

async function balanceOf(customer: Customer): Promise<string> {
  const res = await request(app.getHttpServer())
    .get('/v1/wallets')
    .set('Authorization', `Bearer ${customer.token}`)
    .expect(200);
  return res.body.balances[0]?.spendable ?? '0.00';
}

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: DATABASE_URL, max: 8 });
  port = new FakeFundingPort();
  app = await boot(makeConfig());
});

afterAll(async () => {
  await app?.close();
  await pool?.end();
});

beforeEach(() => {
  port.created.length = 0;
  port.deposits.clear();
  port.failNextWith = undefined;
});

describe('getting an account number', () => {
  it('issues one, and returns the SAME one on every later call', async () => {
    // The most important property here. A customer saves the number as a bank
    // beneficiary; a second account would receive money nobody is watching.
    const customer = await onboard();

    const first = await getAccount(customer).expect(200);
    expect(first.body).toMatchObject({ bank_name: 'Providus Bank', currency: 'NGN' });
    expect(first.body.account_number).toMatch(/^[0-9]{10}$/);

    const second = await getAccount(customer).expect(200);
    expect(second.body.account_number).toBe(first.body.account_number);
    // And the provider was asked exactly once.
    expect(port.created).toHaveLength(1);
  });

  it('refuses a customer with no provider identity', async () => {
    // Issuing a Nigerian bank account to an unidentified person is not a thing
    // we may do. Registering them as a side effect of "add money" would hide a
    // regulatory step behind a convenience.
    const customer = await onboard(false);
    const res = await getAccount(customer);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('kyc_required');
  });

  it('does not issue a second account after a timeout', async () => {
    const customer = await onboard();
    port.failNextWith = new ProviderTimeoutError('bitnob', 'no response');

    const failed = await getAccount(customer);
    expect(failed.status).toBe(503);

    // The retry carries the SAME idempotency key, so the provider returns the
    // account it already made rather than making another.
    const retried = await getAccount(customer).expect(200);
    expect(retried.body.account_number).toMatch(/^[0-9]{10}$/);
    expect(port.created[0]?.idempotencyKey).toBe(port.created[1]?.idempotencyKey);
  });

  it('needs a session', async () => {
    const res = await request(app.getHttpServer()).post('/v1/funding/account').send({});
    expect(res.status).toBe(401);
  });
});

describe('receiving money', () => {
  it('credits the customer wallet', async () => {
    const customer = await onboard();
    const account = await getAccount(customer).expect(200);
    expect(await balanceOf(customer)).toBe('0.00');

    expect((await deposit({}, { account_number: account.body.account_number })).status).toBe(200);

    // N50,000.00 arrived and is spendable.
    expect(await balanceOf(customer)).toBe('50000.00');
  });

  it('records who sent it, for compliance', async () => {
    const customer = await onboard();
    const account = await getAccount(customer).expect(200);
    expect((await deposit({}, { account_number: account.body.account_number })).status).toBe(200);

    const res = await request(app.getHttpServer())
      .get('/v1/funding/deposits')
      .set('Authorization', `Bearer ${customer.token}`)
      .expect(200);

    expect(res.body.deposits[0]).toMatchObject({
      amount: '50000.00',
      sender_name: 'ADEBAYO OLUWASEUN',
      sender_bank: 'GTBank',
    });
  });

  it('credits ONCE when the webhook is redelivered', async () => {
    // The single most dangerous replay in the system: this webhook creates
    // money rather than moving it.
    const customer = await onboard();
    const account = await getAccount(customer).expect(200);

    const eventId = `evt_${randomUUID()}`;
    const depositId = `dep_${randomUUID()}`;
    const payload = { account_number: account.body.account_number, id: depositId };

    expect((await deposit({ event_id: eventId }, payload)).status).toBe(200);
    // Redelivery must be a SUCCESS, not an error — Bitnob retries anything
    // non-2xx, for ever.
    expect((await deposit({ event_id: eventId }, payload)).status).toBe(200);

    expect(await balanceOf(customer)).toBe('50000.00');
  });

  it('refuses a forged signature and credits nothing', async () => {
    const customer = await onboard();
    const account = await getAccount(customer).expect(200);

    const body = JSON.stringify({
      event_id: `evt_${randomUUID()}`,
      event: 'virtualaccount.deposit.completed',
      created_at: new Date().toISOString(),
      data: {
        id: `dep_${randomUUID()}`,
        account_number: account.body.account_number,
        amount: '99900000',
        currency: 'NGN',
      },
    });

    const res = await request(app.getHttpServer())
      .post('/v1/webhooks/bitnob/deposits')
      .set('content-type', 'application/json')
      .set('x-bitnob-signature', 'deadbeef')
      .send(body);

    // 401, not 500: a forged webhook is a client error. A 500 would page
    // somebody over a stranger's probe and tell the sender we are broken.
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('invalid_signature');
    expect(await balanceOf(customer)).toBe('0.00');
  });
});

describe('money we cannot attribute', () => {
  it('holds it in suspense rather than dropping it', async () => {
    // A deposit naming an account we have never issued. The money arrived
    // whatever we can work out about it, and discarding the event is how a
    // real transfer disappears from a real person's life.
    const res = await deposit(
      {},
      { virtual_account_id: 'bva_nonexistent', account_number: '9999999999' },
    );
    expect(res.status).toBe(200);

    const held = await pool.query<{ status: string; suspense_reason: string }>(
      `SELECT status, suspense_reason FROM deposits
        WHERE status = 'suspense' ORDER BY id DESC LIMIT 1`,
    );
    expect(held.rows[0]?.status).toBe('suspense');
    expect(held.rows[0]?.suspense_reason).toContain('no virtual account');
  });
});

describe('the deposit ceiling', () => {
  it('refuses to credit an amount above it, and holds it instead', async () => {
    // The control that makes a misread amount recoverable. A unit
    // misconfiguration reads any realistic transfer 100x too large, so the
    // FIRST wrong deposit is held rather than spent.
    const customer = await onboard();
    const account = await getAccount(customer).expect(200);

    const res = await deposit(
      {},
      { account_number: account.body.account_number, amount: '900000000' },
    );
    expect(res.status).toBe(200);

    // Not credited.
    expect(await balanceOf(customer)).toBe('0.00');

    const held = await pool.query<{ suspense_reason: string }>(
      `SELECT suspense_reason FROM deposits WHERE status = 'suspense' ORDER BY id DESC LIMIT 1`,
    );
    expect(held.rows[0]?.suspense_reason).toContain('above ceiling');
  });
});

describe('a webhook that never arrived', () => {
  it('is found by reconciliation and credited once', async () => {
    const customer = await onboard();
    await getAccount(customer).expect(200);

    const accountRow = await pool.query<{ provider_account_id: string }>(
      `SELECT provider_account_id FROM virtual_accounts WHERE user_id = $1::bigint`,
      [customer.userId],
    );
    expect(accountRow.rows[0]).toBeDefined();

    // The provider knows about a deposit we never heard of, on THIS account.
    const reference = `dep_lost_${randomUUID()}`;
    const providerAccountId = accountRow.rows[0]?.provider_account_id ?? '';
    port.deposits.set(providerAccountId, [
      {
        providerReference: reference,
        amountMinor: 2_500_000n,
        currency: 'NGN',
        senderName: 'CHIDI N.',
        senderBank: 'Access Bank',
        senderAccount: '0011223344',
        occurredAt: new Date(),
      },
    ]);

    const report = await app.get(DepositReconciliationService).sweep();
    expect(report.credited).toBeGreaterThanOrEqual(1);
    expect(await balanceOf(customer)).toBe('25000.00');

    // And a late webhook for the same deposit must not credit it again: the
    // sweep used the key the webhook would have used.
    expect((await deposit({ event_id: `bitnob-late` }, { id: reference })).status).toBe(200);
    expect(await balanceOf(customer)).toBe('25000.00');
  });

  it('does not re-credit a deposit it already knows about', async () => {
    const customer = await onboard();
    const account = await getAccount(customer).expect(200);
    expect((await deposit({}, { account_number: account.body.account_number })).status).toBe(200);
    expect(await balanceOf(customer)).toBe('50000.00');

    port.deposits.clear();
    const report = await app.get(DepositReconciliationService).sweep();
    expect(report.failed).toBe(0);
    expect(await balanceOf(customer)).toBe('50000.00');
  });
});
