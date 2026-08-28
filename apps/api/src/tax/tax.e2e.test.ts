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
import { ngn } from '@xetral/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../app.module.js';
import type { ApiConfig } from '../config.js';
import { systemClock } from '../tokens.js';
import { testApiConfig } from '../test-support/api-config.js';

/**
 * Tax, over HTTP and into the ledger.
 *
 * THE PROPERTY WORTH PROVING is that the customer pays exactly what they paid
 * before. VAT-inclusive means turning tax on corrects the BOOKS and not the
 * price — and if that is not true, a booking change shipped as a silent price
 * rise.
 *
 * Requires DATABASE_URL with the migrations applied, 032 included.
 */
const DATABASE_URL = process.env['DATABASE_URL'];
if (DATABASE_URL === undefined || DATABASE_URL === '') {
  throw new Error('the tax e2e suite needs DATABASE_URL with the migrations applied');
}

const PASSWORD = 'a-long-enough-password';
const PIN = '374915';

let pool: Pool;
let ledger: LedgerService;
let app: INestApplication;

function makeConfig(overrides: Partial<ApiConfig> = {}): ApiConfig {
  return testApiConfig(DATABASE_URL as string, overrides);
}

interface Customer {
  identifier: string;
  userId: string;
  token: string;
}

async function onboard(instance: INestApplication): Promise<Customer> {
  const identifier = `tax-${randomUUID()}@example.ng`;
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
      device: { fingerprint: `fp-${randomUUID()}`, platform: 'ios' },
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

async function fund(userId: string, minor: number): Promise<void> {
  await ledger.post({
    idempotencyKey: `tax-fund:${randomUUID()}`,
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

/** Funds a wallet in dollars, for the currency check the levy has to pass. */
async function fundUsd(userId: string, minor: number): Promise<void> {
  await ledger.post({
    idempotencyKey: `tax-fund-usd:${randomUUID()}`,
    kind: 'wallet_funding',
    occurredAt: new Date(),
    description: 'test funding',
    metadata: {},
    postings: [
      posting(
        { kind: 'customer_wallet', ownerId: userId, currency: 'USD' },
        { amount: BigInt(minor), currency: 'USD' },
      ),
      posting({ kind: 'provider_float', currency: 'USD' }, { amount: BigInt(-minor), currency: 'USD' }),
    ],
  });
}

const transfer = (
  instance: INestApplication,
  from: Customer,
  to: Customer,
  amount: string,
  idempotencyKey: string = randomUUID(),
  currency: 'NGN' | 'USD' = 'NGN',
) =>
  request(instance.getHttpServer())
    .post('/v1/wallets/transfers')
    .set('Authorization', `Bearer ${from.token}`)
    .send({
      recipient: to.identifier,
      amount,
      currency,
      transaction_pin: PIN,
      idempotency_key: idempotencyKey,
    });

/** What each account received on one entry, in minor units. */
async function legsOf(entryUuid: string): Promise<Record<string, bigint>> {
  const rows = await pool.query<{ kind: string; amount_minor: string }>(
    `SELECT a.kind::TEXT AS kind, p.amount_minor::TEXT AS amount_minor
       FROM postings p
       JOIN accounts a        ON a.id = p.account_id
       JOIN journal_entries e ON e.id = p.journal_entry_id
      WHERE e.uuid = $1`,
    [entryUuid],
  );
  const legs: Record<string, bigint> = {};
  for (const row of rows.rows) {
    legs[row.kind] = (legs[row.kind] ?? 0n) + BigInt(row.amount_minor);
  }
  return legs;
}

async function setSetting(key: string, value: string): Promise<void> {
  await pool.query(`UPDATE platform_settings SET value = $2 WHERE key = $1`, [key, value]);
}

/**
 * Applies settings and hands back an app that has actually READ them.
 *
 * `SettingsService` caches for thirty seconds, which is correct in production
 * and invisible in a suite that finishes in seven — the first version of this
 * file wrote the rows, watched every transfer charge the seed's figures, and
 * two tests passed because those figures were what they expected. A fresh app
 * loads settings at bootstrap, so the values under test are the ones in force.
 */
async function appWithSettings(settings: Record<string, string>): Promise<INestApplication> {
  for (const [key, value] of Object.entries(settings)) await setSetting(key, value);
  return createApp(makeConfig());
}

/**
 * KYC approval writes `provider_customers` AND `users.kyc_tier` in ONE
 * transaction, so a fixture doing only the first describes a state production
 * cannot reach. The limit in force is the LOWER of the tier's and the flow's,
 * and tier 0 allows no dollars at all — which would refuse this suite's USD
 * transfer for a reason that has nothing to do with tax.
 */
async function verify(userId: string, tier = 1): Promise<void> {
  // ONE STEP AT A TIME, because 029 refuses a skip by trigger: giving enhanced
  // due diligence to somebody whose identity was never checked makes the higher
  // ceiling rest on nothing. A fixture that jumps straight to 2 is describing a
  // state production cannot reach, and the trigger says so.
  for (let step = 1; step <= tier; step += 1) {
    await pool.query(`UPDATE users SET kyc_tier = $2 WHERE id = $1`, [userId, step]);
  }
}

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: DATABASE_URL, max: 8 });
  ledger = new LedgerService(pool);
  app = await createApp(makeConfig());
});

