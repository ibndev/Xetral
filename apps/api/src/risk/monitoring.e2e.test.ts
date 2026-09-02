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
import { enrolAndElevate } from '../test-support/staff-totp.js';
import { MonitoringService } from './monitoring.service.js';
import { SettingsService } from '../settings/settings.service.js';

/**
 * That the monitoring rules see money that moved THROUGH THE REAL FLOWS.
 *
 * The invariant suite already proves the arithmetic against postings it wrote
 * itself. What it cannot prove is that a customer's actual transfer produces
 * postings the rules recognise — and that is precisely where a monitoring
 * programme fails silently: the rules are correct, the flow writes something
 * slightly different, and the queue stays empty for ever while everything
 * reports healthy.
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
let monitoring: MonitoringService;
let settings: SettingsService;

/**
 * THE DAILY CEILING IS THE REPORTING THRESHOLD, out of the box.
 *
 * `transfer_daily_limit_kobo` ships at ₦5,000,000 and `risk_thresholds` puts
 * the NGN reporting threshold at the same figure — so with the defaults, no
 * single transfer can reach it and `large_value` fires on transfers only if an
 * operator moves one of the two. That is not a fault in either: the ceiling
 * exists to stop the transaction the threshold exists to report, and the rule
 * still fires on deposits, card settlements and crypto, none of which the
 * transfer ceiling governs.
 *
 * It does mean a suite asserting on a large TRANSFER has to raise the ceiling
 * and say why, rather than quietly picking an amount that happens to fit.
 */
const PINNED: Readonly<Record<string, string>> = {
  transfer_fee_basis_points: '0',
  transfer_daily_limit_kobo: '10000000000',
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
  const email = `risk-${randomUUID()}@example.ng`;
  const created = await request(app.getHttpServer())
    .post('/v1/auth/register')
    .send({
      email,
      password: PASSWORD,
      // 040 made these required. A registration is now a name, a place
      // and a reachable number as well as an address.
      full_name: 'E2E Test Person',
      country: 'NG',
      phone: String(8000000000 + Math.floor(Math.random() * 999999999)),
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

  // ENHANCED, and the reason is worth stating rather than working around.
  //
  // This suite asserts on what the MONITORING rules see, and a transfer
  // refused by a ceiling never reaches them — the queue would be empty and the
  // rules would look broken. But the ceiling that refuses is the TIER's, and
  // tier 1 allows ₦5,000,000 a day: exactly the NGN reporting threshold. So
  // with the shipped grid a single transfer AT the reporting threshold can
  // only be made by a customer somebody established a source of funds for,
  // which is a coherent policy and is also why this fixture is tier 2.
  //
  // One step at a time: the trigger refuses a jump that skips the evidence.
  for (const tier of [1, 2]) {
    await pool.query(`UPDATE users SET kyc_tier = $2 WHERE id = $1::bigint`, [found.id, tier]);
  }

  return { email, userId: found.id, uuid: found.uuid, token: created.body.access_token };
}

async function makeReviewer(): Promise<Person> {
  const person = await register();
  await pool.query(
    `INSERT INTO staff_roles (user_id, role, granted_by) VALUES ($1, 'compliance', $1)
     ON CONFLICT DO NOTHING`,
    [person.userId],
  );
  await enrolAndElevate(app, pool, person.token, person.userId);
  return person;
}

/** Money arriving, through the ledger service rather than an INSERT — so the
 *  postings are the shape the funding webhook writes. */
async function fund(userId: string, kobo: number): Promise<void> {
  // KOBO, and the parameter is named so because the first version of this
  // suite funded `700_000_00` meaning ₦7,000,000 and got ₦700,000 — the exact
  // slip integer minor units exist to prevent, made in a hand-written literal
  // where no type could catch it. It surfaced as `insufficient_funds`, which
  // says nothing about the mistake.
  await ledger.post({
    idempotencyKey: `risk-e2e:${randomUUID()}`,
    kind: 'wallet_funding',
    occurredAt: new Date(),
    description: 'monitoring e2e funding',
    metadata: {},
    postings: [
      posting({ kind: 'customer_wallet', ownerId: userId, currency: 'NGN' }, ngn(kobo)),
      posting({ kind: 'provider_float', currency: 'NGN' }, ngn(-kobo)),
    ],
  });
}

const signalsFor = async (userId: string): Promise<readonly string[]> =>
  (
    await pool.query<{ rule: string }>(
      `SELECT rule::text AS rule FROM risk_signals WHERE user_id = $1::bigint`,
      [userId],
    )
  ).rows.map((r) => r.rule);

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
  monitoring = app.get(MonitoringService);
  settings = app.get(SettingsService);

  for (const [key, value] of Object.entries(PINNED)) {
    await pool.query(`UPDATE platform_settings SET value = $2 WHERE key = $1`, [key, value]);
  }
  // The service caches for thirty seconds, so a bare UPDATE would be read by
  // the first assertion and not by the code under test.
  await settings.refresh();
});

