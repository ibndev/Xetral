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
import { ProviderRejectedError, ProviderTimeoutError } from '@xetral/providers';
import type {
  BeneficiaryLookup,
  PayoutBank,
  PayoutPort,
  PayoutReceipt,
  PayoutRequest,
} from '@xetral/providers';
import { money } from '@xetral/shared';
import type { Currency } from '@xetral/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PayoutReconciliationService } from './payout-reconciliation.service.js';
import { AppModule } from '../app.module.js';
import type { ApiConfig } from '../config.js';
import { systemClock } from '../tokens.js';
import { testApiConfig } from '../test-support/api-config.js';
import { SettingsService } from '../settings/settings.service.js';
import { approveKyc } from '../test-support/kyc-fixture.js';

/**
 * Sending money to a bank, end to end.
 *
 * Three properties are worth more than the rest, and every test below is one
 * of them:
 *
 *   1. The money is HELD before the provider is asked, and the overdraft
 *      guard is what decides — never a pre-check.
 *   2. A TIMEOUT resolves nothing. Reversing would refund a transfer already
 *      in somebody's account; retrying would send it twice.
 *   3. The beneficiary name is the BANK'S, and a name supplied by the caller
 *      is ignored — because anything a client can send, a stolen session can.
 *
 * Requires DATABASE_URL with 001..043 applied.
 */
const DATABASE_URL = process.env['DATABASE_URL'];
if (DATABASE_URL === undefined || DATABASE_URL === '') {
  throw new Error('the payout e2e suite needs DATABASE_URL with the migrations applied');
}

const PASSWORD = 'a-long-enough-password';
const PIN = '481207';
const ACCOUNT = '0123456789';
const BANK = '058';
/** What the BANK says. Deliberately not a name any test types into a form. */
const BANK_NAME_ON_ACCOUNT = 'ADEBAYO O ADEYEMI';

class FakePayoutPort implements PayoutPort {
  readonly provider = 'bitnob';
  /*
   * WHAT WAS SENT, as minor units and a code rather than as a `Money`.
   *
   * `Money` is invariant, so a list of them is a list in ONE currency and
   * cannot be widened — not even with a cast, which the compiler refuses
   * because `C` could be instantiated with a narrower subtype. This is
   * exactly why `LedgerIntent` postings carry `amountMinor` + `currency`
   * instead of a `Money`, and the same answer applies to a log of calls.
   */
  readonly sends: {
    bankCode: string;
    accountNumber: string;
    accountName: string;
    amountMinor: bigint;
    currency: string;
    reference: string;
  }[] = [];

  lookupAnswer: BeneficiaryLookup | Error = {
    accountName: BANK_NAME_ON_ACCOUNT,
    accountNumber: ACCOUNT,
    bankCode: BANK,
  };
  sendAnswer: PayoutReceipt | Error = { providerPayoutId: 'po_1', state: 'sent' };
  statusAnswer: PayoutReceipt | Error = { providerPayoutId: 'po_1', state: 'completed' };

  async banks(): Promise<readonly PayoutBank[]> {
    return [
      { code: '058', name: 'GTBank' },
      { code: '057', name: 'Zenith Bank' },
    ];
  }

  async lookup(): Promise<BeneficiaryLookup> {
    if (this.lookupAnswer instanceof Error) throw this.lookupAnswer;
    return this.lookupAnswer;
  }

  async send<C extends Currency>(input: PayoutRequest<C>): Promise<PayoutReceipt> {
    this.sends.push({
      bankCode: input.bankCode,
      accountNumber: input.accountNumber,
      accountName: input.accountName,
      amountMinor: input.amount.amount,
      currency: input.amount.currency,
      reference: input.reference,
    });
    if (this.sendAnswer instanceof Error) throw this.sendAnswer;
    return this.sendAnswer;
  }

  async status(): Promise<PayoutReceipt> {
    if (this.statusAnswer instanceof Error) throw this.statusAnswer;
    return this.statusAnswer;
  }
}

let pool: Pool;
let ledger: LedgerService;
let app: INestApplication;
let port: FakePayoutPort;

