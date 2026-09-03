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
import { ProviderTimeoutError, ProviderRejectedError } from '@xetral/providers';
import type { FxExecution, FxPort, FxRate } from '@xetral/providers';
import { money } from '@xetral/shared';
import type { Currency, Money } from '@xetral/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from '../app.module.js';
import type { ApiConfig } from '../config.js';
import { systemClock } from '../tokens.js';
import { testApiConfig } from '../test-support/api-config.js';
import { SettingsService } from '../settings/settings.service.js';

/**
 * FX and remittance, end to end.
 *
 * The property worth more than the others: a two-currency entry balances PER
 * CURRENCY, so money cannot appear on one side because it disappeared on the
 * other. Everything else here is about the customer getting the number they
 * were shown.
 *
 * Requires DATABASE_URL with 001..008 applied.
 */
const DATABASE_URL = process.env['DATABASE_URL'];
if (DATABASE_URL === undefined || DATABASE_URL === '') {
  throw new Error('the fx e2e suite needs DATABASE_URL with the migrations applied');
}

const PASSWORD = 'a-long-enough-password';
const PIN = '374915';

/** 1 USD = ₦1,650.25, as the ratio kobo-per-cent. */
class FakeFxPort implements FxPort {
  readonly provider = 'bitnob';
  readonly conversions: string[] = [];
  numerator = 165_025n;
  denominator = 100n;
  convertAnswer: FxExecution | Error | undefined;

  async rate(base: Currency, quote: Currency): Promise<FxRate> {
    // NGN -> USD is the inverse ratio; anything else uses the configured one.
    if (base === 'NGN' && quote === 'USD') {
      return {
        base,
        quote,
        numerator: this.denominator,
        denominator: this.numerator,
        expiresAt: new Date(Date.now() + 30_000),
      };
    }
    return {
      base,
      quote,
      numerator: this.numerator,
      denominator: this.denominator,
      expiresAt: new Date(Date.now() + 30_000),
    };
  }

  async convert<B extends Currency>(
    _base: B,
    _quote: Currency,
    amount: Money<B>,
    reference: string,
  ): Promise<FxExecution> {
    this.conversions.push(reference);
    if (this.convertAnswer instanceof Error) throw this.convertAnswer;
    if (this.convertAnswer !== undefined) return this.convertAnswer;
    // Fills exactly what was offered, at the quoted rate.
    return {
      providerReference: `swap_${reference}`,
      costMinor: amount.amount,
      filledQuoteMinor: 1n << 62n, // never the binding constraint by default
    };
  }
}

let pool: Pool;
let ledger: LedgerService;
let app: INestApplication;
let port: FakeFxPort;

function makeConfig(overrides: Partial<ApiConfig> = {}): ApiConfig {
  return testApiConfig(DATABASE_URL as string, { ...overrides });
}

async function boot(config: ApiConfig): Promise<INestApplication> {
  const mod = await Test.createTestingModule({
    imports: [AppModule.forRoot({ config, pool, clock: systemClock, fxPort: port })],
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

async function onboard(): Promise<Customer> {
  const identifier = `fx-${randomUUID()}@example.ng`;
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

  // VERIFIED, because converting currency is a KYC-gated activity and an
  // unverified account may move no dollars at all. Set here rather than left
  // at the default so this fixture describes a customer who could actually
  // reach these routes — a suite whose fixture is in a state production
  // refuses is a suite asserting on behaviour nobody will ever see.
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

async function fund(userId: string, minor: number): Promise<void> {
  await ledger.post({
    idempotencyKey: `test-fx-fund:${randomUUID()}`,
    kind: 'wallet_funding',
    occurredAt: new Date(),
    description: 'test funding',
    metadata: {},
    postings: [
      posting({ kind: 'customer_wallet', ownerId: userId, currency: 'NGN' }, money(minor, 'NGN')),
      posting({ kind: 'provider_float', currency: 'NGN' }, money(-minor, 'NGN')),
    ],
  });
}

/**
 * CONVERTING between your own wallets. NO transaction PIN and no recipient —
 * `convertSchema` is strict and has neither field, because a PIN is the second
 * factor for money LEAVING the account and nothing leaves here.
 */
const convert = (customer: Customer, overrides: Record<string, unknown> = {}) =>
  request(app.getHttpServer())
    .post('/v1/fx/convert')
    .set('Authorization', `Bearer ${customer.token}`)
    .send({
      from: 'NGN',
      to: 'USD',
      amount: '1650250.00',
      idempotency_key: randomUUID(),
      ...overrides,
    });

/** CONVERTING AND SENDING IT. A payment, so it takes the PIN. */
const remit = (
  customer: Customer,
  recipient: string,
  overrides: Record<string, unknown> = {},
) =>
  request(app.getHttpServer())
    .post('/v1/fx/remit')
    .set('Authorization', `Bearer ${customer.token}`)
    .send({
      from: 'NGN',
      to: 'USD',
      amount: '1650250.00',
      recipient,
      transaction_pin: PIN,
      idempotency_key: randomUUID(),
      ...overrides,
    });

async function balances(
  customer: Customer,
): Promise<Record<string, string>> {
  const res = await request(app.getHttpServer())
    .get('/v1/wallets')
    .set('Authorization', `Bearer ${customer.token}`)
    .expect(200);
  const out: Record<string, string> = {};
  for (const b of res.body.balances as { currency: string; spendable: string }[]) {
    out[b.currency] = b.spendable;
  }
  return out;
}

const PINNED: Readonly<Record<string, string>> = {
  fx_daily_limit_kobo: '10000000000',
  fx_count_hourly: '200',
};

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: DATABASE_URL, max: 8 });
  ledger = new LedgerService(pool);
  port = new FakeFxPort();

  await pool.query(
    `INSERT INTO fx_spread_policies (base_currency, quote_currency, spread_basis_points, min_base_minor)
     VALUES ('NGN', 'USD', 150, 100000)
     ON CONFLICT (base_currency, quote_currency) WHERE (retired_at IS NULL) DO NOTHING`,
  );

  app = await boot(makeConfig());

  // Pinned rather than inherited: the suites share a database and run in file
  // order, and one that narrows a limit does not put it back.
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
  port.conversions.length = 0;
  port.convertAnswer = undefined;
});

