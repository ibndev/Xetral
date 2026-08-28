import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { ExpressAdapter } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import pg from 'pg';
import type { Pool } from 'pg';
import { hashPassword } from '@xetral/identity';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../app.module.js';
import { systemClock } from '../tokens.js';
import { testApiConfig } from '../test-support/api-config.js';
import { SettingsService } from './settings.service.js';

/**
 * The kill switches, against a real database.
 *
 * A unit test can prove a switch is *read somewhere*; only this can prove that
 * flipping the row in `platform_settings` actually changes what an HTTP request
 * gets back. That is the claim that failed before: `crypto_enabled` and
 * `fx_enabled` were rows an operator could change, the dashboard confirmed the
 * change, and every route carried on working.
 *
 * Requires DATABASE_URL with every migration and 009_admin.seed.sql applied.
 */
const DATABASE_URL = process.env['DATABASE_URL'];
if (DATABASE_URL === undefined || DATABASE_URL === '') {
  throw new Error('the kill-switch e2e suite needs DATABASE_URL with the migrations applied');
}

const PASSWORD = 'a-long-enough-password';
const PIN = '605183';

const SWITCHES = ['crypto_enabled', 'fx_enabled', 'cards_enabled', 'bills_enabled'] as const;

let pool: Pool;
let app: INestApplication;
let token: string;
let settings: SettingsService;
let original: Map<string, string>;

async function setSwitch(key: string, value: 'true' | 'false'): Promise<void> {
  await pool.query(`UPDATE platform_settings SET value = $2 WHERE key = $1`, [key, value]);
  // The settings cache is 30s, which is right for production and far too long
  // for a test. Refreshing is what the admin write path does after a change.
  await settings.refresh();
}

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: DATABASE_URL, max: 6 });

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

  const current = await pool.query<{ key: string; value: string }>(
    `SELECT key, value FROM platform_settings WHERE key = ANY($1::text[])`,
    [SWITCHES],
  );
  if (current.rows.length !== SWITCHES.length) {
    throw new Error('009_admin.seed.sql has not been applied, or is missing a kill switch');
  }
  original = new Map(current.rows.map((r) => [r.key, r.value]));

  const identifier = `switch-${randomUUID()}@example.ng`;
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
  // Verified, so a refusal below is the switch and never the identity gate.
  await pool.query(
    `INSERT INTO provider_customers (user_id, provider, provider_customer_id)
     VALUES ($1, 'bitnob', $2)`,
    [userId, `cus_${randomUUID()}`],
  );
  // AND THE TIER, because KYC approval sets both in ONE transaction.
  //
  // This fixture stands in for that approval, and a fixture that performs
  // half of an atomic operation is a fixture that tests a state production
  // cannot reach — here, a customer whom every provider accepts and whose
  // ceiling is still an unverified account's.
  await pool.query(`UPDATE users SET kyc_tier = 1 WHERE id = $1::bigint`, [userId]);

  const login = await request(app.getHttpServer())
    .post('/v1/auth/login')
    .send({
      identifier,
      password: PASSWORD,
      device: { fingerprint: `fp-${randomUUID()}`, platform: 'ios' },
    })
    .expect(200);
  token = login.body.access_token as string;

  await request(app.getHttpServer())
    .post('/v1/auth/pin')
    .set('Authorization', `Bearer ${token}`)
    .send({ pin: PIN })
    .expect(204);
});

afterAll(async () => {
  // Restore, or every suite running after this one against the same database
  // finds its service switched off and fails for an unrelated reason.
  for (const [key, value] of original ?? []) {
    await pool.query(`UPDATE platform_settings SET value = $2 WHERE key = $1`, [key, value]);
  }
  await app?.close();
  await pool?.end();
});

const auth = () => ({ Authorization: `Bearer ${token}` });