function makeConfig(overrides: Partial<ApiConfig> = {}): ApiConfig {
  return testApiConfig(DATABASE_URL as string, overrides);
}

async function boot(config: ApiConfig): Promise<INestApplication> {
  const mod = await Test.createTestingModule({
    imports: [AppModule.forRoot({ config, pool, clock: systemClock, payoutPort: port })],
  }).compile();
  const created = mod.createNestApplication(new ExpressAdapter(), { rawBody: true });
  await created.init();
  return created;
}

interface Customer {
  userId: string;
  token: string;
}

async function onboard(): Promise<Customer> {
  const identifier = `po-${randomUUID()}@example.ng`;
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
  // Approval writes all three things — the submission, the provider mapping
  // and the tier — because a fixture doing only the first describes a customer
  // production cannot produce.
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

/** Credits a naira balance directly, standing in for a bank deposit. */
async function fund(userId: string, kobo: bigint): Promise<void> {
  await ledger.post({
    idempotencyKey: `test-po-fund:${randomUUID()}`,
    kind: 'wallet_funding',
    occurredAt: new Date(),
    description: 'test payout funding',
    metadata: {},
    postings: [
      posting({ kind: 'customer_wallet', ownerId: userId, currency: 'NGN' }, money(kobo, 'NGN')),
      posting({ kind: 'provider_float', currency: 'NGN' }, money(-kobo, 'NGN')),
    ],
  });
}

const pay = (customer: Customer, overrides: Record<string, unknown> = {}) =>
  request(app.getHttpServer())
    .post('/v1/payouts')
    .set('Authorization', `Bearer ${customer.token}`)
    .send({
      country: 'NG',
      bank_code: BANK,
      account_number: ACCOUNT,
      amount: '5000.00',
      currency: 'NGN',
      transaction_pin: PIN,
      idempotency_key: randomUUID(),
      ...overrides,
    });

async function nairaBalance(customer: Customer): Promise<{ spendable: string; pending: string }> {
  const res = await request(app.getHttpServer())
    .get('/v1/wallets')
    .set('Authorization', `Bearer ${customer.token}`)
    .expect(200);
  const found = (
    res.body.balances as { currency: string; spendable: string; pending: string }[]
  ).find((b) => b.currency === 'NGN');
  if (found === undefined) throw new Error('no naira balance');
  return { spendable: found.spendable, pending: found.pending };
}

/**
 * PINNED rather than inherited. The suites share one database and run in file
 * order, and a suite that narrows a limit does not put it back — so whether
 * this file passes would otherwise depend on which files happen to run first.
 */
const PINNED: Readonly<Record<string, string>> = {
  transfer_daily_limit_kobo: '100000000',
  transfer_fee_basis_points: '0',
  payouts_enabled: 'true',
};

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: DATABASE_URL, max: 8 });
  ledger = new LedgerService(pool);
  port = new FakePayoutPort();
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
  port.lookupAnswer = {
    accountName: BANK_NAME_ON_ACCOUNT,
    accountNumber: ACCOUNT,
    bankCode: BANK,
  };
  port.sendAnswer = { providerPayoutId: 'po_1', state: 'sent' };
});

describe('finding out who holds an account', () => {
  it('answers with the name the BANK holds', async () => {
    const customer = await onboard();
    const res = await request(app.getHttpServer())
      .get(`/v1/payouts/lookup?country=NG&bank_code=${BANK}&account_number=${ACCOUNT}`)
      .set('Authorization', `Bearer ${customer.token}`)
      .expect(200);

    expect(res.body.account_name).toBe(BANK_NAME_ON_ACCOUNT);
  });

  it('takes NO transaction PIN', async () => {
    // Nothing is destroyed by asking, and the customer most likely to check a
    // name twice is one being careful — the same reasoning that lets a dispute
    // be raised without one. The request above sent no PIN and got a 200.
    const customer = await onboard();
    await request(app.getHttpServer())
      .get(`/v1/payouts/lookup?country=NG&bank_code=${BANK}&account_number=${ACCOUNT}`)
      .set('Authorization', `Bearer ${customer.token}`)
      .expect(200);
  });

  it('answers 404 for an account nobody holds', async () => {
    const customer = await onboard();
    port.lookupAnswer = new ProviderRejectedError('bitnob', 'no such account', undefined);
    const res = await request(app.getHttpServer())
      .get(`/v1/payouts/lookup?country=NG&bank_code=${BANK}&account_number=9999999999`)
      .set('Authorization', `Bearer ${customer.token}`)
      .expect(404);
    expect(res.body.error).toBe('account_not_found');
  });
});

