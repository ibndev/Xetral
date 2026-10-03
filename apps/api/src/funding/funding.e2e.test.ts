import 'reflect-metadata';
import { createHmac, randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { ExpressAdapter } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import pg from 'pg';
import type { Pool } from 'pg';
import { hashPassword } from '@xetral/identity';
import {
  ProviderPendingError,
  ProviderRejectedError,
  ProviderTimeoutError,
} from '@xetral/providers';
import type {
  CreateVirtualAccountRequest,
  FundingPort,
  DepositLookup,
  ProviderDeposit,
  VirtualAccount,
} from '@xetral/providers';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from '../app.module.js';
import type { ApiConfig } from '../config.js';
import { DepositReconciliationService } from './deposit-reconciliation.service.js';
import { systemClock } from '../tokens.js';
import { testApiConfig } from '../test-support/api-config.js';
import { approveKyc } from '../test-support/kyc-fixture.js';

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

/**
 * A SECOND CONNECTION, AS THE ROLE THAT OWNS THE SCHEMA.
 *
 * One test here reproduces "the code rolled out and the migration did not" by
 * actually DROPPING a column, because what it asserts is that a real Postgres
 * 42703 reaches the handler and comes back as a named refusal rather than a
 * 500 — mocking the error would test the mock.
 *
 * THE SUITE RUNS AS `xetral_app` DELIBERATELY. 099 takes DDL away from the
 * application role precisely so that a query needing it cannot reach a
 * deploy, and this test asked for `ALTER TABLE` and got `must be owner of
 * table virtual_accounts`. That refusal is the least-privilege rule WORKING;
 * the mistake was asking the product's role to do the harness's job.
 *
 * So the DDL gets its own connection and everything else keeps the restricted
 * one. It FALLS BACK to `DATABASE_URL` rather than refusing, because a
 * developer running this against a database they own should not have to set a
 * second variable to get the same answer.
 */
const OWNER_DATABASE_URL = process.env['DATABASE_OWNER_URL'] ?? DATABASE_URL;

const PASSWORD = 'a-long-enough-password';
const WEBHOOK_SECRET = 'a-test-webhook-secret';

/** A stand-in for Bitnob. Deterministic account numbers so a test can assert
 *  on the exact one a customer would be shown. */
class FakeFundingPort implements FundingPort {
  provider = 'bitnob';
  /**
   * PAYSTACK'S GATE, reproduced: with this on, an account is refused with
   * `identity_required` — the code the real adapter gives "Customer has not
   * been identified" — until the customer's email is in `identified`, which
   * is what Paystack's assignment finishing looks like from outside. A
   * request carrying `identity` is Paystack's "in progress".
   */
  identityRequired = false;
  readonly identified = new Set<string>();
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
    if (this.identityRequired && !this.identified.has(req.customer.email)) {
      if (req.identity !== undefined) {
        throw new ProviderPendingError('paystack', 'Assign dedicated account in progress');
      }
      throw new ProviderRejectedError(
        'paystack',
        'Customer has not been identified',
        'identity_required',
      );
    }
    this.#seq += 1;
    return {
      provider: 'bitnob',
      providerCustomerRef: undefined,
      providerAccountId: `bva_${this.#run}_${this.#seq}`,
      // Ten digits, unique per run: derived from the run id so two runs cannot
      // both claim a NUBAN, which is UNIQUE across the whole table.
      accountNumber: String(
        1_000_000_000 + (Number.parseInt(this.#run, 16) % 900_000_000) + this.#seq,
      ),
      bankName: 'Providus Bank',
      accountName: 'XETRAL/TEST CUSTOMER',
      // ECHOED, not hardcoded. It was 'NGN' whatever it was asked for — which
      // is the same assumption the service itself was making, so no test here
      // could have caught the service asking for naira on behalf of a customer
      // in Accra: the fake agreed with it.
      currency: req.currency,
      active: true,
    };
  }

  async getVirtualAccount(id: string): Promise<VirtualAccount> {
    return {
      provider: 'bitnob',
      providerCustomerRef: undefined,
      providerAccountId: id,
      accountNumber: '1000000001',
      bankName: 'Providus Bank',
      accountName: 'XETRAL/TEST CUSTOMER',
      currency: 'NGN',
      active: true,
    };
  }

  async listDeposits(account: DepositLookup): Promise<readonly ProviderDeposit[]> {
    return this.deposits.get(account.providerAccountId) ?? [];
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
async function onboard(kyc = true, country?: string): Promise<Customer> {
  const identifier = `fund-${randomUUID()}@example.ng`;
  const inserted = await pool.query<{ id: string }>(
    // `country` is what decides the CURRENCY the account is opened in, and
    // therefore which rail 059 sends the request to.
    `INSERT INTO users (email, status, country) VALUES ($1, 'active', $2) RETURNING id`,
    [identifier, country ?? null],
  );
  const userId = inserted.rows[0]?.id;
  if (userId === undefined) throw new Error('failed to seed user');

  await pool.query(`INSERT INTO user_credentials (user_id, password_hash) VALUES ($1, $2)`, [
    userId,
    await hashPassword(PASSWORD),
  ]);

  if (kyc) {
    // Verified, in the ONE place that knows what approval actually writes: an
    // approved `kyc_submissions` row (which is where a card's embossed name is
    // read from), the provider mapping, and the tier — all three, because
    // approval writes all three in one transaction.
    await approveKyc(pool, userId);
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
  port.identityRequired = false;
  port.provider = 'bitnob';
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

  /*
   * THE BUG THIS PINS. `#openAccount` called the port with a HARDCODED 'NGN',
   * so `providerFor('collect', …)` — which picks the rail FROM the currency —
   * was asked about naira on behalf of every customer on the platform and
   * correctly answered Paystack. A customer in Accra pressing Activate was
   * asking a Nigerian integration for a Nigerian account number, and what came
   * back said nothing about why.
   *
   * Nothing could have caught it: the compiler is satisfied by a string
   * literal, and the fake port echoed 'NGN' whatever it was asked for — so the
   * test agreed with the service about the very thing that was wrong.
   */
  /*
   * A NAIRA ACCOUNT NUMBER FOR EVERYBODY, because that is the only account
   * number any rail here opens.
   *
   * This asserted the opposite — a Ghanaian's account opened in CEDIS — and
   * that is exactly what broke Activate Account in Accra: the request went to
   * The previous cedi rail for a cedi account number no rail issues, and the naira one
   * every customer is offered (040: money paid to a Ghanaian by a Nigerian
   * lands in naira) was never asked for. 079's coverage says where an account
   * number is a product; the customer's own currency is used only there.
   */
  it('opens a NAIRA account number wherever no rail opens one in the local currency', async () => {
    const ghanaian = await onboard(true, 'GH');
    const res = await getAccount(ghanaian).expect(200);

    expect(res.body.currency).toBe('NGN');
    expect(port.created.at(-1)?.currency).toBe('NGN');

    const kenyan = await onboard(true, 'KE');
    await getAccount(kenyan).expect(200);
    expect(port.created.at(-1)?.currency).toBe('NGN');

    const nigerian = await onboard(true, 'NG');
    await getAccount(nigerian).expect(200);
    expect(port.created.at(-1)?.currency).toBe('NGN');
  });

  /*
   * AND AN ACCOUNT WITH NO COUNTRY IS STILL NAIRA. 050's argument: such a row
   * can only have been created when this platform operated in Nigeria alone,
   * so the fallback is a claim about history rather than a guess — and
   * refusing instead would break the one flow every existing customer already
   * relies on.
   */
  it('falls back to naira for an account with no country', async () => {
    const legacy = await onboard(true);
    const res = await getAccount(legacy).expect(200);
    expect(res.body.currency).toBe('NGN');
    expect(port.created.at(-1)?.currency).toBe('NGN');
  });

  /*
   * THE READ PATH FINDS IT TOO. `#accountOf` filtered on `currency = 'NGN'`,
   * so a Ghanaian's own account was invisible to the screen that shows it —
   * which would have offered to open one they already held, and the second
   * request would have raced the partial unique index rather than reading the
   * winner's row.
   */
  it("returns a Ghanaian's naira account to the screen that reads it", async () => {
    const ghanaian = await onboard(true, 'GH');
    const opened = await getAccount(ghanaian).expect(200);

    const read = await request(app.getHttpServer())
      .get('/v1/funding/account')
      .set('Authorization', `Bearer ${ghanaian.token}`)
      .expect(200);

    // The route wraps it: `{ account: … | null }`.
    expect(read.body.account.account_number).toBe(opened.body.account_number);
    expect(read.body.account.currency).toBe('NGN');
  });

  it('NAMES THE MISSING MIGRATION when the schema is behind the build', async () => {
    /*
     * THE FAILURE THIS IS FOR. `virtual_accounts.provider` arrives in 044. On
     * a deployment where the code rolled out and that migration did not,
     * Postgres answers `column "provider" ... does not exist`, nothing caught
     * it, and the customer read "something went wrong" on the screen they
     * opened in order to put money in — which from outside is
     * indistinguishable from a wrong key, an unapproved integration or a
     * provider outage. An operator can lose a day on the provider dashboard
     * while the answer is one `psql -f` away.
     *
     * Reproduced by actually DROPPING the column rather than by mocking the
     * error, because what is being tested is that a real Postgres 42703
     * reaches the handler and comes back as a named refusal. Restored in a
     * `finally`, since every later suite shares this database.
     */
    const customer = await onboard(false);

    /*
     * AS THE OWNER, not as the application. See `OWNER_DATABASE_URL`: this is
     * harness work, and the app role being refused it is 099 doing its job.
     */
    const owner = new pg.Pool({ connectionString: OWNER_DATABASE_URL, max: 1 });
    await owner.query('ALTER TABLE virtual_accounts DROP COLUMN provider');
    try {
      const res = await getAccount(customer);
      // A 503, not a 500: this deployment cannot serve the request right now
      // and a person has to act. The code is one the client already renders.
      expect(res.status).toBe(503);
      expect(res.body.error).toBe('account_issue_unavailable');
    } finally {
      await owner.query(
        `ALTER TABLE virtual_accounts
           ADD COLUMN provider TEXT NOT NULL DEFAULT 'bitnob'
             CHECK (length(btrim(provider)) > 0)`,
      );
      await owner.end();
    }
  });

  it('OPENS ONE FOR A CUSTOMER WHO HAS NOT VERIFIED ANYTHING', async () => {
    /*
     * THIS TEST USED TO ASSERT THE OPPOSITE, and the assertion was Bitnob's
     * requirement written down as the platform's.
     *
     * "A Nigerian bank account cannot be issued to an unidentified person" is
     * true of BITNOB, which will not issue one without a verified BVN. It is
     * not true of the rail: CBN's tiered KYC permits a tier 1 account on a
     * name and a phone number, capped — and `029_kyc_tiers.seed.sql` has
     * capped tier 0 at 50,000 naira a day since it landed. So the platform
     * enforced the ceiling while refusing the account that ceiling exists for,
     * on the screen a customer opens in order to put money in.
     *
     * The requirement did not disappear; it moved to where it is true. The
     * Bitnob adapter refuses an unverified customer in its own code with its
     * own reason, which `funding-adapter.test.ts` asserts.
     */
    const customer = await onboard(false);
    const res = await getAccount(customer).expect(200);
    expect(res.body.account_number).toMatch(/^[0-9]{10}$/);
    expect(res.body.currency).toBe('NGN');
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

  it('a late webhook for a swept deposit does not credit it twice', async () => {
    // THE REPRODUCTION. The test above claims to cover this and does not: its
    // late webhook carries no account_number, so it resolves to no owner and
    // lands in suspense — the customer's balance is unchanged for a reason
    // that has nothing to do with idempotency. This one addresses the webhook
    // to the customer's real account, which is what Bitnob would do.
    const customer = await onboard();
    const account = await getAccount(customer).expect(200);
    const reference = `dep_late_${randomUUID()}`;

    const accountRow = await pool.query<{ provider_account_id: string }>(
      `SELECT provider_account_id FROM virtual_accounts WHERE user_id = $1::bigint`,
      [customer.userId],
    );
    port.deposits.set(accountRow.rows[0]?.provider_account_id ?? '', [
      {
        providerReference: reference,
        amountMinor: 1_000_000n,
        currency: 'NGN',
        senderName: 'LATE WEBHOOK',
        senderBank: 'Access Bank',
        senderAccount: '0011223344',
        occurredAt: new Date(),
      },
    ]);

    await app.get(DepositReconciliationService).sweep();
    const afterSweep = await balanceOf(customer);

    // Same deposit, different webhook event id — which is exactly what a
    // redelivery after the sweep looks like.
    expect(
      (
        await deposit(
          { event_id: `evt_${randomUUID()}` },
          { id: reference, account_number: account.body.account_number, amount: '1000000' },
        )
      ).status,
    ).toBe(200);

    expect(await balanceOf(customer)).toBe(afterSweep);
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

describe('an account number without asking for one', () => {
  /*
   * THE ACTIVATE BUTTON IS GONE, and this is what replaced it: registering
   * opens the account. Asserted through the real endpoint, on an app built
   * with the switch the production config always sets — the shared fixture
   * turns it off so the other suites' registrations never reach a rail.
   *
   * No KYC anywhere in this path: the customer registered a moment ago, has
   * no approved identity, and is issued an account on the rail that opens
   * one from a name.
   */
  it('opens it at registration, unverified, without the customer asking', async () => {
    const registering = await boot(makeConfig({ openAccountOnRegistration: true }));
    try {
      const email = `fund-reg-${randomUUID()}@example.ng`;
      await request(registering.getHttpServer())
        .post('/v1/auth/register')
        .send({
          email,
          password: PASSWORD,
          full_name: 'Ngozi Adeyemi',
          country: 'NG',
          phone: String(8000000000 + Math.floor(Math.random() * 999999999)),
          device: { fingerprint: `fp-${randomUUID()}`, platform: 'web' },
        })
        .expect(201);

      // NOT awaited by the endpoint, deliberately — a signup must not wait
      // on a bank — so the row is polled for rather than expected at once.
      let rows = 0;
      for (let i = 0; i < 50 && rows === 0; i += 1) {
        const found = await pool.query(
          `SELECT 1 FROM virtual_accounts va JOIN users u ON u.id = va.user_id
            WHERE u.email = $1`,
          [email],
        );
        rows = found.rowCount ?? 0;
        if (rows === 0) await new Promise((r) => setTimeout(r, 100));
      }
      expect(rows).toBe(1);
      expect(port.created.at(-1)?.customer.email).toBe(email);
      expect(port.created.at(-1)?.currency).toBe('NGN');
    } finally {
      await registering.close();
    }
  });

  it('a registration whose rail refused still succeeds', async () => {
    // The account is ours to open later; the signup is the customer's, and a
    // bank having a bad moment must never cost them it.
    const registering = await boot(makeConfig({ openAccountOnRegistration: true }));
    try {
      port.failNextWith = new ProviderTimeoutError('bitnob', 'slow');
      await request(registering.getHttpServer())
        .post('/v1/auth/register')
        .send({
          email: `fund-reg-${randomUUID()}@example.ng`,
          password: PASSWORD,
          full_name: 'Ngozi Adeyemi',
          country: 'NG',
          phone: String(8000000000 + Math.floor(Math.random() * 999999999)),
          device: { fingerprint: `fp-${randomUUID()}`, platform: 'web' },
        })
        .expect(201);
      // Let the background attempt finish before the app closes under it.
      await new Promise((r) => setTimeout(r, 300));
    } finally {
      port.failNextWith = undefined;
      await registering.close();
    }
  });
});

describe('a rail that will not open an account until it has identified the customer', () => {
  /*
   * PRODUCTION'S REFUSAL, END TO END. Paystack answered every new customer's
   * account request with "Customer has not been identified" (HTTP 400), and
   * the customer read "could not be opened — this one is on us". These drive
   * the whole replacement: the question, the three answers, the wait, and
   * Paystack's own event finishing it.
   */
  const PAYSTACK_KEY = 'sk_test_identity_e2e';
  let paystackApp: INestApplication;

  beforeAll(async () => {
    paystackApp = await boot(makeConfig({ paystackSecretKey: PAYSTACK_KEY }));
  });
  afterAll(async () => {
    await paystackApp?.close();
  });

  async function withPhone(customer: Customer): Promise<string> {
    const phone = `+234${8000000000 + Math.floor(Math.random() * 999999999)}`;
    const found = await pool.query<{ email: string }>(
      `UPDATE users SET phone = $2 WHERE id = $1::bigint RETURNING email`,
      [customer.userId, phone],
    );
    return found.rows[0]?.email as string;
  }

  const identify = (customer: Customer, body: Record<string, unknown>) =>
    request(app.getHttpServer())
      .post('/v1/funding/account/identify')
      .set('Authorization', `Bearer ${customer.token}`)
      .send(body);

  const bvn = () => String(22000000000 + Math.floor(Math.random() * 999999999));
  const details = (b: string) => ({ bvn: b, bank_code: '058', account_number: '0123456789' });

  function paystackEvent(event: string, email: string, extra: Record<string, unknown> = {}) {
    const body = JSON.stringify({ event, data: { customer: { email, customer_code: 'CUS_x' }, ...extra } });
    return request(paystackApp.getHttpServer())
      .post('/v1/webhooks/paystack/deposits')
      .set('content-type', 'application/json')
      .set('x-paystack-signature', createHmac('sha512', PAYSTACK_KEY).update(body).digest('hex'))
      .send(body);
  }

  it('with no schedule to retry on, ASKS FOR IDENTITY rather than reporting a refusal, and records no fault', async () => {
    port.provider = 'paystack';
    port.identityRequired = true;
    const customer = await onboard(false);
    await withPhone(customer);
    const count = async () =>
      Number(
        (
          await pool.query<{ n: string }>(
            `SELECT coalesce(sum(occurrences), 0)::text AS n FROM account_refusals
              WHERE provider_code = 'identity_required'`,
          )
        ).rows[0]?.n ?? '0',
      );
    const before = await count();

    const res = await getAccount(customer).expect(422);
    expect(res.body.error).toBe('account_identity_required');

    // Not a fault an operator can fix, so not on the diagnostics screen.
    await new Promise((r) => setTimeout(r, 100));
    expect(await count()).toBe(before);
  });

  it('ASKS PAYSTACK AGAIN BEFORE ASKING THE CUSTOMER, and opens the account when it agrees', async () => {
    /*
     * The owner's report: Paystack opens naira accounts without a BVN, and
     * the reference plugin's accounts were opened by asking again on a
     * schedule after a first refusal. So the first answer is "being opened",
     * not the BVN form, and the account arrives without the customer giving
     * anything.
     */
    const retrying = await boot(makeConfig({ accountRetryDelaysMs: [40, 40, 40] }));
    try {
      port.provider = 'paystack';
      port.identityRequired = true;
      const customer = await onboard(false);
      const email = await withPhone(customer);
      // Signed in on THIS app: each boot has its own access-token keyring.
      const login = await request(retrying.getHttpServer())
        .post('/v1/auth/login')
        .send({
          identifier: email,
          password: PASSWORD,
          device: { fingerprint: `fp-${randomUUID()}`, platform: 'android' },
        })
        .expect(200);
      const token = login.body.access_token as string;
      const ask = () =>
        request(retrying.getHttpServer())
          .post('/v1/funding/account')
          .set('Authorization', `Bearer ${token}`)
          .send({});

      const first = await ask().expect(503);
      expect(first.body.error).toBe('account_issue_pending');

      // Paystack agrees on a later attempt — nothing from the customer.
      port.identified.add(email);
      await new Promise((r) => setTimeout(r, 200));

      const opened = await pool.query(
        `SELECT account_number FROM virtual_accounts WHERE user_id = $1::bigint AND status <> 'closed'`,
        [customer.userId],
      );
      expect(opened.rowCount).toBe(1);
      expect(port.created.filter((r) => r.customer.email === email).every((r) => r.identity === undefined)).toBe(
        true,
      );
    } finally {
      await retrying.close();
    }
  });

  it('OFFERS THE FORM ONLY WHEN EVERY ATTEMPT WAS REFUSED, and then shows the operator', async () => {
    const retrying = await boot(makeConfig({ accountRetryDelaysMs: [30, 30] }));
    try {
      port.provider = 'paystack';
      port.identityRequired = true;
      const customer = await onboard(false);
      const email = await withPhone(customer);
      // Signed in on THIS app: each boot has its own access-token keyring.
      const login = await request(retrying.getHttpServer())
        .post('/v1/auth/login')
        .send({
          identifier: email,
          password: PASSWORD,
          device: { fingerprint: `fp-${randomUUID()}`, platform: 'android' },
        })
        .expect(200);
      const token = login.body.access_token as string;
      const ask = () =>
        request(retrying.getHttpServer())
          .post('/v1/funding/account')
          .set('Authorization', `Bearer ${token}`)
          .send({});

      expect((await ask().expect(503)).body.error).toBe('account_issue_pending');
      const before = port.created.filter((r) => r.customer.email === email).length;
      await new Promise((r) => setTimeout(r, 250));
      // Asked again on the schedule, in the background.
      expect(port.created.filter((r) => r.customer.email === email).length).toBe(before + 2);

      const last = await ask().expect(422);
      expect(last.body.error).toBe('account_identity_required');
      await new Promise((r) => setTimeout(r, 100));
      const recorded = await pool.query(
        `SELECT 1 FROM account_refusals WHERE provider_code = 'identity_required'`,
      );
      expect(recorded.rowCount).toBeGreaterThan(0);
    } finally {
      await retrying.close();
    }
  });

  it('refuses a malformed BVN, and any field the account already holds', async () => {
    const customer = await onboard(false);
    await withPhone(customer);
    await identify(customer, { ...details('2200000000'), bank_code: '058' }).expect(400);
    await identify(customer, { ...details(bvn()), full_name: 'Somebody Else' }).expect(400);
  });

  it('SENDS THE DETAILS, KEEPS ONLY A FINGERPRINT, and says the account is on its way', async () => {
    port.provider = 'paystack';
    port.identityRequired = true;
    const customer = await onboard(false);
    await withPhone(customer);
    const theBvn = bvn();

    const res = await identify(customer, details(theBvn)).expect(503);
    expect(res.body.error).toBe('account_issue_pending');
    expect(port.created.at(-1)?.identity).toEqual({
      bvn: theBvn,
      bankCode: '058',
      accountNumber: '0123456789',
    });

    const rows = await pool.query(
      `SELECT row_to_json(c)::text AS row, bvn_fingerprint, bvn_last4, status
         FROM account_identity_checks c WHERE user_id = $1::bigint`,
      [customer.userId],
    );
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0].row).not.toContain(theBvn);
    expect(rows.rows[0].row).not.toContain('0123456789');
    expect(rows.rows[0].bvn_fingerprint).toMatch(/^v[0-9]+:[0-9a-f]{64}$/);
    expect(rows.rows[0].bvn_last4).toBe(theBvn.slice(-4));
    expect(rows.rows[0].status).toBe('submitted');

    // While Paystack matches, the screen hears "on its way", not the form…
    const again = await getAccount(customer).expect(503);
    expect(again.body.error).toBe('account_issue_pending');

    // …and a second submission is not sent at all.
    const sent = port.created.length;
    await identify(customer, details(theBvn)).expect(503);
    expect(port.created.length).toBe(sent);
  });

  it('refuses a BVN that stands for another customer — as a mismatch, sending nothing', async () => {
    port.provider = 'paystack';
    port.identityRequired = true;
    const first = await onboard(false);
    await withPhone(first);
    const second = await onboard(false);
    await withPhone(second);
    const shared = bvn();

    await identify(first, details(shared)).expect(503);
    const sent = port.created.length;
    const res = await identify(second, details(shared)).expect(422);
    expect(res.body.error).toBe('account_identity_failed');
    expect(port.created.length).toBe(sent);
  });

  it('asks for a phone number first, which Paystack requires here', async () => {
    port.provider = 'paystack';
    port.identityRequired = true;
    const customer = await onboard(false);
    const res = await identify(customer, details(bvn())).expect(409);
    expect(res.body.error).toBe('profile_incomplete');
    expect(res.body.field).toBe('phone');
    // The list the client reads, so the screen can say WHICH detail.
    expect(res.body.fields).toEqual(['phone']);
  });

  it("OPENS THE ACCOUNT ON PAYSTACK'S assign.success, by reading it rather than believing the event", async () => {
    port.provider = 'paystack';
    port.identityRequired = true;
    const customer = await onboard(false);
    const email = await withPhone(customer);
    await identify(customer, details(bvn())).expect(503);

    // Paystack has assigned the number; its event rings the bell.
    port.identified.add(email);
    await paystackEvent('dedicatedaccount.assign.success', email, {
      dedicated_account: { account_number: '9999999999' },
    }).expect(200);

    const status = await pool.query<{ status: string }>(
      `SELECT status FROM account_identity_checks WHERE user_id = $1::bigint`,
      [customer.userId],
    );
    expect(status.rows[0]?.status).toBe('validated');

    const read = await request(app.getHttpServer())
      .get('/v1/funding/account')
      .set('Authorization', `Bearer ${customer.token}`)
      .expect(200);
    // The number is the one READ from the rail, not the one the event named.
    expect(read.body.account?.account_number).toMatch(/^[0-9]{10}$/);
    expect(read.body.account?.account_number).not.toBe('9999999999');
  });

  it('brings the form back with a reason after assign.failed', async () => {
    port.provider = 'paystack';
    port.identityRequired = true;
    const customer = await onboard(false);
    const email = await withPhone(customer);
    await identify(customer, details(bvn())).expect(503);

    await paystackEvent('dedicatedaccount.assign.failed', email, {
      dedicated_account: null,
      identification: { status: 'failed' },
    }).expect(200);

    const res = await getAccount(customer).expect(422);
    expect(res.body.error).toBe('account_identity_failed');
  });

  it('acknowledges an identification event it cannot place, rather than having it retried for ever', async () => {
    await paystackEvent('customeridentification.success', `nobody-${randomUUID()}@example.ng`).expect(200);
  });

  it('ACKNOWLEDGES AN EVENT THAT IS NOT A DEPOSIT, rather than answering 500 for three days', async () => {
    // Paystack posts every event on the integration to this one URL. A card
    // charge for another product, or a refund, threw a contract error.
    const charge = {
      id: 1,
      reference: `other-${randomUUID()}`,
      amount: 500_000,
      currency: 'NGN',
      channel: 'card',
      status: 'success',
    };
    await paystackEvent('charge.success', `nobody-${randomUUID()}@example.ng`, charge).expect(200);
    await paystackEvent('refund.processed', `nobody-${randomUUID()}@example.ng`, {
      ...charge,
      reference: `refund-${randomUUID()}`,
    }).expect(200);
    const credited = await pool.query(
      `SELECT 1 FROM journal_entries WHERE idempotency_key = $1`,
      [`paystack:${charge.reference}`],
    );
    expect(credited.rowCount).toBe(0);
  });
});
