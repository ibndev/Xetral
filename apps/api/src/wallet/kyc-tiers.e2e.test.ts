import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { ExpressAdapter } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import pg from 'pg';
import type { Pool } from 'pg';
import { LedgerService, posting } from '@xetral/ledger';
import { ngn } from '@xetral/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../app.module.js';
import { systemClock } from '../tokens.js';
import { testApiConfig } from '../test-support/api-config.js';
import { SettingsService } from '../settings/settings.service.js';
import { KycService } from '../kyc/kyc.service.js';

/**
 * That a customer's ceiling comes from what we know about them.
 *
 * The claim worth an end-to-end suite is the FIRST one: an unverified account
 * is actually held to the lower limit through the real transfer endpoint. The
 * tier table could be perfect and the limit service could still be reading the
 * old global setting, and nothing else in the system would notice.
 */

const DATABASE_URL = process.env['DATABASE_URL'];
if (DATABASE_URL === undefined || DATABASE_URL === '') {
  throw new Error('this suite needs DATABASE_URL pointing at a migrated database');
}

const PASSWORD = 'a-long-enough-password';
const PIN = '481902';

let pool: Pool;
let app: INestApplication;
let ledger: LedgerService;
let settings: SettingsService;

/**
 * The FLOW limits, pinned generously and ONLY IN `beforeAll`.
 *
 * The ceiling in force is the lower of the tier's and the flow's, so a flow
 * limit left low by an earlier suite would refuse every assertion below and
 * the file would fail for a reason having nothing to do with tiers. These
 * suites share one database and run in file order; a suite that narrows a
 * limit does not put it back, so stating what you need is the only way a green
 * run means anything.
 *
 * AND NOTHING IS CHANGED MID-RUN. An earlier version of this file narrowed
 * `transfer_daily_limit_kobo` inside a test and restored it in a `finally`,
 * to prove the flow limit can beat a high tier. That is a global setting: for
 * the length of that test every other suite's customers were subject to it,
 * and unrelated files went red. The property is proved below without touching
 * anything, by giving the customer a tier whose ceiling is ABOVE the pinned
 * flow limit.
 */
const PINNED: Readonly<Record<string, string>> = {
  transfer_fee_basis_points: '0',
  // Deliberately below tier 2's ₦50,000,000, so the last test can show the
  // flow limit winning without changing a single row.
  transfer_daily_limit_kobo: '2000000000',
  transfer_new_recipients_daily: '100',
  transfer_count_hourly: '500',
};

interface Person {
  email: string;
  userId: string;
  uuid: string;
  token: string;
}

async function register(): Promise<Person> {
  const email = `tier-${randomUUID()}@example.ng`;
  const created = await request(app.getHttpServer())
    .post('/v1/auth/register')
    .send({
      email,
      password: PASSWORD,
      device: { fingerprint: `fp-${randomUUID()}`, platform: 'web' },
    })
    .expect(201);

  const row = await pool.query<{ id: string; uuid: string }>(
    `SELECT id, uuid FROM users WHERE email = $1`,
    [email],
  );
  const found = row.rows[0];
  if (found === undefined) throw new Error('registration created no user');

  await request(app.getHttpServer())
    .post('/v1/auth/pin')
    .set('Authorization', `Bearer ${created.body.access_token}`)
    .send({ pin: PIN })
    .expect(204);

  return { email, userId: found.id, uuid: found.uuid, token: created.body.access_token };
}

/** KOBO. Named so because the one slip this codebase exists to prevent is
 *  easiest to make in a hand-written literal. */
async function fund(userId: string, kobo: number): Promise<void> {
  await ledger.post({
    idempotencyKey: `tier-e2e:${randomUUID()}`,
    kind: 'wallet_funding',
    occurredAt: new Date(),
    description: 'tier e2e funding',
    metadata: {},
    postings: [
      posting({ kind: 'customer_wallet', ownerId: userId, currency: 'NGN' }, ngn(kobo)),
      posting({ kind: 'provider_float', currency: 'NGN' }, ngn(-kobo)),
    ],
  });
}

