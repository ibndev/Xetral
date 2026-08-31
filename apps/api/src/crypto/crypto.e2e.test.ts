import 'reflect-metadata';
import { createHmac, randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { ExpressAdapter } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import pg from 'pg';
import type { Pool } from 'pg';
import { hashPassword } from '@xetral/identity';
import { LedgerService, posting } from '@xetral/ledger';
import { ProviderTimeoutError, ProviderRejectedError } from '@xetral/providers';
import type {
  CreateAddressRequest,
  CryptoAddress,
  CryptoNetwork,
  CryptoPort,
  ProviderCryptoDeposit,
  SendRequest,
  WithdrawalQuote,
  WithdrawalReceipt,
} from '@xetral/providers';
import { money } from '@xetral/shared';
import type { Currency, Money } from '@xetral/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from '../app.module.js';
import type { ApiConfig } from '../config.js';
import { CryptoReconciliationService } from './crypto-reconciliation.service.js';
import { systemClock } from '../tokens.js';
import { testApiConfig } from '../test-support/api-config.js';
import { CryptoDepositReconciliationService } from './crypto-deposit-reconciliation.service.js';
import { SettingsService } from '../settings/settings.service.js';

/**
 * Crypto, end to end.
 *
 * Two properties are worth more than all the others here: a deposit is not
 * spendable until it is confirmed, and a withdrawal cannot be sent twice or to
 * an address the customer did not approve. Everything below is one of those.
 *
 * Requires DATABASE_URL with 001..007 applied.
 */
const DATABASE_URL = process.env['DATABASE_URL'];
if (DATABASE_URL === undefined || DATABASE_URL === '') {
  throw new Error('the crypto e2e suite needs DATABASE_URL with the migrations applied');
}

const PASSWORD = 'a-long-enough-password';
const PIN = '374915';
const WEBHOOK_SECRET = 'a-test-webhook-secret';
/** A real, well-known Tron address — a made-up string cannot pass a checksum. */
const DESTINATION = 'TMuA6YqfCeX8EhbfYEg5y7S4DqzSJireY9';

class FakeCryptoPort implements CryptoPort {
  readonly provider = 'bitnob';
  readonly sends: SendRequest[] = [];
  feeMinor = 1_000_000n;
  sendAnswer: WithdrawalReceipt | Error = {
    providerReference: 'cxw_1',
    state: 'confirmed',
    txHash: '0xsent',
    failureReason: undefined,
  };
  statusAnswer: WithdrawalReceipt | Error = {
    providerReference: 'cxw_1',
    state: 'confirmed',
    txHash: '0xsent',
    failureReason: undefined,
  };

  readonly #run = randomUUID().replace(/-/g, '').slice(0, 12);
  #seq = 0;

  async createDepositAddress(req: CreateAddressRequest): Promise<CryptoAddress> {
    this.#seq += 1;
    // Unique per run: a counter starting at 1 collides with rows a previous
    // run left behind, and (network, address) is UNIQUE.
    return {
      providerAddressId: `cxa_${this.#run}_${this.#seq}`,
      address: `T${this.#run}${String(this.#seq).padStart(21, '0')}`,
      memo: undefined,
      asset: req.asset,
      network: req.network,
    };
  }

  async quoteWithdrawal(
    _asset: Currency,
    _network: CryptoNetwork,
    _amount: Money<Currency>,
  ): Promise<WithdrawalQuote> {
    return { feeMinor: this.feeMinor, expiresAt: new Date(Date.now() + 60_000) };
  }

  async send(request: SendRequest): Promise<WithdrawalReceipt> {
    this.sends.push(request);
    if (this.sendAnswer instanceof Error) throw this.sendAnswer;
    return this.sendAnswer;
  }

  /** Deposits the provider would report for an address. Empty unless a test
   *  seeds one, so no suite is surprised by a deposit it did not create. */
  readonly deposits = new Map<string, ProviderCryptoDeposit[]>();

  async listDeposits(address: string): Promise<readonly ProviderCryptoDeposit[]> {
    return this.deposits.get(address) ?? [];
  }

  async withdrawalStatus(_reference: string): Promise<WithdrawalReceipt> {
    if (this.statusAnswer instanceof Error) throw this.statusAnswer;
    return this.statusAnswer;
  }
}

let pool: Pool;
let ledger: LedgerService;
let app: INestApplication;
let port: FakeCryptoPort;

function makeConfig(overrides: Partial<ApiConfig> = {}): ApiConfig {
  return testApiConfig(DATABASE_URL as string, {
    bitnobWebhookSecret: WEBHOOK_SECRET,
    ...overrides,
  });
}

async function boot(config: ApiConfig): Promise<INestApplication> {
  const mod = await Test.createTestingModule({
    imports: [AppModule.forRoot({ config, pool, clock: systemClock, cryptoPort: port })],
  }).compile();
  const created = mod.createNestApplication(new ExpressAdapter(), { rawBody: true });
  await created.init();
  return created;
}

interface Customer {
  userId: string;
  token: string;
}

async function onboard(kyc = true): Promise<Customer> {
  const identifier = `cx-${randomUUID()}@example.ng`;
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
    // AND THE TIER, because KYC approval sets both in ONE transaction.
    //
    // This fixture stands in for that approval, and a fixture that performs
    // half of an atomic operation is a fixture that tests a state production
    // cannot reach — here, a customer whom every provider accepts and whose
    // ceiling is still an unverified account's.
    await pool.query(`UPDATE users SET kyc_tier = 1 WHERE id = $1::bigint`, [userId]);
  }

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

/** Credits a USDT balance directly, standing in for a confirmed deposit. */
async function fundUsdt(userId: string, minor: bigint): Promise<void> {
  await ledger.post({
    idempotencyKey: `test-cx-fund:${randomUUID()}`,
    kind: 'crypto_deposit',
    occurredAt: new Date(),
    description: 'test crypto funding',
    metadata: {},
    postings: [
      posting({ kind: 'customer_wallet', ownerId: userId, currency: 'USDT' }, money(minor, 'USDT')),
      posting({ kind: 'provider_float', currency: 'USDT' }, money(-minor, 'USDT')),
    ],
  });
}

const getAddress = (customer: Customer) =>
  request(app.getHttpServer())
    .post('/v1/crypto/addresses')
    .set('Authorization', `Bearer ${customer.token}`)
    .send({ asset: 'USDT', network: 'tron' });

const withdraw = (customer: Customer, overrides: Record<string, unknown> = {}) =>
  request(app.getHttpServer())
    .post('/v1/crypto/withdrawals')
    .set('Authorization', `Bearer ${customer.token}`)
    .send({
      asset: 'USDT',
      network: 'tron',
      destination: DESTINATION,
      amount: '50.000000',
      transaction_pin: PIN,
      idempotency_key: randomUUID(),
      ...overrides,
    });

/** Sends a signed on-chain webhook, as Bitnob would. */
async function chainEvent(
  event: string,
  address: string,
  data: Record<string, unknown> = {},
  eventId = `evt_${randomUUID()}`,
) {
  const body = JSON.stringify({
    event_id: eventId,
    event,
    created_at: new Date().toISOString(),
    data: {
      id: `cxd_${randomUUID()}`,
      address,
      chain: 'tron',
      currency: 'USDT',
      amount: '250000000',
      tx_hash: `0x${randomUUID().replace(/-/g, '')}`,
      confirmations: event.endsWith('confirmed') ? 25 : 1,
      ...data,
    },
  });

  const signature = createHmac('sha512', WEBHOOK_SECRET).update(body).digest('hex');
  return request(app.getHttpServer())
    .post('/v1/webhooks/bitnob/crypto')
    .set('content-type', 'application/json')
    .set('x-bitnob-signature', signature)
    .send(body);
}

async function usdtBalance(
  customer: Customer,
): Promise<{ spendable: string; pending: string } | undefined> {
  const res = await request(app.getHttpServer())
    .get('/v1/wallets')
    .set('Authorization', `Bearer ${customer.token}`)
    .expect(200);
  return (res.body.balances as { currency: string; spendable: string; pending: string }[]).find(
    (b) => b.currency === 'USDT',
  );
}

/**
 * Every setting these assertions depend on, PINNED rather than inherited.
 *
 * The suites share one database and run in file order, and a suite that
 * narrows a limit does not put it back. `flow-velocity.e2e.test.ts` pins the
 * USDT ceiling to 10 USDT to reach it without a hundred postings — so whether
 * this file passes depended on whether it happened to run first, and it stopped
 * doing so the day two unrelated e2e files were added and the order shifted.
 *
 * The fix is the one `spending-limits.e2e.test.ts` already records: a suite
 * asserting on exact behaviour states what it needs. Inheriting is what makes a
 * green run a coincidence.
 */
const PINNED: Readonly<Record<string, string>> = {
  crypto_daily_limit_usdt_minor: '100000000000',
  crypto_daily_limit_btc_minor: '100000000000',
  crypto_withdrawal_count_hourly: '100',
};

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: DATABASE_URL, max: 8 });
  ledger = new LedgerService(pool);
  port = new FakeCryptoPort();
  app = await boot(makeConfig());

  for (const [key, value] of Object.entries(PINNED)) {
    await pool.query(`UPDATE platform_settings SET value = $2 WHERE key = $1`, [key, value]);
  }
  await app.get(SettingsService).refresh();
});