afterAll(async () => {
  await app?.close();
  await pool?.end();
});

describe('watching real money move', () => {
  it('flags a large transfer made through the API', async () => {
    // The whole point of an end-to-end pass. The rules read postings; this
    // asserts that a transfer a customer actually made writes postings they
    // recognise, which is the join no unit test covers.
    const sender = await register();
    const recipient = await register();
    await fund(sender.userId, 700_000_000);

    await request(app.getHttpServer())
      .post('/v1/wallets/transfers')
      .set('Authorization', `Bearer ${sender.token}`)
      .send({
        recipient: recipient.email,
        amount: '6000000.00',
        currency: 'NGN',
        idempotency_key: randomUUID(),
        transaction_pin: PIN,
      })
      .expect(200);

    await monitoring.sweep();

    // The sender's side is a debit above the threshold; the recipient's is a
    // credit above it. Both are worth a look, and for different reasons.
    expect(await signalsFor(sender.userId)).toContain('large_value');
    expect(await signalsFor(recipient.userId)).toContain('large_value');
  });

  it('leaves an ordinary customer alone', async () => {
    // The assertion that decides whether anybody reads this queue. A rule that
    // fires on normal behaviour is a rule reviewers learn to clear without
    // looking, which is worse than no rule at all.
    const sender = await register();
    const recipient = await register();
    await fund(sender.userId, 5_000_000);

    await request(app.getHttpServer())
      .post('/v1/wallets/transfers')
      .set('Authorization', `Bearer ${sender.token}`)
      .send({
        recipient: recipient.email,
        amount: '2500.00',
        currency: 'NGN',
        idempotency_key: randomUUID(),
        transaction_pin: PIN,
      })
      .expect(200);

    await monitoring.sweep();
    expect(await signalsFor(sender.userId)).toEqual([]);
  });

  it('does not raise the same signal twice', async () => {
    const sender = await register();
    const recipient = await register();
    await fund(sender.userId, 700_000_000);

    await request(app.getHttpServer())
      .post('/v1/wallets/transfers')
      .set('Authorization', `Bearer ${sender.token}`)
      .send({
        recipient: recipient.email,
        amount: '6000000.00',
        currency: 'NGN',
        idempotency_key: randomUUID(),
        transaction_pin: PIN,
      })
      .expect(200);

    await monitoring.sweep();
    const first = (await signalsFor(sender.userId)).length;
    await monitoring.sweep();
    await monitoring.sweep();
    expect((await signalsFor(sender.userId)).length).toBe(first);
  });
});

