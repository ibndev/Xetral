import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { ExpressAdapter } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import pg from 'pg';
import type { Pool } from 'pg';
import { ProviderRejectedError, ProviderUnavailableError } from '@xetral/providers';
import type { CardPort, CardSecrets, OperationOutcome, VirtualCard } from '@xetral/providers';
import { usd } from '@xetral/shared';
import { LedgerService, posting } from '@xetral/ledger';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../app.module.js';
import { systemClock } from '../tokens.js';
import { testApiConfig } from '../test-support/api-config.js';
import { enrolAndElevate } from '../test-support/staff-totp.js';
import { approveKyc } from '../test-support/kyc-fixture.js';

/**
 * Provider health, through the real injection boundary.
 *
 * THE CLAIM WORTH PROVING HERE is not that the SQL counts correctly — 037's
 * suite does that — but that a provider failing in an ordinary flow reaches
 * the dashboard WITHOUT ANY CALL SITE KNOWING. The wrapper is applied once, in
 * `app.module.ts`, and if it were applied to the wrong thing or to nothing at
 * all every unit test would still pass.
 *
 * Requires DATABASE_URL with every migration applied.
 */
const DATABASE_URL = process.env['DATABASE_URL'];
if (DATABASE_URL === undefined || DATABASE_URL === '') {
  throw new Error('the provider health e2e suite needs DATABASE_URL');
}

const PASSWORD = 'a-long-enough-password';
const PIN = '374915';

/** Fails or refuses on demand, so both halves of the distinction can be
 *  driven through a real request. */
class FlakyCardPort implements CardPort {
  failNext: Error | undefined;

  #card(): VirtualCard {
    return {
      providerCardId: `bnc_${randomUUID()}`,
      status: 'active',
      last4: '4242',
      expiryMonth: 11,
      expiryYear: 2030,
      balance: usd(0),
    };
  }

  #maybeFail(): void {
    if (this.failNext !== undefined) {
      const error = this.failNext;
      this.failNext = undefined;
      throw error;
    }
  }

  async issue(): Promise<VirtualCard> {
    this.#maybeFail();
    return this.#card();
  }
  async fund(): Promise<OperationOutcome> {
    this.#maybeFail();
    return { state: 'settled' };
  }
  async freeze(): Promise<VirtualCard> {
    this.#maybeFail();
    return { ...this.#card(), status: 'frozen' };
  }
  async unfreeze(): Promise<VirtualCard> {
    this.#maybeFail();
    return this.#card();
  }
  async terminate(): Promise<VirtualCard> {
    this.#maybeFail();
    return { ...this.#card(), status: 'terminated' };
  }
  async get(): Promise<VirtualCard> {
    this.#maybeFail();
    return this.#card();
  }
  async reveal(): Promise<CardSecrets> {
    this.#maybeFail();
    return { pan: '4242424242424242', cvv: '123', expiryMonth: 11, expiryYear: 2030 };
  }
}

let pool: Pool;
let app: INestApplication;
let cardPort: FlakyCardPort;
let ledger: LedgerService;
let support: Customer;

interface Customer {
  identifier: string;
  userId: string;
  token: string;
}

async function register(): Promise<Customer> {
  const identifier = `health-${randomUUID()}@example.ng`;
  const res = await request(app.getHttpServer())
    .post('/v1/auth/register')
    .send({
      email: identifier,
      password: PASSWORD,
      // 040 made these required. A registration is now a name, a place
      // and a reachable number as well as an address.
      full_name: 'E2E Test Person',
      country: 'NG',
      phone: String(8000000000 + Math.floor(Math.random() * 999999999)),
      device: { fingerprint: `fp-${randomUUID()}`, platform: 'ios' },
    })
    .expect(201);
  const token = res.body.access_token as string;

  await request(app.getHttpServer())
    .post('/v1/auth/pin')
    .set('Authorization', `Bearer ${token}`)
    .send({ pin: PIN })
    .expect(204);

  const found = await pool.query<{ id: string }>(`SELECT id FROM users WHERE email = $1`, [
    identifier,
  ]);
  return { identifier, userId: found.rows[0]?.id as string, token };
}

/** Approval writes `provider_customers` AND the tier in one transaction; a
 *  fixture doing only the first describes a state production cannot reach —
 *  a customer every provider accepts whose ceiling is an unverified
 *  account's. */
async function verify(person: Customer): Promise<void> {
  // Verified, in the ONE place that knows what approval actually writes: an
  // approved `kyc_submissions` row (which is where a card's embossed name is
  // read from), the provider mapping, and the tier — all three, because
  // approval writes all three in one transaction.
  await approveKyc(pool, person.userId);

  // Dollars to fund the card with. Through the ledger, never by writing
  // `account_balances`: a materialised balance no posting explains is exactly
  // what `ledger_drift` reports, and the provider e2e suite reads it.
  await ledger.post({
    idempotencyKey: `health-fund:${randomUUID()}`,
    kind: 'wallet_funding',
    occurredAt: new Date(),
    description: 'test funding',
    metadata: {},
    postings: [
      posting({ kind: 'customer_wallet', ownerId: person.userId, currency: 'USD' }, usd(100_00)),
      posting({ kind: 'provider_float', currency: 'USD' }, usd(-100_00)),
    ],
  });
}

const issueCard = (person: Customer) =>
  request(app.getHttpServer())
    .post('/v1/cards')
    .set('Authorization', `Bearer ${person.token}`)
    .send({ transaction_pin: PIN, idempotency_key: randomUUID() });

async function healthFor(operation: string): Promise<
  { attempts: string; failures: string; rejected: string } | undefined
> {
  const rows = await pool.query(
    `SELECT attempts::text, failures::text, rejected::text
       FROM provider_health_recent WHERE provider = 'bitnob' AND operation = $1`,
    [operation],
  );
  return rows.rows[0] as never;
}

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: DATABASE_URL, max: 8 });
  ledger = new LedgerService(pool);
  cardPort = new FlakyCardPort();

  const mod = await Test.createTestingModule({
    imports: [
      AppModule.forRoot({
        config: testApiConfig(DATABASE_URL as string),
        pool,
        clock: systemClock,
        cardPort,
      }),
    ],
  }).compile();
  app = mod.createNestApplication(new ExpressAdapter());
  await app.init();

  support = await register();
  await pool.query(
    `INSERT INTO staff_roles (user_id, role, granted_by) VALUES ($1, 'support', $1)
     ON CONFLICT DO NOTHING`,
    [support.userId],
  );
  await enrolAndElevate(app, pool, support.token, support.userId);
});