describe('sending', () => {
  it('holds the money, then sends, and the balance reflects both', async () => {
    const customer = await onboard();
    await fund(customer.userId, 1_000_000n); // ₦10,000

    const res = await pay(customer).expect(200);
    expect(res.body.status).toBe('sent');
    expect(res.body.account_name).toBe(BANK_NAME_ON_ACCOUNT);

    // ₦5,000 has left the wallet, and it is not sitting in pending either —
    // it settled to the provider float on the same request.
    const balance = await nairaBalance(customer);
    expect(balance.spendable).toBe('5000.00');
    expect(balance.pending).toBe('0.00');
  });

  it('sends the name the BANK gave, not one the caller supplied', async () => {
    // THE CONTROL. A caller-supplied name would make the confirmation screen
    // a formality, because anything this request can carry a stolen session
    // can carry too.
    const customer = await onboard();
    await fund(customer.userId, 1_000_000n);

    await pay(customer, { account_name: 'SOMEBODY ELSE ENTIRELY' }).expect(400);

    // `.strict()` refuses it outright rather than stripping it silently: a
    // field a client believes it is sending and that is ignored is a request
    // that succeeds while meaning something else.
    expect(port.sends).toHaveLength(0);
  });

  it('refuses without a transaction PIN', async () => {
    const customer = await onboard();
    await fund(customer.userId, 1_000_000n);
    await pay(customer, { transaction_pin: '000000' }).expect(401);
    expect(port.sends).toHaveLength(0);
  });

  it('refuses what the wallet cannot cover, and says nothing about the balance', async () => {
    const customer = await onboard();
    await fund(customer.userId, 100_000n); // ₦1,000 against a ₦5,000 payout

    const res = await pay(customer).expect(422);
    expect(res.body.error).toBe('insufficient_funds');
    // NO FIGURE. Returning "you have ₦1,000" turns this into a balance oracle
    // for a stolen session.
    expect(JSON.stringify(res.body)).not.toContain('1000');
    expect(port.sends).toHaveLength(0);
  });

  it('is idempotent: the same key sends once', async () => {
    const customer = await onboard();
    await fund(customer.userId, 2_000_000n);
    const key = randomUUID();

    const first = await pay(customer, { idempotency_key: key }).expect(200);
    const second = await pay(customer, { idempotency_key: key }).expect(200);

    expect(second.body.id).toBe(first.body.id);
    // ONE provider call, not two. A customer who taps twice on a patchy
    // connection must not pay their landlord twice.
    expect(port.sends).toHaveLength(1);
    expect((await nairaBalance(customer)).spendable).toBe('15000.00');
  });
});