async function createApp(config: ApiConfig): Promise<INestApplication> {
  const mod = await Test.createTestingModule({
    imports: [AppModule.forRoot({ config, pool, clock: systemClock })],
  }).compile();
  const created = mod.createNestApplication(new ExpressAdapter());
  await created.init();
  return created;
}

/*
 * PUT BACK WHAT THIS SUITE CHANGED.
 *
 * The e2e files share one database and run in file order, and a suite that
 * leaves a fee or a levy behind changes what every later suite charges. The
 * crypto suite learned this the day two unrelated files shifted the order —
 * ordering is not a guarantee, so a suite restores what it moved.
 */
afterAll(async () => {
  await pool?.query(
    `UPDATE platform_settings SET value = v.value
       FROM (VALUES ('transfer_fee_basis_points', '0'),
                    ('vat_basis_points', '750'),
                    ('vat_inclusive', 'true'),
                    ('transfer_levy_enabled', 'false')) AS v(key, value)
      WHERE platform_settings.key = v.key`,
  );
  await app?.close();
  await pool?.end();
});

describe('VAT on a transfer fee', () => {
  it('splits the fee without changing what the customer pays', async () => {
    const instance = await appWithSettings({
      transfer_fee_basis_points: '150',
      vat_basis_points: '750',
      vat_inclusive: 'true',
    });
    try {
      const alice = await onboard(instance);
      const bob = await onboard(instance);
      await fund(alice.userId, 10_000_00);

      const res = await transfer(instance, alice, bob, '1000.00');

      expect(res.status).toBe(200);
      // UNCHANGED. 1.5% of N1,000 is N15.00 with VAT on and with VAT off; that
      // is what "inclusive" means, and it is the whole reason this is safe to
      // ship without a pricing decision behind it.
      expect(res.body.fee).toBe('15.00');

      const legs = await legsOf(res.body.entry_id as string);
      // N15.00 inclusive of 7.5%: 1500 * 750 / 10750 = 104.65, rounded UP
      // toward the revenue authority. The two legs sum to the fee.
      expect(legs['liability_tax_payable']).toBe(105n);
      expect(legs['revenue_fees']).toBe(1395n);
      // Both wallet legs summed: the sender pays amount + fee and the
      // recipient receives the amount, so what is left is the fee — and the
      // two legs above account for all of it.
      expect(legs['customer_wallet']).toBe(-1500n);
    } finally {
      await instance.close();
    }
  });

  it('records what was collected, against the entry that moved it', async () => {
    const instance = await appWithSettings({ transfer_fee_basis_points: '150' });
    try {
      const alice = await onboard(instance);
      const bob = await onboard(instance);
      await fund(alice.userId, 10_000_00);

      const res = await transfer(instance, alice, bob, '1000.00');
      expect(res.status).toBe(200);

      const collections = await pool.query<{
        kind: string;
        amount_minor: string;
        base_minor: string;
        rate_applied: string;
      }>(
        `SELECT c.kind::TEXT AS kind, c.amount_minor::TEXT, c.base_minor::TEXT, c.rate_applied
           FROM tax_collections c
           JOIN journal_entries e ON e.id = c.entry_id
          WHERE e.uuid = $1`,
        [res.body.entry_id],
      );

      // The POSTING as well as the record. "Against the entry that moved it"
      // is only true if something moved: a test asserting the row alone stays
      // green with the tax leg deleted, and nothing else would catch that —
      // `tax_remittance_drift` reports money HELD with no collection, and this
      // is the mirror image, which looks exactly like a remittance.
      expect((await legsOf(res.body.entry_id as string))['liability_tax_payable']).toBe(105n);

      expect(collections.rows).toHaveLength(1);
      expect(collections.rows[0]).toMatchObject({
        kind: 'vat',
        amount_minor: '105',
        // Charged on the FEE, never on the amount being transferred: what is
        // taxed is the service, not the money moving.
        base_minor: '1395',
        rate_applied: '750bp',
      });
    } finally {
      await instance.close();
    }
  });

  it('is recorded on the ENTRY\'S transaction, so a replay adds nothing', async () => {
    // A retried transfer is a replay at the ledger. If the collection were
    // written afterwards on its own connection, the retry would double what a
    // return says was collected while the postings — correctly — did not move.
    const instance = await appWithSettings({ transfer_fee_basis_points: '150' });
    try {
      const alice = await onboard(instance);
      const bob = await onboard(instance);
      await fund(alice.userId, 10_000_00);

      const key = randomUUID();
      const first = await transfer(instance, alice, bob, '1000.00', key);
      expect(first.status).toBe(200);
      const again = await transfer(instance, alice, bob, '1000.00', key);
      expect(again.body.replayed).toBe(true);

      const collections = await pool.query(
        `SELECT 1 FROM tax_collections c JOIN journal_entries e ON e.id = c.entry_id
          WHERE e.uuid = $1`,
        [first.body.entry_id],
      );
      expect(collections.rowCount).toBe(1);
    } finally {
      await instance.close();
    }
  });

  it('records nothing when the rate is zero', async () => {
    // A row saying "we collected nothing" is indistinguishable from one
    // somebody forgot to write, and the ledger refuses a zero-amount posting
    // for the same reason.
    const instance = await appWithSettings({
      transfer_fee_basis_points: '150',
      vat_basis_points: '0',
    });
    try {
      const alice = await onboard(instance);
      const bob = await onboard(instance);
      await fund(alice.userId, 10_000_00);

      const res = await transfer(instance, alice, bob, '1000.00');
      expect(res.status).toBe(200);
      expect(res.body.fee).toBe('15.00');

      const legs = await legsOf(res.body.entry_id as string);
      // The fee still posts in full. A zero-rate VAT on a real fee must not
      // swallow the fee with it — which is why the legs are three
      // conditionals rather than one.
      expect(legs['revenue_fees']).toBe(1500n);
      expect(legs['liability_tax_payable']).toBeUndefined();

      const collections = await pool.query(
        `SELECT 1 FROM tax_collections c JOIN journal_entries e ON e.id = c.entry_id
          WHERE e.uuid = $1`,
        [res.body.entry_id],
      );
      expect(collections.rowCount).toBe(0);
    } finally {
      await instance.close();
    }
  });

  it('leaves a fee-free transfer with no tax leg at all', async () => {
    const instance = await appWithSettings({ transfer_fee_basis_points: '0' });
    try {
      const alice = await onboard(instance);
      const bob = await onboard(instance);
      await fund(alice.userId, 10_000_00);

      const res = await transfer(instance, alice, bob, '1000.00');
      expect(res.status).toBe(200);

      const legs = await legsOf(res.body.entry_id as string);
      expect(legs['revenue_fees']).toBeUndefined();
      expect(legs['liability_tax_payable']).toBeUndefined();
    } finally {
      await instance.close();
    }
  });
});