afterAll(async () => {
  await app?.close();
  await pool?.end();
});

describe('a provider failing in a real flow', () => {
  it('is recorded without the card service knowing', async () => {
    // `CardService` has no idea health exists. The wrapper is applied once at
    // the injection boundary, which is what makes a new flow watched by
    // construction — and what this test would catch if it were wired to
    // nothing.
    const customer = await register();
    await verify(customer);

    const before = await healthFor('issue');
    cardPort.failNext = new ProviderUnavailableError('bitnob', 'connection refused');

    const res = await issueCard(customer);
    // The failure still reaches the caller unchanged: swallowing one to
    // record it would turn an outage into a silent success.
    expect(res.status).toBeGreaterThanOrEqual(500);

    // Fire and forget, so give the write a moment rather than awaiting it in
    // the request path — a slow health table must not become a slow card.
    await new Promise((resolve) => setTimeout(resolve, 250));

    const after = await healthFor('issue');
    expect(Number(after?.failures ?? 0)).toBe(Number(before?.failures ?? 0) + 1);
  });

  it('counts a REFUSAL apart from a failure', async () => {
    // The distinction the whole feature rests on. A refusal is the provider
    // working; counting it as ill health makes a busy decline rate look like
    // an outage.
    const customer = await register();
    await verify(customer);

    const before = await healthFor('issue');
    cardPort.failNext = new ProviderRejectedError('bitnob', 'not approved', 'KYC_REQUIRED');

    await issueCard(customer);
    await new Promise((resolve) => setTimeout(resolve, 250));

    const after = await healthFor('issue');
    expect(Number(after?.rejected ?? 0)).toBe(Number(before?.rejected ?? 0) + 1);
    // And NOT as a failure.
    expect(Number(after?.failures ?? 0)).toBe(Number(before?.failures ?? 0));
  });

  it('records a success too, so a quiet provider is distinguishable from a well one', async () => {
    const customer = await register();
    await verify(customer);

    const before = await healthFor('issue');
    expect((await issueCard(customer)).status).toBe(201);
    await new Promise((resolve) => setTimeout(resolve, 250));

    const after = await healthFor('issue');
    expect(Number(after?.attempts ?? 0)).toBeGreaterThan(Number(before?.attempts ?? 0));
  });
});

describe('what an operator sees', () => {
  it('reaches the dashboard', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/admin/providers')
      .set('Authorization', `Bearer ${support.token}`)
      .expect(200);

    const recent = res.body.recent as { provider: string; operation: string }[];
    expect(recent.some((r) => r.provider === 'bitnob' && r.operation === 'issue')).toBe(true);
  });

  it('is refused to a signed-in customer', async () => {
    const customer = await register();
    const res = await request(app.getHttpServer())
      .get('/v1/admin/providers')
      .set('Authorization', `Bearer ${customer.token}`);
    expect(res.status).toBe(403);
  });

  it('does NOT switch anything off by itself', async () => {
    // The decision, asserted rather than described. A flapping provider would
    // disable a flow nobody meant to stop, and re-enabling needs a person
    // anyway — so the automation would only add a surprise.
    const enabled = await pool.query<{ value: string }>(
      `SELECT value FROM platform_settings WHERE key = 'cards_enabled'`,
    );
    expect(enabled.rows[0]?.value).toBe('true');
  });
});