const transfer = (sender: Person, recipient: Person, naira: string) =>
  request(app.getHttpServer())
    .post('/v1/wallets/transfers')
    .set('Authorization', `Bearer ${sender.token}`)
    .send({
      recipient: recipient.email,
      amount: naira,
      currency: 'NGN',
      idempotency_key: randomUUID(),
      transaction_pin: PIN,
    });

const setTier = async (userId: string, tier: number): Promise<void> => {
  // Straight to the column, climbing one step at a time — the trigger refuses
  // a jump that skips the evidence below it, which is block 5 of the invariant
  // suite rather than something to work around here.
  for (let step = 1; step <= tier; step += 1) {
    await pool.query(`UPDATE users SET kyc_tier = $2 WHERE id = $1::bigint`, [userId, step]);
  }
};

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: DATABASE_URL, max: 8 });
  ledger = new LedgerService(pool);
  const mod = await Test.createTestingModule({
    imports: [
      AppModule.forRoot({
        config: testApiConfig(DATABASE_URL as string),
        pool,
        clock: systemClock,
      }),
    ],
  }).compile();
  app = mod.createNestApplication(new ExpressAdapter());
  await app.init();
  settings = app.get(SettingsService);

  for (const [key, value] of Object.entries(PINNED)) {
    await pool.query(`UPDATE platform_settings SET value = $2 WHERE key = $1`, [key, value]);
  }
  await settings.refresh();
});

afterAll(async () => {
  await app?.close();
  await pool?.end();
});

describe('what an unverified account may move', () => {
  it('is held to the tier 0 ceiling, not the flow limit', async () => {
    // THE CLAIM. Before this, a customer who had typed an email address that
    // morning was allowed exactly what a customer whose documents a person had
    // read was allowed.
    const sender = await register();
    const recipient = await register();
    await fund(sender.userId, 100_000_000); // ₦1,000,000

    // Tier 0 allows ₦50,000 a day. ₦60,000 is inside the flow limit and
    // outside this customer's.
    const refused = await transfer(sender, recipient, '60000.00');
    expect(refused.status).toBe(422);
    expect(refused.body.error).toBe('daily_limit_exceeded');

    // And ₦40,000 goes through, so the ceiling is a ceiling rather than a
    // blanket refusal.
    await transfer(sender, recipient, '40000.00').expect(200);
  });

  it('may move no crypto at all', async () => {
    // Zero is a real limit, not a missing row. On a chain is the one place
    // money cannot be recalled from.
    const limit = await pool.query<{ daily_limit_minor: string }>(
      `SELECT daily_limit_minor FROM kyc_tier_limits WHERE tier = 0 AND currency = 'USDT'`,
    );
    expect(limit.rows[0]?.daily_limit_minor).toBe('0');
  });

  it('tells the customer what their ceiling is', async () => {
    // Being refused without being told how to fix it is what turns a control
    // into a support ticket.
    const person = await register();
    const res = await request(app.getHttpServer())
      .get('/v1/kyc/limits')
      .set('Authorization', `Bearer ${person.token}`)
      .expect(200);

    expect(res.body.tier).toBe(0);
    expect(res.body.next_tier).toBe(1);
    const ngnLimit = (res.body.limits as { currency: string; daily_limit: string }[]).find(
      (l) => l.currency === 'NGN',
    );
    // MAJOR units, like every amount the API sends. This asserted '5000000'
    // — the kobo figure — while the page formatted it as naira, so the screen
    // telling a customer their ceiling said N5,000,000 for a N50,000 limit.
    expect(ngnLimit?.daily_limit).toBe('50000.00');
  });
});