describe('a switched-off service refuses', () => {
  it('crypto', async () => {
    await setSwitch('crypto_enabled', 'false');
    const res = await request(app.getHttpServer())
      .post('/v1/crypto/addresses')
      .set(auth())
      .send({ asset: 'USDT', network: 'tron' });

    expect(res.status).toBe(503);
    expect(res.body.error).toBe('crypto_disabled');
    await setSwitch('crypto_enabled', 'true');
  });

  it('fx', async () => {
    await setSwitch('fx_enabled', 'false');
    const res = await request(app.getHttpServer())
      .get('/v1/fx/quote?from=NGN&to=USD&amount=1000.00')
      .set(auth());

    expect(res.status).toBe(503);
    expect(res.body.error).toBe('fx_disabled');
    await setSwitch('fx_enabled', 'true');
  });

  it('cards', async () => {
    await setSwitch('cards_enabled', 'false');
    const res = await request(app.getHttpServer())
      .post('/v1/cards')
      .set(auth())
      .send({
        name_on_card: 'A Customer',
        initial_funding: '5.00',
        transaction_pin: PIN,
        idempotency_key: randomUUID(),
      });

    expect(res.status).toBe(503);
    expect(res.body.error).toBe('cards_disabled');
    await setSwitch('cards_enabled', 'true');
  });

  it('bills', async () => {
    await setSwitch('bills_enabled', 'false');
    const res = await request(app.getHttpServer())
      .get('/v1/purchases/catalogue?service=airtime')
      .set(auth());

    // The catalogue is a READ and stays open deliberately — a customer should
    // be able to see what exists while purchasing is paused. It answers 503
    // here for an unrelated reason (VTpass has no credentials in a test
    // environment), so the assertion is on the CODE: whatever the catalogue
    // refuses for, it must not be the kill switch.
    expect(res.body.error).not.toBe('bills_disabled');

    const buy = await request(app.getHttpServer())
      .post('/v1/purchases')
      .set(auth())
      .send({
        service: 'airtime',
        item_code: 'mtn',
        target: '08012345678',
        amount: '100.00',
        transaction_pin: PIN,
        idempotency_key: randomUUID(),
      });

    expect(buy.status).toBe(503);
    expect(buy.body.error).toBe('bills_disabled');
    await setSwitch('bills_enabled', 'true');
  });
});

describe('a switched-off service still', () => {
  it('authenticates — off must not mean open', async () => {
    // A disabled feature becoming an UNAUTHENTICATED one is the failure mode
    // worth testing for: the guard runs before the service, so the switch can
    // never be the thing that lets an anonymous caller in.
    await setSwitch('crypto_enabled', 'false');
    const res = await request(app.getHttpServer())
      .post('/v1/crypto/addresses')
      .send({ asset: 'USDT', network: 'tron' });

    expect(res.status).toBe(401);
    await setSwitch('crypto_enabled', 'true');
  });

  it('lets a customer read what they already hold', async () => {
    // Switching a service off pauses new commitments. It must not hide money
    // a customer already has — that reads as "my funds have vanished" at
    // exactly the moment they are being told nothing.
    await setSwitch('crypto_enabled', 'false');
    const res = await request(app.getHttpServer()).get('/v1/crypto/withdrawals').set(auth());
    expect(res.status).toBe(200);
    await setSwitch('crypto_enabled', 'true');
  });

  it('lets a customer freeze a card while cards are paused', async () => {
    // The protective action must never be behind the switch. If cards are off
    // because the provider is in trouble, a customer watching fraudulent
    // charges land still has to be able to stop them.
    await setSwitch('cards_enabled', 'false');
    const res = await request(app.getHttpServer())
      .post(`/v1/cards/${randomUUID()}/freeze`)
      .set(auth())
      .send({});

    // 404 — no such card for this customer. The point is what it is NOT:
    // reaching the ownership lookup at all proves the switch did not refuse.
    expect(res.status).toBe(404);
    expect(res.body.error).not.toBe('cards_disabled');
    await setSwitch('cards_enabled', 'true');
  });
});
