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
import { approveKyc } from '../test-support/kyc-fixture.js';

/**
 * Enabled, Coming soon and HIDDEN (093), against a real database — crypto
 * first, because it is the service the owner is hiding.
 *
 * Coming soon must stay exactly what it was: the reads still answer and only
 * what moves money is refused. Hidden must reach every customer surface the
 * service owns — its routes, and the currencies it takes with it from the
 * wallet list, the dollar total, history and Convert.
 *
 * Requires DATABASE_URL with every migration applied, 093 included.
 */
const DATABASE_URL = process.env['DATABASE_URL'];
if (DATABASE_URL === undefined || DATABASE_URL === '') {
  throw new Error('the feature-visibility e2e suite needs DATABASE_URL with the migrations applied');
}

const PASSWORD = 'a-long-enough-password';
const KEYS = ['crypto_enabled', 'crypto_when_off', 'fx_enabled'] as const;

let pool: Pool;
let app: INestApplication;
let token: string;
let settings: SettingsService;
let original: Map<string, string>;

async function set(key: (typeof KEYS)[number], value: string): Promise<void> {
  await pool.query(`UPDATE platform_settings SET value = $2 WHERE key = $1`, [key, value]);
  await settings.refresh();
}

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: DATABASE_URL, max: 6 });
  const mod = await Test.createTestingModule({
    imports: [
      AppModule.forRoot({ config: testApiConfig(DATABASE_URL as string), pool, clock: systemClock }),
    ],
  }).compile();
  app = mod.createNestApplication(new ExpressAdapter());
  await app.init();
  settings = app.get(SettingsService);

  const current = await pool.query<{ key: string; value: string }>(
    `SELECT key, value FROM platform_settings WHERE key = ANY($1::text[])`,
    [KEYS],
  );
  if (current.rows.length !== KEYS.length) throw new Error('093_feature_visibility.sql has not been applied');
  original = new Map(current.rows.map((r) => [r.key, r.value]));

  const identifier = `visibility-${randomUUID()}@example.ng`;
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
  await approveKyc(pool, userId);

  const login = await request(app.getHttpServer())
    .post('/v1/auth/login')
    .send({ identifier, password: PASSWORD, device: { fingerprint: `fp-${randomUUID()}`, platform: 'ios' } })
    .expect(200);
  token = login.body.access_token as string;
});

afterAll(async () => {
  for (const [key, value] of original ?? []) {
    await pool.query(`UPDATE platform_settings SET value = $2 WHERE key = $1`, [key, value]);
  }
  await app?.close();
  await pool?.end();
});

const auth = () => ({ Authorization: `Bearer ${token}` });
const CRYPTO = ['BTC', 'USDT', 'USDC'];

describe('GET /v1/services', () => {
  it('reports the three states, and keeps the booleans an installed app reads', async () => {
    await set('crypto_enabled', 'false');
    await set('crypto_when_off', 'hidden');
    const res = await request(app.getHttpServer()).get('/v1/services').set(auth()).expect(200);
    expect(res.body.states.crypto).toBe('hidden');
    expect(res.body.services.crypto).toBe(false);

    await set('crypto_when_off', 'coming_soon');
    const soon = await request(app.getHttpServer()).get('/v1/services').set(auth()).expect(200);
    expect(soon.body.states.crypto).toBe('coming_soon');

    await set('crypto_enabled', 'true');
    const on = await request(app.getHttpServer()).get('/v1/services').set(auth()).expect(200);
    expect(on.body.states.crypto).toBe('enabled');
    expect(on.body.services.crypto).toBe(true);
  });
});

describe('Coming soon is exactly what it was', () => {
  it('reads still answer and what moves money is refused as paused', async () => {
    await set('crypto_enabled', 'false');
    await set('crypto_when_off', 'coming_soon');
    await request(app.getHttpServer()).get('/v1/crypto/withdrawals').set(auth()).expect(200);
    const refused = await request(app.getHttpServer())
      .post('/v1/crypto/addresses')
      .set(auth())
      .send({ asset: 'USDT', network: 'tron' });
    expect(refused.status).toBe(503);
    expect(refused.body.error).toBe('crypto_disabled');
    await set('crypto_enabled', 'true');
  });
});

describe('Hidden removes crypto from every customer surface', () => {
  it('every crypto route answers as one that does not exist — reads included', async () => {
    await set('crypto_enabled', 'false');
    await set('crypto_when_off', 'hidden');
    for (const res of [
      await request(app.getHttpServer()).get('/v1/crypto/withdrawals').set(auth()),
      await request(app.getHttpServer()).get('/v1/crypto/withdrawals/quote?asset=USDT&network=tron&amount=10').set(auth()),
      await request(app.getHttpServer()).post('/v1/crypto/addresses').set(auth()).send({ asset: 'USDT', network: 'tron' }),
    ]) {
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('not_found');
    }
  });

  it('still asks who is calling first — no token is a 401, not a hint', async () => {
    const res = await request(app.getHttpServer()).get('/v1/crypto/withdrawals');
    expect(res.status).toBe(401);
  });

  it('takes its wallets off the list, out of history and out of Convert', async () => {
    await set('crypto_enabled', 'false');
    await set('crypto_when_off', 'hidden');
    await set('fx_enabled', 'true');

    const wallets = await request(app.getHttpServer()).get('/v1/wallets').set(auth()).expect(200);
    const codes = (wallets.body.balances ?? wallets.body).map((b: { currency: string }) => b.currency);
    for (const c of CRYPTO) expect(codes).not.toContain(c);

    const total = await request(app.getHttpServer()).get('/v1/wallets/total').set(auth()).expect(200);
    for (const c of CRYPTO) {
      expect(total.body.excluded).not.toContain(c);
      expect(total.body.included).not.toContain(c);
    }

    const history = await request(app.getHttpServer()).get('/v1/wallets/transactions?currency=USDT').set(auth());
    expect(history.status).toBe(404);

    const quote = await request(app.getHttpServer()).get('/v1/fx/quote?from=NGN&to=USDT&amount=1000.00').set(auth());
    expect(quote.status).toBe(404);
    expect(quote.body.error).toBe('not_found');
  });

  it('and enabling it again brings everything back without a release', async () => {
    await set('crypto_enabled', 'true');
    await request(app.getHttpServer()).get('/v1/crypto/withdrawals').set(auth()).expect(200);
    const wallets = await request(app.getHttpServer()).get('/v1/wallets').set(auth()).expect(200);
    const codes = (wallets.body.balances ?? wallets.body).map((b: { currency: string }) => b.currency);
    expect(codes).toContain('USDT');
  });
});