describe('quoting', () => {
  it('shows what the customer receives and what we keep', async () => {
    const customer = await onboard();
    const res = await request(app.getHttpServer())
      .get('/v1/fx/quote?from=NGN&to=USD&amount=1650250.00')
      .set('Authorization', `Bearer ${customer.token}`)
      .expect(200);

    // 1.5% of ₦1,650,250 is ₦24,753.75; the rest converts to $985.00.
    expect(res.body).toMatchObject({
      from: 'NGN',
      to: 'USD',
      amount: '1650250.00',
      spread: '24753.75',
      receives: '985.00',
    });
  });

  it('refuses a pair we do not publish a price for', async () => {
    // Quoting from a default would be inventing a price nobody reviewed.
    const customer = await onboard();
    const res = await request(app.getHttpServer())
      .get('/v1/fx/quote?from=NGN&to=EUR&amount=1000.00')
      .set('Authorization', `Bearer ${customer.token}`);

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('pair_not_supported');
  });

  it('refuses an amount below the published minimum', async () => {
    const customer = await onboard();
    const res = await request(app.getHttpServer())
      .get('/v1/fx/quote?from=NGN&to=USD&amount=5.00')
      .set('Authorization', `Bearer ${customer.token}`);

    expect(res.status).toBe(422);
    expect(res.body.error).toBe('below_minimum');
  });

  it('needs a session', async () => {
    const res = await request(app.getHttpServer()).get('/v1/fx/quote?from=NGN&to=USD&amount=1.00');
    expect(res.status).toBe(401);
  });
});