describe('the transfer levy', () => {
  it('charges nothing while it is off', async () => {
    // The shipped default. Turning it on changes what customers are charged,
    // so the state this asserts is the one an instance nobody has configured
    // is in.
    const instance = await appWithSettings({ transfer_levy_enabled: 'false' });
    try {
      const alice = await onboard(instance);
      const bob = await onboard(instance);
      await fund(alice.userId, 50_000_00);

      const res = await transfer(instance, alice, bob, '20000.00');
      expect(res.status).toBe(200);
      expect((await legsOf(res.body.entry_id as string))['liability_tax_payable']).toBeUndefined();
    } finally {
      await instance.close();
    }
  });

  it('charges a flat amount at the threshold, and nothing below it', async () => {
    const instance = await appWithSettings({
      transfer_levy_enabled: 'true',
      transfer_fee_basis_points: '0',
    });
    try {
      const alice = await onboard(instance);
      const bob = await onboard(instance);
      await fund(alice.userId, 40_000_00);
      // The daily NGN ceiling is the LOWER of the tier's and the flow's, and
      // two transfers of ~N10,000 sit above tier 0's N50,000 once the earlier
      // ones in this file are counted. Verified, so the refusal under test is
      // the levy's and not a limit's.
      await verify(alice.userId, 2);

      // One kobo under N10,000.00.
      const below = await transfer(instance, alice, bob, '9999.99');
      expect(below.status).toBe(200);
      expect(
        (await legsOf(below.body.entry_id as string))['liability_tax_payable'],
      ).toBeUndefined();

      const at = await transfer(instance, alice, bob, '10000.00');
      expect(at.status).toBe(200);
      // N50.00 flat, not a percentage of anything.
      expect((await legsOf(at.body.entry_id as string))['liability_tax_payable']).toBe(5000n);

      const collections = await pool.query<{ kind: string; rate_applied: string }>(
        `SELECT c.kind::TEXT AS kind, c.rate_applied
           FROM tax_collections c JOIN journal_entries e ON e.id = c.entry_id
          WHERE e.uuid = $1`,
        [at.body.entry_id],
      );
      expect(collections.rows).toEqual([{ kind: 'transfer_levy', rate_applied: 'flat' }]);
    } finally {
      await instance.close();
    }
  });

  it('never applies a kobo figure to another currency', async () => {
    // The levy is published in kobo and is a statement about naira. Charging
    // it on dollars because both are integers is the same mistake as adding
    // kobo to cents.
    const instance = await appWithSettings({ transfer_levy_enabled: 'true' });
    try {
      const alice = await onboard(instance);
      const bob = await onboard(instance);
      await verify(alice.userId, 2);
      await fundUsd(alice.userId, 500_00);

      const res = await transfer(instance, alice, bob, '400.00', undefined, 'USD');
      expect(res.status).toBe(200);
      expect((await legsOf(res.body.entry_id as string))['liability_tax_payable']).toBeUndefined();
    } finally {
      await instance.close();
    }
  });
});