afterAll(async () => {
  await app?.close();
  await pool?.end();
});

beforeEach(() => {
  port.sends.length = 0;
  port.feeMinor = 1_000_000n;
  port.sendAnswer = {
    providerReference: 'cxw_1',
    state: 'confirmed',
    txHash: '0xsent',
    failureReason: undefined,
  };
  port.statusAnswer = port.sendAnswer;
});

describe('deposit addresses', () => {
  it('issues one and returns the SAME one afterwards', async () => {
    const customer = await onboard();
    const first = await getAddress(customer).expect(200);
    const second = await getAddress(customer).expect(200);

    expect(first.body).toMatchObject({ asset: 'USDT', network: 'tron' });
    expect(second.body.address).toBe(first.body.address);
  });

  it('refuses a customer with no provider identity', async () => {
    const customer = await onboard(false);
    const res = await getAddress(customer);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('kyc_required');
  });
});

describe('a deposit arriving on-chain', () => {
  it('is visible but NOT spendable until it confirms', async () => {
    // The property the whole two-phase design exists for. One confirmation can
    // be reorganised away; a customer who spent against it would have spent
    // money that stopped having happened.
    const customer = await onboard();
    const address = (await getAddress(customer).expect(200)).body.address as string;

    const eventId = `evt_${randomUUID()}`;
    const txHash = `0x${randomUUID().replace(/-/g, '')}`;
    const seen = await chainEvent('crypto.deposit.pending', address, { tx_hash: txHash }, eventId);
    expect(seen.status).toBe(200);

    expect(await usdtBalance(customer)).toMatchObject({
      spendable: '0.000000',
      pending: '250.000000',
    });
  });

  it('becomes spendable once confirmed', async () => {
    const customer = await onboard();
    const address = (await getAddress(customer).expect(200)).body.address as string;

    const depositId = `cxd_${randomUUID()}`;
    const txHash = `0x${randomUUID().replace(/-/g, '')}`;

    await chainEvent('crypto.deposit.pending', address, { id: depositId, tx_hash: txHash });
    await chainEvent('crypto.deposit.confirmed', address, { id: depositId, tx_hash: txHash });

    expect(await usdtBalance(customer)).toMatchObject({
      spendable: '250.000000',
      pending: '0.000000',
    });
  });

  it('credits once when a webhook is redelivered', async () => {
    const customer = await onboard();
    const address = (await getAddress(customer).expect(200)).body.address as string;

    const eventId = `evt_${randomUUID()}`;
    const depositId = `cxd_${randomUUID()}`;
    const txHash = `0x${randomUUID().replace(/-/g, '')}`;
    const payload = { id: depositId, tx_hash: txHash };

    await chainEvent('crypto.deposit.pending', address, payload, eventId);
    await chainEvent('crypto.deposit.pending', address, payload, eventId);

    expect(await usdtBalance(customer)).toMatchObject({ pending: '250.000000' });
  });

  it('refuses a deposit to an address nobody owns', async () => {
    // Unlike a naira deposit this cannot go to suspense: an address we did not
    // issue is not ours, so the money is not ours to record.
    const res = await chainEvent('crypto.deposit.pending', 'TNotAnAddressWeEverIssued12345678', {});
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('refuses a forged signature', async () => {
    const customer = await onboard();
    const address = (await getAddress(customer).expect(200)).body.address as string;
    const before = await usdtBalance(customer);

    const body = JSON.stringify({
      event_id: `evt_${randomUUID()}`,
      event: 'crypto.deposit.pending',
      created_at: new Date().toISOString(),
      data: {
        id: 'x',
        address,
        chain: 'tron',
        currency: 'USDT',
        amount: '999000000',
        tx_hash: '0xforged',
        confirmations: 1,
      },
    });

    const res = await request(app.getHttpServer())
      .post('/v1/webhooks/bitnob/crypto')
      .set('content-type', 'application/json')
      .set('x-bitnob-signature', 'deadbeef')
      .send(body);

    expect(res.status).toBe(401);
    // Compared against what it was rather than asserted absent: `/v1/wallets`
    // now returns a ZERO row for every currency the platform offers, so
    // "absent" stopped meaning "not credited" the moment crypto was on. What
    // the forged webhook must not do is MOVE anything.
    expect(await usdtBalance(customer)).toEqual(before);
  });
});

describe('withdrawing', () => {
  it('sends, and debits the amount plus the fee', async () => {
    const customer = await onboard();
    await fundUsdt(customer.userId, 100_000_000n); // 100 USDT

    const res = await withdraw(customer).expect(200);
    expect(res.body).toMatchObject({ status: 'confirmed', amount: '50.000000', fee: '1.000000' });

    // 100 - 50 - 1
    expect(await usdtBalance(customer)).toMatchObject({
      spendable: '49.000000',
      pending: '0.000000',
    });
  });

  it('REFUSES a destination whose checksum does not match', async () => {
    // The single most valuable check in this phase. A mistyped address does
    // not bounce — it delivers, permanently, to nobody.
    const customer = await onboard();
    await fundUsdt(customer.userId, 100_000_000n);

    const typo = `${DESTINATION.slice(0, -1)}8`;
    const res = await withdraw(customer, { destination: typo });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_address');
    // And nothing was sent, and nothing was reserved.
    expect(port.sends).toHaveLength(0);
    expect(await usdtBalance(customer)).toMatchObject({ spendable: '100.000000' });
  });

  it('needs a transaction PIN, and refuses a wrong one', async () => {
    const customer = await onboard();
    await fundUsdt(customer.userId, 100_000_000n);

    const missing = await withdraw(customer, { transaction_pin: undefined });
    expect(missing.status).toBe(400);

    const wrong = await withdraw(customer, { transaction_pin: '999119' });
    expect(wrong.status).toBe(401);

    expect(port.sends).toHaveLength(0);
    expect(await usdtBalance(customer)).toMatchObject({ spendable: '100.000000' });
  });

  it('refuses more than the wallet holds, and sends nothing', async () => {
    const customer = await onboard();
    await fundUsdt(customer.userId, 10_000_000n); // 10 USDT

    const res = await withdraw(customer, { amount: '50.000000' });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('insufficient_funds');
    // Money first, provider second — the order IS the protection.
    expect(port.sends).toHaveLength(0);
  });

  it('refuses when the fee moved past what the customer agreed', async () => {
    // Fees move between the quote and the request. Charging past the number
    // the customer approved is taking money on a technicality.
    const customer = await onboard();
    await fundUsdt(customer.userId, 100_000_000n);
    port.feeMinor = 5_000_000n;

    const res = await withdraw(customer, { max_fee: '1.000000' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('fee_moved');
    expect(port.sends).toHaveLength(0);
  });

  it('sends ONCE for a retried request', async () => {
    // The one duplicate in the platform that cannot be undone.
    const customer = await onboard();
    await fundUsdt(customer.userId, 200_000_000n);
    const key = randomUUID();

    const first = await withdraw(customer, { idempotency_key: key }).expect(200);
    const second = await withdraw(customer, { idempotency_key: key }).expect(200);

    expect(second.body.id).toBe(first.body.id);
    expect(port.sends).toHaveLength(1);
    expect(await usdtBalance(customer)).toMatchObject({ spendable: '149.000000' });
  });

  it('gives the money back when the provider refuses outright', async () => {
    const customer = await onboard();
    await fundUsdt(customer.userId, 100_000_000n);
    port.sendAnswer = new ProviderRejectedError('bitnob', 'destination is blacklisted', 'BLACKLISTED');

    const res = await withdraw(customer).expect(200);
    expect(res.body.status).toBe('failed');
    expect(await usdtBalance(customer)).toMatchObject({
      spendable: '100.000000',
      pending: '0.000000',
    });
  });

  it('holds the money on a TIMEOUT, sending nothing back', async () => {
    // We do not know whether it was broadcast. Reversing could refund a
    // transaction already on a chain; retrying could send twice.
    const customer = await onboard();
    await fundUsdt(customer.userId, 100_000_000n);
    port.sendAnswer = new ProviderTimeoutError('bitnob', 'no response');

    const res = await withdraw(customer).expect(200);
    expect(res.body.status).toBe('reserved');
    expect(await usdtBalance(customer)).toMatchObject({
      spendable: '49.000000',
      pending: '51.000000',
    });
  });
});

describe('reconciling a withdrawal nobody answered for', () => {
  it('settles it once the provider says it confirmed', async () => {
    const customer = await onboard();
    await fundUsdt(customer.userId, 100_000_000n);
    port.sendAnswer = new ProviderTimeoutError('bitnob', 'no response');
    await withdraw(customer).expect(200);

    port.statusAnswer = {
      providerReference: 'cxw_later',
      state: 'confirmed',
      txHash: '0xfound',
      failureReason: undefined,
    };
    const report = await app.get(CryptoReconciliationService).sweep();
    expect(report.resolved).toBeGreaterThanOrEqual(1);

    expect(await usdtBalance(customer)).toMatchObject({
      spendable: '49.000000',
      pending: '0.000000',
    });
  });

  it('returns the money once the provider says it never left', async () => {
    const customer = await onboard();
    await fundUsdt(customer.userId, 100_000_000n);
    port.sendAnswer = new ProviderTimeoutError('bitnob', 'no response');
    await withdraw(customer).expect(200);

    port.statusAnswer = {
      providerReference: 'cxw_dead',
      state: 'failed',
      txHash: undefined,
      failureReason: 'insufficient hot wallet balance',
    };
    await app.get(CryptoReconciliationService).sweep();

    expect(await usdtBalance(customer)).toMatchObject({
      spendable: '100.000000',
      pending: '0.000000',
    });
  });

  it('keeps holding when the provider cannot be reached', async () => {
    const customer = await onboard();
    await fundUsdt(customer.userId, 100_000_000n);
    port.sendAnswer = new ProviderTimeoutError('bitnob', 'no response');
    await withdraw(customer).expect(200);

    port.statusAnswer = new Error('connection refused');
    const report = await app.get(CryptoReconciliationService).sweep();
    expect(report.failed).toBeGreaterThanOrEqual(1);

    // An unreachable provider is not a failed withdrawal.
    expect(await usdtBalance(customer)).toMatchObject({ pending: '51.000000' });
  });
});

describe('reconciling a deposit nobody told us about', () => {
  it('credits pending for a deposit only the provider knows about', async () => {
    // The failure this closes: money on a chain, the provider has it, the
    // webhook was lost, and nothing was retrying. Before the sweep existed
    // this deposit never reached a balance and nothing would ever notice.
    const customer = await onboard();
    const address = (await getAddress(customer).expect(200)).body.address as string;
    const reference = `cxd_lost_${randomUUID()}`;

    port.deposits.set(address, [
      {
        providerReference: reference,
        txHash: `0x${randomUUID().replace(/-/g, '')}`,
        asset: 'USDT',
        network: 'tron',
        amountMinor: 250_000_000n,
        confirmations: 1,
        occurredAt: new Date(),
      },
    ]);

    const report = await app.get(CryptoDepositReconciliationService).sweep();
    expect(report.seen).toBeGreaterThanOrEqual(1);

    // PENDING, not spendable — the sweep must not skip the confirmation rule
    // just because it found the deposit a different way.
    const balances = await request(app.getHttpServer())
      .get('/v1/wallets')
      .set('Authorization', `Bearer ${customer.token}`)
      .expect(200);
    const usdt = balances.body.balances.find((b: { currency: string }) => b.currency === 'USDT');
    expect(usdt?.pending).toBe('250.000000');
    expect(usdt?.spendable ?? '0.000000').toBe('0.000000');
  });

  it('a late webhook for a swept deposit does not credit it twice', async () => {
    // The reason both paths key on the DEPOSIT rather than the webhook
    // delivery. The NGN rail had this exact bug: the sweep keyed on data.id
    // and the webhook on event_id, so a sweep followed by a redelivery
    // credited the customer twice.
    const customer = await onboard();
    const address = (await getAddress(customer).expect(200)).body.address as string;
    const reference = `cxd_late_${randomUUID()}`;
    const txHash = `0x${randomUUID().replace(/-/g, '')}`;

    port.deposits.set(address, [
      {
        providerReference: reference,
        txHash,
        asset: 'USDT',
        network: 'tron',
        amountMinor: 100_000_000n,
        confirmations: 1,
        occurredAt: new Date(),
      },
    ]);

    await app.get(CryptoDepositReconciliationService).sweep();
    const afterSweep = await pendingUsdt(customer);

    // Same deposit, a webhook delivery the sweep never saw.
    await chainEvent(
      'crypto.deposit.pending',
      address,
      { id: reference, tx_hash: txHash, amount: '100000000', confirmations: 1 },
      `evt_${randomUUID()}`,
    );

    expect(await pendingUsdt(customer)).toBe(afterSweep);
  });

  it('promotes a held deposit whose confirmation event never arrived', async () => {
    // The other half. The seen event landed, the confirmation did not, and
    // the customer's money would sit unspendable for ever.
    const customer = await onboard();
    const address = (await getAddress(customer).expect(200)).body.address as string;
    const reference = `cxd_stuck_${randomUUID()}`;
    const txHash = `0x${randomUUID().replace(/-/g, '')}`;

    await chainEvent(
      'crypto.deposit.pending',
      address,
      { id: reference, tx_hash: txHash, amount: '75000000', confirmations: 1 },
    );
    expect(await pendingUsdt(customer)).toBe('75.000000');

    // The provider now reports it well past the threshold.
    port.deposits.set(address, [
      {
        providerReference: reference,
        txHash,
        asset: 'USDT',
        network: 'tron',
        amountMinor: 75_000_000n,
        confirmations: 200,
        occurredAt: new Date(),
      },
    ]);

    const report = await app.get(CryptoDepositReconciliationService).sweep();
    expect(report.confirmed).toBeGreaterThanOrEqual(1);

    const balances = await request(app.getHttpServer())
      .get('/v1/wallets')
      .set('Authorization', `Bearer ${customer.token}`)
      .expect(200);
    const usdt = balances.body.balances.find((b: { currency: string }) => b.currency === 'USDT');
    expect(usdt?.spendable).toBe('75.000000');
    expect(usdt?.pending).toBe('0.000000');
  });
});

async function pendingUsdt(customer: Customer): Promise<string> {
  const res = await request(app.getHttpServer())
    .get('/v1/wallets')
    .set('Authorization', `Bearer ${customer.token}`)
    .expect(200);
  const usdt = res.body.balances.find((b: { currency: string }) => b.currency === 'USDT');
  return (usdt?.pending as string | undefined) ?? '0.000000';
}