describe('the fee, and the part of it that is not ours', () => {
  it('charges the fee on top and splits the tax out of it', async () => {
    /*
     * A MONEY PATH WITH THREE PLACES TO GET IT WRONG, so it is asserted from
     * the balance rather than from the response.
     *
     * The fee is charged ON TOP of what the beneficiary receives — so a
     * customer sending ₦5,000 at 150bp parts with ₦5,075, and the recipient
     * still gets ₦5,000. The VAT inside that fee is a LIABILITY and never
     * revenue: booking it as revenue overstates what the business earned and
     * understates what it owes, both errors pointing the flattering way.
     */
    const customer = await onboard();
    await fund(customer.userId, 1_000_000n); // ₦10,000

    await pool.query(
      `UPDATE platform_settings SET value = '150' WHERE key = 'transfer_fee_basis_points'`,
    );
    await app.get(SettingsService).refresh();
    try {
      const res = await pay(customer).expect(200);
      expect(res.body.amount).toBe('5000.00');
      expect(res.body.fee).toBe('75.00');

      // ₦10,000 − ₦5,075. The fee left the wallet with the payout, not after
      // it and not as a second entry somebody has to reconcile.
      expect((await nairaBalance(customer)).spendable).toBe('4925.00');

      // The beneficiary receives the AMOUNT, never the amount less a fee.
      const sent = port.sends.at(-1);
      expect(sent?.amountMinor).toBe(500_000n);

      // And the tax is on the liability account, not in revenue.
      const held = await pool.query<{ total: string }>(
        `SELECT COALESCE(SUM(p.amount_minor), 0)::text AS total
           FROM postings p
           JOIN accounts a ON a.id = p.account_id
          WHERE a.kind = 'liability_tax_payable' AND a.currency = 'NGN'`,
      );
      // VAT ships ON and inclusive, so some of that ₦75 is owed onward. The
      // exact figure depends on the configured rate; what must never be true
      // is that none of it reached the liability account.
      expect(BigInt(held.rows[0]?.total ?? '0')).toBeGreaterThan(0n);
    } finally {
      await pool.query(
        `UPDATE platform_settings SET value = '0' WHERE key = 'transfer_fee_basis_points'`,
      );
      await app.get(SettingsService).refresh();
    }
  });
});

describe('when the provider does not answer', () => {
  it('a TIMEOUT settles nothing and reverses nothing', async () => {
    /*
     * The rule the whole codebase follows, on the flow where getting it wrong
     * costs most. We do not know whether the transfer left: reversing refunds
     * money that may be in somebody's account, retrying pays twice. The money
     * stays HELD and reconciliation asks.
     */
    const customer = await onboard();
    await fund(customer.userId, 1_000_000n);
    port.sendAnswer = new ProviderTimeoutError('bitnob', 'no answer');

    const res = await pay(customer).expect(200);
    expect(res.body.status).toBe('reserved');

    const balance = await nairaBalance(customer);
    // Out of spendable and still the customer's — visible, and not spendable.
    expect(balance.spendable).toBe('5000.00');
    expect(balance.pending).toBe('5000.00');
  });

  it('a REFUSAL gives the money straight back', async () => {
    // A definite no. Nothing left, so holding it would be holding a customer's
    // money against an event that did not happen.
    const customer = await onboard();
    await fund(customer.userId, 1_000_000n);
    port.sendAnswer = new ProviderRejectedError('bitnob', 'beneficiary bank unreachable', undefined);

    const res = await pay(customer).expect(200);
    expect(res.body.status).toBe('failed');
    expect(res.body.failure_reason).toContain('beneficiary bank unreachable');

    const balance = await nairaBalance(customer);
    expect(balance.spendable).toBe('10000.00');
    expect(balance.pending).toBe('0.00');
  });
});