describe('converting', () => {
  it('debits one currency and credits the other', async () => {
    const customer = await onboard();
    await fund(customer.userId, 2_000_000_00);

    const res = await convert(customer).expect(200);
    expect(res.body).toMatchObject({
      from: 'NGN',
      to: 'USD',
      amount: '1650250.00',
      received: '985.00',
      spread: '24753.75',
    });

    const after = await balances(customer);
    expect(after['NGN']).toBe('349750.00'); // 2,000,000 - 1,650,250
    expect(after['USD']).toBe('985.00');
  });

  it('books the spread as revenue, in the base currency', async () => {
    const customer = await onboard();
    await fund(customer.userId, 2_000_000_00);
    await convert(customer).expect(200);

    const revenue = await pool.query<{ balance_minor: string }>(
      `SELECT b.balance_minor FROM account_balances b
         JOIN accounts a ON a.id = b.account_id
        WHERE a.kind = 'revenue_fx_spread' AND a.currency = 'NGN'`,
    );
    // At least this trade's margin — the suite shares a database.
    expect(BigInt(revenue.rows[0]?.balance_minor ?? '0')).toBeGreaterThanOrEqual(2_475_375n);
  });

  it('takes NO transaction PIN, and REFUSES a recipient', async () => {
    /*
     * A PIN is the second factor for money LEAVING the account, and converting
     * moves a customer's own money between their own wallets — the balance
     * afterwards is the same balance in another denomination. Asking for it
     * here teaches people to type the secret that authorises payments for
     * something that is not one.
     *
     * THE RECIPIENT IS REFUSED RATHER THAN IGNORED, and that is the half worth
     * a test. Zod strips unknown keys by default, so without `.strict()` a
     * recipient sent here would be silently dropped: the customer converts
     * into their own wallet believing they paid somebody, the response is 200,
     * and the person who was supposed to receive it never hears. Refusing is
     * the difference between "we ignored what you asked for" and "that is not
     * what this endpoint does".
     */
    const customer = await onboard();
    await fund(customer.userId, 2_000_000_00);

    const noPin = await convert(customer);
    expect(noPin.status).toBe(200);

    const withRecipient = await convert(customer, { recipient: 'somebody@example.ng' });
    expect(withRecipient.status).toBe(400);
    expect(withRecipient.body.error).toBe('invalid_request');
  });

  it('refuses a wrong PIN when the money is going to somebody else', async () => {
    // The other half of the split: remitting IS a payment, so it is authorised
    // like every other payment.
    const sender = await onboard();
    const recipient = await onboard();
    await fund(sender.userId, 2_000_000_00);

    const before = port.conversions.length;

    const missing = await remit(sender, recipient.identifier, {
      transaction_pin: undefined,
    });
    expect(missing.status).toBe(400);

    const wrong = await remit(sender, recipient.identifier, { transaction_pin: '999119' });
    expect(wrong.status).toBe(401);

    expect(port.conversions).toHaveLength(before);
    expect((await balances(sender))['NGN']).toBe('2000000.00');
  });

  it('refuses more than the wallet holds', async () => {
    const customer = await onboard();
    await fund(customer.userId, 1_000_00);

    const res = await convert(customer);
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('insufficient_funds');
  });

  it('refuses converting a currency into itself', async () => {
    const customer = await onboard();
    await fund(customer.userId, 2_000_000_00);
    const res = await convert(customer, { to: 'NGN' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('same_currency');
  });

  it('converts ONCE for a retried request', async () => {
    const customer = await onboard();
    await fund(customer.userId, 4_000_000_00);
    const key = randomUUID();

    const first = await convert(customer, { idempotency_key: key }).expect(200);
    const second = await convert(customer, { idempotency_key: key }).expect(200);

    expect(second.body.id).toBe(first.body.id);
    expect((await balances(customer))['USD']).toBe('985.00');
  });

  it('refuses when the rate moved past what the customer accepted', async () => {
    // Rates move between the quote and the request. Delivering materially less
    // than the customer accepted is taking the difference on a technicality.
    const customer = await onboard();
    await fund(customer.userId, 2_000_000_00);
    port.numerator = 200_000n; // naira weakened

    try {
      const res = await convert(customer, { min_received: '985.00' });
      expect(res.status).toBe(409);
      expect(res.body.error).toBe('rate_moved');
      expect(port.conversions).toHaveLength(0);
    } finally {
      port.numerator = 165_025n;
    }
  });

  it('holds nothing and records nothing when the swap times out', async () => {
    // We do not know whether the swap happened. Recording it would risk
    // crediting twice on a retry; the derived reference makes the retry
    // idempotent at the provider instead.
    const customer = await onboard();
    await fund(customer.userId, 2_000_000_00);
    port.convertAnswer = new ProviderTimeoutError('bitnob', 'no response');

    const res = await convert(customer);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('fx_outcome_unknown');
    // Nothing moved. Zero dollars rather than NO dollar row: `/v1/wallets`
    // returns a zero for every currency the platform offers, so "absent"
    // stopped meaning "not credited" — what matters is that the figure is
    // nothing.
    expect((await balances(customer))['NGN']).toBe('2000000.00');
    expect((await balances(customer))['USD']).toBe('0.00');
  });

  it('moves nothing when the provider refuses', async () => {
    const customer = await onboard();
    await fund(customer.userId, 2_000_000_00);
    port.convertAnswer = new ProviderRejectedError('bitnob', 'no liquidity', 'NO_LIQUIDITY');

    const res = await convert(customer);
    expect(res.status).toBe(422);
    expect((await balances(customer))['NGN']).toBe('2000000.00');
  });

  it('credits what the provider FILLED when it is less than quoted', async () => {
    // Believe the numbers over the label. Crediting the quote when the
    // provider delivered less would mean paying the difference out of the
    // float, silently, on every partial fill.
    const customer = await onboard();
    await fund(customer.userId, 2_000_000_00);
    port.convertAnswer = {
      providerReference: 'swap_partial',
      costMinor: 165_025_000n,
      filledQuoteMinor: 90_000n, // $900.00, not the quoted $985.00
    };

    const res = await convert(customer).expect(200);
    expect(res.body.received).toBe('900.00');
    expect((await balances(customer))['USD']).toBe('900.00');
  });
});

describe('remittance', () => {
  it('lands the converted money in somebody else\'s wallet', async () => {
    const sender = await onboard();
    const recipient = await onboard();
    await fund(sender.userId, 2_000_000_00);

    const res = await remit(sender, recipient.identifier).expect(200);
    expect(res.body.recipient).toBe(recipient.identifier);

    // The sender paid naira and holds no dollars — zero of them, which is the
    // same claim now that an offered currency always has a row.
    const senderBalances = await balances(sender);
    expect(senderBalances['NGN']).toBe('349750.00');
    expect(senderBalances['USD']).toBe('0.00');

    // The recipient holds the dollars and no naira.
    const recipientBalances = await balances(recipient);
    expect(recipientBalances['USD']).toBe('985.00');
  });

  it('refuses a recipient who does not exist', async () => {
    const sender = await onboard();
    await fund(sender.userId, 2_000_000_00);
    const res = await remit(sender, 'nobody@example.ng');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('recipient_not_found');
  });

  it('refuses remitting to yourself', async () => {
    // Sending to yourself is a conversion. Modelling it as a remittance would
    // make the two indistinguishable in reporting.
    const sender = await onboard();
    await fund(sender.userId, 2_000_000_00);
    const res = await remit(sender, sender.identifier);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('recipient_is_sender');
  });
});