describe('the compliance queue', () => {
  it('lists open signals and closes one with a reason', async () => {
    const reviewer = await makeReviewer();
    const customer = await register();
    const recipient = await register();
    await fund(customer.userId, 700_000_000);

    await request(app.getHttpServer())
      .post('/v1/wallets/transfers')
      .set('Authorization', `Bearer ${customer.token}`)
      .send({
        recipient: recipient.email,
        amount: '6000000.00',
        currency: 'NGN',
        idempotency_key: randomUUID(),
        transaction_pin: PIN,
      })
      .expect(200);

    await monitoring.sweep();

    const queue = await request(app.getHttpServer())
      .get('/v1/admin/risk/signals')
      .set('Authorization', `Bearer ${reviewer.token}`)
      .expect(200);

    const mine = (
      queue.body.signals as {
        id: string;
        email: string;
        detail: unknown;
        other_open_signals: number;
      }[]
    ).find((s) => s.email === customer.email);
    expect(mine).toBeDefined();
    // The evidence travels with the signal, so a reviewer can check the rule's
    // arithmetic rather than trust it.
    expect(mine?.detail).toMatchObject({ currency: 'NGN' });
    // And the queue says this customer has more than one open signal, which is
    // the difference between reviewing a transaction and reviewing a pattern.
    expect(mine?.other_open_signals).toBeGreaterThan(0);

    await request(app.getHttpServer())
      .post(`/v1/admin/risk/signals/${mine?.id ?? ''}/resolve`)
      .set('Authorization', `Bearer ${reviewer.token}`)
      .send({
        resolution: 'known property purchase, documents on file',
        transaction_pin: PIN,
      })
      .expect(200);

    // THAT signal is gone, and the customer's others are not.
    //
    // The first version of this asserted the customer had left the queue
    // entirely, and it failed — correctly. Funding this account with ₦7,000,000
    // is itself above the reporting threshold, so the customer had two signals
    // and resolving one leaves the other. That is the behaviour a reviewer
    // needs: closing one transaction must not close a second nobody looked at.
    const after = await request(app.getHttpServer())
      .get('/v1/admin/risk/signals')
      .set('Authorization', `Bearer ${reviewer.token}`)
      .expect(200);
    const remaining = (after.body.signals as { id: string; email: string }[]).filter(
      (s) => s.email === customer.email,
    );
    expect(remaining.some((s) => s.id === mine?.id)).toBe(false);
    expect(remaining.length).toBeGreaterThan(0);

    const audit = await pool.query<{ reason: string }>(
      `SELECT reason FROM admin_audit_log
        WHERE action = 'risk.resolve' AND subject_id = $1`,
      [mine?.id ?? ''],
    );
    expect(audit.rows[0]?.reason).toContain('property purchase');
  });

  it('refuses a resolution that says nothing', async () => {
    // "ok" is not a review. A queue cleared with one-word reasons is
    // indistinguishable from one nobody worked, and the reason is the only
    // part anybody can inspect afterwards.
    const reviewer = await makeReviewer();
    const customer = await register();
    const recipient = await register();
    await fund(customer.userId, 700_000_000);

    await request(app.getHttpServer())
      .post('/v1/wallets/transfers')
      .set('Authorization', `Bearer ${customer.token}`)
      .send({
        recipient: recipient.email,
        amount: '6000000.00',
        currency: 'NGN',
        idempotency_key: randomUUID(),
        transaction_pin: PIN,
      })
      .expect(200);
    await monitoring.sweep();

    const queue = await request(app.getHttpServer())
      .get('/v1/admin/risk/signals')
      .set('Authorization', `Bearer ${reviewer.token}`)
      .expect(200);
    const mine = (queue.body.signals as { id: string; email: string }[]).find(
      (s) => s.email === customer.email,
    );

    const res = await request(app.getHttpServer())
      .post(`/v1/admin/risk/signals/${mine?.id ?? ''}/resolve`)
      .set('Authorization', `Bearer ${reviewer.token}`)
      .send({ resolution: 'ok', transaction_pin: PIN });

    expect(res.status).toBe(400);
  });

  it('is refused to a signed-in customer', async () => {
    const customer = await register();
    const res = await request(app.getHttpServer())
      .get('/v1/admin/risk/signals')
      .set('Authorization', `Bearer ${customer.token}`);
    expect(res.status).toBe(403);
  });
});