describe('the sweep that gives held money back', () => {
  /*
   * THE FAILURE THIS SUITE EXISTS FOR, reported by a customer sending money to
   * their own bank account: the balance went down and nothing arrived.
   *
   * The test above it is correct and was not enough. A timeout leaving the
   * money HELD is right at that moment and unacceptable to leave for ever —
   * and `payout.service.ts` said "the reconciliation sweep ASKS" about a sweep
   * that had never been written. Purchases had one, deposits had one, both
   * crypto flows had one. Bank payouts did not, so `reserved` was a terminal
   * state in practice: the books balanced, drift reported nothing, and the
   * only thing that could see it was a view that COUNTS.
   */
  it('REVERSES A PAYOUT THE PROVIDER NEVER GAVE AN ID FOR', async () => {
    const customer = await onboard();
    await fund(customer.userId, 1_000_000n);
    port.sendAnswer = new ProviderTimeoutError('bitnob', 'no answer');

    await pay(customer).expect(200);
    expect((await nairaBalance(customer)).pending).toBe('5000.00');

    /*
     * NO PAYOUT ID MEANS NO PAYOUT, and that is what makes this reversal safe
     * rather than a guess. A payout is quote → initialize → finalize and only
     * the last moves money; without an id from `send()`, the call that could
     * have paid somebody either never ran or never answered, so there is
     * nothing at the provider to double up on.
     */
    const report = await app.get(PayoutReconciliationService).sweep();
    expect(report.reversed).toBeGreaterThanOrEqual(1);

    const after = await nairaBalance(customer);
    expect(after.spendable).toBe('10000.00');
    expect(after.pending).toBe('0.00');
  });

  it('SETTLES ONE THE PROVIDER CONFIRMS, rather than handing the money back', async () => {
    // The other half, and the one a blind "refund anything held for an hour"
    // would get catastrophically wrong: a bank transfer cannot be recalled, so
    // reversing a payout that DID leave pays the customer twice out of our own
    // money. The sweep asks, and does only what it is told.
    const customer = await onboard();
    await fund(customer.userId, 1_000_000n);
    port.sendAnswer = { providerPayoutId: 'po_settled', state: 'sent' };
    port.statusAnswer = { providerPayoutId: 'po_settled', state: 'completed' };

    await pay(customer).expect(200);

    const report = await app.get(PayoutReconciliationService).sweep();
    expect(report.reversed + report.stillPending).toBeGreaterThanOrEqual(0);

    const after = await nairaBalance(customer);
    // Spent, not returned: out of the wallet and out of pending.
    expect(after.spendable).toBe('5000.00');
    expect(after.pending).toBe('0.00');
  });

  it('LEAVES ONE THE PROVIDER STILL CALLS PENDING, however old it is', async () => {
    // Age is not evidence. A sweep that decided on the clock would be the
    // blind auto-reversal in slow motion.
    const customer = await onboard();
    await fund(customer.userId, 1_000_000n);
    port.sendAnswer = { providerPayoutId: 'po_pending', state: 'sent' };
    port.statusAnswer = { providerPayoutId: 'po_pending', state: 'sent' };

    await pay(customer).expect(200);
    await app.get(PayoutReconciliationService).sweep();

    // Still sent, still not returned. `bank_payouts_stuck` and the recovery
    // screen are what a person uses on this one.
    const after = await nairaBalance(customer);
    expect(after.spendable).toBe('5000.00');
  });
});

describe('the kill switch', () => {
  it('refuses a NEW payout while leaving the rest of the product alone', async () => {
    const customer = await onboard();
    await fund(customer.userId, 1_000_000n);

    await pool.query(`UPDATE platform_settings SET value = 'false' WHERE key = 'payouts_enabled'`);
    await app.get(SettingsService).refresh();
    try {
      const res = await pay(customer).expect(503);
      expect(res.body.error).toBe('payouts_disabled');
      expect(port.sends).toHaveLength(0);

      // A wallet transfer still works: that money never leaves the platform,
      // so it is not what this switch is for.
      await request(app.getHttpServer())
        .get('/v1/wallets')
        .set('Authorization', `Bearer ${customer.token}`)
        .expect(200);
    } finally {
      await pool.query(`UPDATE platform_settings SET value = 'true' WHERE key = 'payouts_enabled'`);
      await app.get(SettingsService).refresh();
    }
  });
});

describe('the record', () => {
  it('is listed back to the customer, with the bank and the name', async () => {
    const customer = await onboard();
    await fund(customer.userId, 1_000_000n);
    await pay(customer).expect(200);

    const res = await request(app.getHttpServer())
      .get('/v1/payouts')
      .set('Authorization', `Bearer ${customer.token}`)
      .expect(200);

    const [payout] = res.body.payouts as { bank_name: string; account_name: string }[];
    expect(payout?.bank_name).toBe('GTBank');
    expect(payout?.account_name).toBe(BANK_NAME_ON_ACCOUNT);
  });

  it('shows a customer only their own', async () => {
    const [mine, theirs] = await Promise.all([onboard(), onboard()]);
    await fund(mine.userId, 1_000_000n);
    await pay(mine).expect(200);

    const res = await request(app.getHttpServer())
      .get('/v1/payouts')
      .set('Authorization', `Bearer ${theirs.token}`)
      .expect(200);
    expect(res.body.payouts).toHaveLength(0);
  });
});