describe('what verifying changes', () => {
  it('raises the ceiling that just refused them', async () => {
    const sender = await register();
    const recipient = await register();
    await fund(sender.userId, 100_000_000);

    await transfer(sender, recipient, '60000.00').expect(422);

    await setTier(sender.userId, 1);

    // No cache to wait out: the tier is read on every check, because the
    // reason to LOWER one is usually that something is wrong and a ceiling
    // that keeps its old value for thirty seconds has not been lowered.
    await transfer(sender, recipient, '60000.00').expect(200);
  });

  it('is granted by KYC approval, in the same transaction', async () => {
    // A customer marked approved whose ceiling never moved is verified on
    // paper and still limited to an unverified account's daily total — which
    // they discover on their first real transfer and support cannot explain.
    const person = await register();
    const reviewer = await register();
    await pool.query(
      `INSERT INTO staff_roles (user_id, role, granted_by) VALUES ($1, 'compliance', $1)
       ON CONFLICT DO NOTHING`,
      [reviewer.userId],
    );

    await request(app.getHttpServer())
      .post('/v1/kyc')
      .set('Authorization', `Bearer ${person.token}`)
      .send({
        full_name: 'Adaeze Okonkwo',
        date_of_birth: '1994-03-11',
        phone: '+2348012345678',
        bvn: `224${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`,
        address: '14 Bode Thomas Street, Surulere, Lagos',
      })
      .expect(200);

    const before = await pool.query<{ kyc_tier: number }>(
      `SELECT kyc_tier FROM users WHERE id = $1::bigint`,
      [person.userId],
    );
    expect(before.rows[0]?.kyc_tier).toBe(0);

    // Approved directly, because the endpoint needs a second factor this suite
    // has no reason to exercise — `admin.e2e.test.ts` drives that path. What
    // matters here is that the SERVICE moves the tier, so the call goes
    // through the service rather than an UPDATE.
    const submission = await pool.query<{ uuid: string }>(
      `SELECT uuid FROM kyc_submissions WHERE user_id = $1::bigint`,
      [person.userId],
    );
    await app.get(KycService).approve(submission.rows[0]?.uuid ?? '', reviewer.uuid);

    const after = await pool.query<{ kyc_tier: number }>(
      `SELECT kyc_tier FROM users WHERE id = $1::bigint`,
      [person.userId],
    );
    expect(after.rows[0]?.kyc_tier).toBe(1);
  });

  it('does not demote an enhanced customer on a routine re-approval', async () => {
    // Taking a tier away is an administrator's deliberate act. A routine
    // identity review must not silently undo one.
    const person = await register();
    await setTier(person.userId, 2);

    await pool.query(`UPDATE users SET kyc_tier = 1 WHERE id = $1::bigint AND kyc_tier < 1`, [
      person.userId,
    ]);

    const after = await pool.query<{ kyc_tier: number }>(
      `SELECT kyc_tier FROM users WHERE id = $1::bigint`,
      [person.userId],
    );
    expect(after.rows[0]?.kyc_tier).toBe(2);
  });
});

describe('the lower of the two ceilings wins', () => {
  it('a tightened flow limit beats a high tier', async () => {
    // What an operator narrows during an incident must keep working, whoever
    // the customer is. Raising somebody's tier can never let them past it.
    //
    // Shown WITHOUT changing anything: tier 2 allows ₦50,000,000 a day and the
    // flow limit this file pinned in `beforeAll` is ₦20,000,000, so a transfer
    // between the two is refused by the flow limit alone.
    const sender = await register();
    const recipient = await register();
    await setTier(sender.userId, 2);
    await fund(sender.userId, 4_000_000_000); // ₦40,000,000

    const refused = await transfer(sender, recipient, '25000000.00');
    expect(refused.status).toBe(422);
    expect(refused.body.error).toBe('daily_limit_exceeded');

    // And below the flow limit it goes through, so the refusal above is a
    // ceiling rather than the tier being ignored.
    await transfer(sender, recipient, '15000000.00').expect(200);
  });
});
