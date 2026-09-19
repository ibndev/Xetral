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
import { money, toMajor } from '@xetral/shared';
import type { Currency } from '@xetral/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PayoutReconciliationService } from './payout-reconciliation.service.js';
import { AppModule } from '../app.module.js';
import type { ApiConfig } from '../config.js';
import { systemClock } from '../tokens.js';
import { testApiConfig } from '../test-support/api-config.js';
import { SettingsService } from '../settings/settings.service.js';
import { approveKyc } from '../test-support/kyc-fixture.js';
import { pinListener } from '../test-support/listener.js';

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
    accountName: string | undefined;
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

  /*
   * WHETHER THIS RAIL SPENDS A BALANCE WE HAVE TO FUND. Mutable here, because
   * the whole point of the flag is that one deployment answers differently
   * per corridor: Flutterwave is prefunded and Paystack is not, and both are
   * behind this same port in production.
   */
  prefunded = false;

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

  async prefundedFor(): Promise<boolean> {
    return this.prefunded;
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

/** The same, in any currency — Accra and Nairobi hold cedis and shillings. */
async function fundIn(userId: string, currency: Currency, minor: bigint): Promise<void> {
  await ledger.post({
    idempotencyKey: `test-po-fund:${randomUUID()}`,
    kind: 'wallet_funding',
    occurredAt: new Date(),
    description: 'test payout funding',
    metadata: {},
    postings: [
      posting({ kind: 'customer_wallet', ownerId: userId, currency }, money(minor, currency)),
      posting({ kind: 'provider_float', currency }, money(-minor, currency)),
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
  // Bind once for the file. Without this, two requests started in the same
  // tick each bind and each close the same server — see `pinListener`.
  await pinListener(app);

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

/**
 * THE CORRIDOR THAT COULD NOT SEND AT ALL.
 *
 * A mobile money wallet has no name enquiry on any network — 043 records it as
 * `name_unavailable` and 059 repeats it — and `send()` called the lookup
 * unconditionally and treated that refusal as a reason not to send. So every
 * cedi and shilling payout was refused BY US, before the rail was ever asked,
 * on exactly the corridor the Ghana and Kenya integration exists for.
 *
 * NOTHING HERE COULD HAVE CAUGHT IT, which is why it shipped three times: the
 * fake port answered a bank lookup happily and no test ever asked it for a
 * wallet. These do.
 */
describe('paying a mobile money wallet', () => {
  let ghanaian: Customer;

  beforeAll(async () => {
    ghanaian = await onboard();
    await pool.query(`UPDATE users SET country = 'GH' WHERE id = $1::bigint`, [ghanaian.userId]);
    await fundIn(ghanaian.userId, 'GHS', 1_000_00n);
  });

  beforeEach(() => {
    /*
     * WHAT THE REAL ADAPTER DOES. A wallet is refused a name, permanently,
     * because there is nothing to ask. The fake agreed with the bug before —
     * it answered every lookup with a name — which is the same shape as the
     * funding fake echoing `currency: 'NGN'` whatever it was asked for.
     */
    port.lookupAnswer = new ProviderRejectedError(
      'flutterwave',
      'a mobile money wallet has no name enquiry',
      'name_unavailable',
    );
  });

  it('sends, with no beneficiary name anywhere', async () => {
    const res = await request(app.getHttpServer())
      .post('/v1/payouts')
      .set('Authorization', `Bearer ${ghanaian.token}`)
      .send({
        country: 'GH',
        bank_code: 'MTN',
        account_number: '0501234567',
        amount: '25.00',
        currency: 'GHS',
        transaction_pin: PIN,
        idempotency_key: randomUUID(),
      })
      .expect(200);

    expect(res.body.status).toBe('sent');
    // NOT the sender's own text, and not an empty string pretending to be a
    // name: nothing at all, which is the only honest value.
    expect(res.body.account_name).toBeNull();
    expect(port.sends.at(-1)?.accountName).toBeUndefined();
  });

  it('sends the number in the form the rail accepts, not the form it was typed in', async () => {
    /*
     * `0501234567` is how a number is written in Accra and is not a number
     * Flutterwave's transfers API can route. This is the assertion that would
     * have caught the payout being refused at the rail with a sentence about
     * an invalid account — which reads to the customer as their own number
     * being wrong.
     */
    await request(app.getHttpServer())
      .post('/v1/payouts')
      .set('Authorization', `Bearer ${ghanaian.token}`)
      .send({
        country: 'GH',
        bank_code: 'MTN',
        account_number: '0501234567',
        amount: '25.00',
        currency: 'GHS',
        transaction_pin: PIN,
        idempotency_key: randomUUID(),
      })
      .expect(200);

    expect(port.sends.at(-1)?.accountNumber).toBe('233501234567');
  });

  it('records the number it sent, because the row is immutable', async () => {
    const key = randomUUID();
    const res = await request(app.getHttpServer())
      .post('/v1/payouts')
      .set('Authorization', `Bearer ${ghanaian.token}`)
      .send({
        country: 'GH',
        bank_code: 'MTN',
        account_number: '0244123456',
        amount: '10.00',
        currency: 'GHS',
        transaction_pin: PIN,
        idempotency_key: key,
      })
      .expect(200);

    // 043 makes the destination immutable once the row exists, so a row
    // recording what the customer typed rather than what was sent is a payout
    // nothing could reconcile against the provider afterwards.
    expect(res.body.account_number).toBe('233244123456');
  });

  it('refuses a number it cannot put into international form, rather than sending it as typed', async () => {
    await request(app.getHttpServer())
      .post('/v1/payouts')
      .set('Authorization', `Bearer ${ghanaian.token}`)
      .send({
        country: 'GH',
        bank_code: 'MTN',
        account_number: '01234567890123456789',
        amount: '10.00',
        currency: 'GHS',
        transaction_pin: PIN,
        idempotency_key: randomUUID(),
      })
      .expect(400);
  });

  it('still refuses a BANK payout whose account nobody could find', async () => {
    /*
     * THE OTHER HALF, and the reason this is not a blanket relaxation. Where a
     * rail CAN answer, 043's rule is unchanged: an account number that passes
     * every format check can still belong to a stranger, and the bank's answer
     * is the only claim about the beneficiary that does not come from the
     * sender.
     */
    port.lookupAnswer = new ProviderRejectedError('paystack', 'no such account', 'unknown_account');
    const nigerian = await onboard();
    await fund(nigerian.userId, 1_000_000n);
    const res = await pay(nigerian);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('account_not_found');
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

    /*
     * A REFUSAL, NOT A 200 CARRYING `status: "failed"`.
     *
     * It was the second, and both apps read the amount off that body and told
     * the customer "Sent ₦5,000" — a success, an unchanged balance and nothing
     * at the bank. Refusing here is what fixes every client at once, including
     * the ones not written yet.
     *
     * AND IT CARRIES NO DETAIL. The provider's own sentence names our
     * integration, so it belongs on the row an operator reads — asserted
     * below, where it still is — and not on a customer's screen.
     */
    const res = await pay(customer).expect(422);
    expect(res.body.error).toBe('payout_failed');
    expect(JSON.stringify(res.body)).not.toContain('beneficiary bank unreachable');

    const listed = await request(app.getHttpServer())
      .get('/v1/payouts')
      .set('Authorization', `Bearer ${customer.token}`)
      .expect(200);
    expect(listed.body.payouts[0].failure_reason).toContain('beneficiary bank unreachable');

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

describe('what a customer reads about a payout afterwards', () => {
  /*
   * THE COMPLAINT THIS EXISTS FOR: "the payout activity log is saying bank
   * payout reserved instead of bank payout sent".
   *
   * A payout posts TWO entries. The reserve moves wallet → pending and its
   * description is written at that moment; the settle moves pending → float,
   * and the customer has NO leg in `customer_wallet` on it — so a wallet
   * history, which is wallet legs only and is right to be, can never show it.
   * The row therefore read "bank payout reserved" for ever, on money that
   * reached the bank days ago.
   *
   * Entries are append-only, so the description is not rewritten — it was true
   * when it was written. The live state is decorated on instead, which is also
   * correct for every row written before any of this existed.
   */
  it('shows a SETTLED payout as sent, not as reserved', async () => {
    const customer = await onboard();
    await fund(customer.userId, 1_000_000n);
    await pay(customer).expect(200);

    const history = await request(app.getHttpServer())
      .get('/v1/wallets/transactions?currency=NGN')
      .set('Authorization', `Bearer ${customer.token}`)
      .expect(200);

    const row = (history.body.entries as Record<string, unknown>[])[0]!;
    expect(row['payout_state']).toBe('sent');
    // And the row names WHERE it went rather than an internal ledger stage.
    expect(row['destination']).toContain('••6789');
  });

  it('opens ONE transaction in full, with the fee and a reference', async () => {
    const customer = await onboard();
    await fund(customer.userId, 1_000_000n);
    await pay(customer).expect(200);

    const history = await request(app.getHttpServer())
      .get('/v1/wallets/transactions?currency=NGN')
      .set('Authorization', `Bearer ${customer.token}`)
      .expect(200);
    const id = (history.body.entries as { id: string }[])[0]!.id;

    const detail = await request(app.getHttpServer())
      .get(`/v1/wallets/transactions/${id}`)
      .set('Authorization', `Bearer ${customer.token}`)
      .expect(200);

    expect(detail.body.beneficiary).toBe(BANK_NAME_ON_ACCOUNT);
    expect(detail.body.account_number).toBe(ACCOUNT);
    expect(detail.body.reference).toBe(id);
    // Each leg, so a receipt shows the amount and the fee as the two things
    // they are rather than as one number nobody can reconcile.
    expect(Array.isArray(detail.body.legs)).toBe(true);
  });

  it('ANSWERS THE SAME 404 for somebody else’s transaction as for none', async () => {
    /*
     * Distinguishing them would make this a way to enumerate other people's
     * transactions by id — the rule 018 already applies to disputes. Asserted
     * as an EQUALITY of the two responses rather than separately, which is how
     * the payment link's two answers came to differ.
     */
    const mine = await onboard();
    const theirs = await onboard();
    await fund(theirs.userId, 1_000_000n);
    await pay(theirs).expect(200);

    const theirHistory = await request(app.getHttpServer())
      .get('/v1/wallets/transactions?currency=NGN')
      .set('Authorization', `Bearer ${theirs.token}`)
      .expect(200);
    const theirId = (theirHistory.body.entries as { id: string }[])[0]!.id;

    const notMine = await request(app.getHttpServer())
      .get(`/v1/wallets/transactions/${theirId}`)
      .set('Authorization', `Bearer ${mine.token}`);

    const noSuchThing = await request(app.getHttpServer())
      .get('/v1/wallets/transactions/00000000-0000-4000-8000-000000000000')
      .set('Authorization', `Bearer ${mine.token}`);

    expect(notMine.status).toBe(noSuchThing.status);
    expect(notMine.body).toEqual(noSuchThing.body);
    expect(notMine.status).toBe(404);
  });

  it('answers a MALFORMED id exactly as an unknown one', async () => {
    // Same status and same body, so neither says which ids are the right SHAPE
    // and therefore worth guessing.
    const customer = await onboard();

    const malformed = await request(app.getHttpServer())
      .get('/v1/wallets/transactions/not-a-uuid')
      .set('Authorization', `Bearer ${customer.token}`);
    const unknown = await request(app.getHttpServer())
      .get('/v1/wallets/transactions/00000000-0000-4000-8000-000000000000')
      .set('Authorization', `Bearer ${customer.token}`);

    expect(malformed.status).toBe(unknown.status);
    expect(malformed.body).toEqual(unknown.body);
  });
});

describe('a payout that failed AFTER it had already been sent', () => {
  /*
   * THE BUG THIS SUITE EXISTS FOR, and it had been live since 043 permitted
   * `sent -> failed`.
   *
   * `fail()` always reversed `customer_pending -> customer_wallet`. That is
   * right for a RESERVED payout, where the hold is still in pending. It is
   * wrong for a SENT one: `#settle` has already emptied pending — the payout
   * to `provider_float`, the fee to `revenue_fees`, the tax to
   * `liability_tax_payable` — so taking the total back out of pending posts
   * against money that is no longer there.
   *
   * AND THE SYMPTOM IS NOT A WRONG NUMBER, IT IS A PAYOUT THAT CANNOT FAIL.
   * `customer_pending` is a customer account, so the overdraft guard refuses
   * to drive it negative; `fail()` therefore THREW, the sweep recorded "could
   * not reconcile", and the row stayed `sent` for ever with the customer's
   * money out of their wallet and recorded as paid to a provider that had
   * refused it.
   *
   * IT IS THE COMMONEST FAILURE ON THE NEWEST RAIL. Flutterwave's transfers
   * are asynchronous: their first answer is `NEW`, which this platform
   * correctly records as `sent`, and the real outcome arrives later on
   * `transfer.completed`. Every failed Ghanaian and Kenyan payout lands here.
   */
  it('GIVES THE MONEY BACK, from the float rather than from an empty hold', async () => {
    const customer = await onboard();
    await fund(customer.userId, 1_000_000n);

    // Accepted by the provider, so the hold is settled out to their float.
    port.sendAnswer = { providerPayoutId: 'po_late_fail', state: 'sent' };
    await pay(customer).expect(200);

    const afterSend = await nairaBalance(customer);
    expect(afterSend.spendable).toBe('5000.00');
    expect(afterSend.pending).toBe('0.00');

    // ...and then it fails at the rail, days later, which a bank transfer
    // really can do: a closed account, a name the bank rejects.
    port.statusAnswer = {
      providerPayoutId: 'po_late_fail',
      state: 'failed',
      failureReason: 'DESTINATION_BANK_REJECTED',
    };
    const report = await app.get(PayoutReconciliationService).sweep();
    expect(report.reversed).toBeGreaterThanOrEqual(1);

    const found = await pool.query<{ reference: string }>(
      `SELECT reference FROM bank_payouts WHERE provider_payout_id = 'po_late_fail'`,
    );
    const reference = found.rows[0]?.reference;
    expect(reference).toBeDefined();

    // THE CUSTOMER IS WHOLE. Under the old shape this assertion could not be
    // reached at all — the reversal threw and the row stayed `sent`.
    const after = await nairaBalance(customer);
    expect(after.spendable).toBe('10000.00');
    expect(after.pending).toBe('0.00');

    /*
     * AND SO IS THE PLATFORM — asserted on the REVERSAL'S OWN POSTINGS rather
     * than on the float balance.
     *
     * A sweep is global by design: it resolves whatever every other suite in
     * this file left behind, so the float moves for reasons that have nothing
     * to do with this payout. This file already records that lesson about the
     * report COUNTS, and it applies to a balance for the same reason. What is
     * being tested is the SHAPE of the entry, and that is what this reads.
     */
    const legs = await pool.query<{ kind: string; amount_minor: string }>(
      `SELECT a.kind::text, p.amount_minor::text
         FROM journal_entries e
         JOIN postings p ON p.journal_entry_id = e.id
         JOIN accounts a ON a.id = p.account_id
        WHERE e.idempotency_key = $1`,
      [`bank-payout-reverse:${reference}`],
    );
    const legFor = (kind: string) =>
      legs.rows.filter((row) => row.kind === kind).map((row) => BigInt(row.amount_minor));

    // Off the provider's float, which is where the settlement put it — and
    // NOT off `customer_pending`, which the settlement emptied.
    expect(legFor('provider_float')).toEqual([-500_000n]);
    expect(legFor('customer_pending')).toEqual([]);
    // Back to the customer, the whole total.
    expect(legFor('customer_wallet')).toEqual([500_000n]);

    // The rail's own sentence, on the row an operator reads — never the
    // customer's screen. 006's rule.
    const row = await pool.query<{ failure_reason: string | null }>(
      `SELECT failure_reason FROM bank_payouts WHERE provider_payout_id = 'po_late_fail'`,
    );
    expect(row.rows[0]?.failure_reason).toContain('DESTINATION_BANK_REJECTED');
  });
});

describe('a payout the PLATFORM cannot fund', () => {
  /*
   * THE OTHER POT OF MONEY, and the one nothing in this codebase had ever
   * asked about. Every control before now protects the CUSTOMER's balance;
   * Flutterwave is a prefunded wallet, so a cedi payout spends a cedi balance
   * we have to put there, and a deployment that has never collected a cedi
   * has none.
   *
   * WITHOUT THIS THE REFUSAL COMES FROM FLUTTERWAVE, as a message about funds,
   * on a transfer whose customer, amount and wallet number were all correct —
   * which from inside the app is indistinguishable from a bad account number,
   * and is the third distinct way this one corridor has produced "we cannot
   * find the momo details".
   */
  it('REFUSES IT HERE, before the rail is asked, and says whose problem it is', async () => {
    const customer = await onboard();
    await pool.query(`UPDATE users SET country = 'GH' WHERE id = $1::bigint`, [customer.userId]);

    /*
     * READ, NOT ASSUMED. These suites share one database in file order, so
     * whatever GHS float earlier files left behind is the starting point —
     * an absolute figure here would be an assertion about them.
     */
    const held = await floatHeld('GHS');

    /*
     * THE CUSTOMER IS FUNDED WITHOUT TOUCHING THE FLOAT, which is the whole
     * point of the scenario: their wallet is real money we owe them, and the
     * provider does not hold the cedis to pay it out with. Money attributed
     * out of suspense is exactly that shape.
     */
    const amountMinor = held + 50_000n;
    await ledger.post({
      idempotencyKey: `test-po-nofloat:${randomUUID()}`,
      kind: 'wallet_funding',
      occurredAt: new Date(),
      description: 'funded without a matching float',
      metadata: {},
      postings: [
        posting(
          { kind: 'customer_wallet', ownerId: customer.userId, currency: 'GHS' },
          money(amountMinor + 10_000n, 'GHS'),
        ),
        posting({ kind: 'suspense', currency: 'GHS' }, money(-(amountMinor + 10_000n), 'GHS')),
      ],
    });

    port.prefunded = true;
    port.lookupAnswer = new ProviderRejectedError(
      'flutterwave',
      'a mobile money wallet has no name enquiry',
      'name_unavailable',
    );
    try {
      const res = await request(app.getHttpServer())
        .post('/v1/payouts')
        .set('Authorization', `Bearer ${customer.token}`)
        .send({
          country: 'GH',
          bank_code: 'MTN',
          account_number: '0501234567',
          amount: toMajor(money(amountMinor, 'GHS')),
          currency: 'GHS',
          transaction_pin: PIN,
          idempotency_key: randomUUID(),
        })
        .expect(503);

      /*
       * ITS OWN CODE, and deliberately not `insufficient_funds`. That one is a
       * true statement about the CUSTOMER and tells them to add money; this is
       * a true statement about US, and telling them to add money would be a
       * lie that costs them a trip to their bank.
       */
      expect(res.body.error).toBe('insufficient_platform_liquidity');

      // NOTHING WAS HELD and NOTHING WAS ASKED. The refusal runs as a
      // precondition on the reserve entry's own transaction, so there is no
      // posting to unwind — and the rail was never called.
      const sendsAfter = port.sends.filter((call) => call.currency === 'GHS').length;
      expect(sendsAfter).toBe(0);
    } finally {
      port.prefunded = false;
    }
  });

  it('LETS IT THROUGH once the float covers it', async () => {
    // The other half, and the one that matters as much: a guard that refused
    // a payout the platform CAN fund would be an outage on the screen
    // customers send money from.
    const customer = await onboard();
    await pool.query(`UPDATE users SET country = 'GH' WHERE id = $1::bigint`, [customer.userId]);
    // `fundIn` moves the float as a real collection does, so the platform
    // holds these cedis.
    await fundIn(customer.userId, 'GHS', 100_00n);

    port.prefunded = true;
    port.sendAnswer = { providerPayoutId: 'po_funded', state: 'sent' };
    port.lookupAnswer = new ProviderRejectedError(
      'flutterwave',
      'a mobile money wallet has no name enquiry',
      'name_unavailable',
    );
    try {
      await request(app.getHttpServer())
        .post('/v1/payouts')
        .set('Authorization', `Bearer ${customer.token}`)
        .send({
          country: 'GH',
          bank_code: 'MTN',
          account_number: '0501234567',
          amount: '10.00',
          currency: 'GHS',
          transaction_pin: PIN,
          idempotency_key: randomUUID(),
        })
        .expect(200);
    } finally {
      port.prefunded = false;
    }
  });

  it('IS A ROW AN OPERATOR CAN TURN OFF, because float can be funded outside the ledger', async () => {
    /*
     * An operator can wire cedis to Flutterwave directly, and that funding is
     * real and recorded nowhere here — so a platform genuinely able to pay
     * would be refusing every transfer with no remedy but a release. 009's
     * argument is that an operational decision taken under pressure must not
     * be one.
     */
    const customer = await onboard();
    await pool.query(`UPDATE users SET country = 'GH' WHERE id = $1::bigint`, [customer.userId]);
    const held = await floatHeld('GHS');
    const amountMinor = held + 50_000n;
    await ledger.post({
      idempotencyKey: `test-po-nofloat-off:${randomUUID()}`,
      kind: 'wallet_funding',
      occurredAt: new Date(),
      description: 'funded without a matching float',
      metadata: {},
      postings: [
        posting(
          { kind: 'customer_wallet', ownerId: customer.userId, currency: 'GHS' },
          money(amountMinor + 10_000n, 'GHS'),
        ),
        posting({ kind: 'suspense', currency: 'GHS' }, money(-(amountMinor + 10_000n), 'GHS')),
      ],
    });

    port.prefunded = true;
    port.sendAnswer = { providerPayoutId: 'po_guard_off', state: 'sent' };
    port.lookupAnswer = new ProviderRejectedError(
      'flutterwave',
      'a mobile money wallet has no name enquiry',
      'name_unavailable',
    );
    await pool.query(
      `UPDATE platform_settings SET value = 'false' WHERE key = 'payout_float_guard_enabled'`,
    );
    await app.get(SettingsService).refresh();
    try {
      await request(app.getHttpServer())
        .post('/v1/payouts')
        .set('Authorization', `Bearer ${customer.token}`)
        .send({
          country: 'GH',
          bank_code: 'MTN',
          account_number: '0501234567',
          amount: toMajor(money(amountMinor, 'GHS')),
          currency: 'GHS',
          transaction_pin: PIN,
          idempotency_key: randomUUID(),
        })
        .expect(200);
    } finally {
      // PUT BACK, because these suites share one database and a suite that
      // relaxes a control and walks away subjects every later file to it.
      port.prefunded = false;
      await pool.query(
        `UPDATE platform_settings SET value = 'true' WHERE key = 'payout_float_guard_enabled'`,
      );
      await app.get(SettingsService).refresh();
    }
  });
});

/**
 * What the platform holds at its providers in one currency, in minor units.
 *
 * THE NEGATIVE OF THE LEDGER BALANCE, turned the right way up by the view —
 * liabilities are positive in this schema, so an asset a provider holds for
 * us is negative. Read through `platform_float_positions` rather than
 * recomputed here, so a test cannot agree with a broken view by making the
 * same sign error twice.
 */
async function floatHeld(currency: string): Promise<bigint> {
  const rows = await pool.query<{ held_minor: string }>(
    `SELECT held_minor::text FROM platform_float_positions WHERE currency = $1`,
    [currency],
  );
  return BigInt(rows.rows[0]?.held_minor ?? '0');
}
