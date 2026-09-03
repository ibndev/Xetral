import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { ExpressAdapter } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import pg from 'pg';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../app.module.js';
import { systemClock } from '../tokens.js';
import { testApiConfig } from '../test-support/api-config.js';
import { enrolAndElevate } from '../test-support/staff-totp.js';
import { ProviderCredentialService } from './provider-credentials.service.js';

/**
 * That a provider key can be pasted, takes effect, and never comes back out.
 *
 * The assertion worth an end-to-end suite is the LAST one. Everything else is
 * checkable in a unit test; "no response body anywhere contains the key" is a
 * claim about the whole HTTP surface, and it is the claim this feature stands
 * or falls on.
 */

const DATABASE_URL = process.env['DATABASE_URL'];
if (DATABASE_URL === undefined || DATABASE_URL === '') {
  throw new Error('this suite needs DATABASE_URL pointing at a migrated database');
}

const PASSWORD = 'a-long-enough-password';
const PIN = '481902';

/**
 * Distinctive enough that a substring search over a response body means
 * something, and deliberately NOT shaped like any real provider's key.
 *
 * The first version here was `sk_live_...`, which GitHub's push protection
 * correctly refused as a Stripe key. It was fabricated — but a fixture that
 * looks like a live credential trains every scanner, and every reviewer, to
 * treat one more real leak as a false positive.
 */
const KEY = 'XETRAL-TEST-CREDENTIAL-NOT-A-REAL-KEY-8888';

let pool: Pool;
let app: INestApplication;
let credentials: ProviderCredentialService;

interface Operator {
  email: string;
  userId: string;
  uuid: string;
  token: string;
}

async function register(): Promise<Operator> {
  const email = `cred-${randomUUID()}@example.ng`;
  const res = await request(app.getHttpServer())
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

  const found = await pool.query<{ id: string; uuid: string }>(
    `SELECT id, uuid FROM users WHERE email = $1`,
    [email],
  );
  const row = found.rows[0];
  if (row === undefined) throw new Error('register did not create a user');

  await request(app.getHttpServer())
    .post('/v1/auth/pin')
    .set('Authorization', `Bearer ${res.body.access_token}`)
    .send({ pin: PIN })
    .expect(204);

  return { email, userId: row.id, uuid: row.uuid, token: res.body.access_token };
}

async function makeAdmin(): Promise<Operator> {
  const person = await register();
  await pool.query(
    `INSERT INTO staff_roles (user_id, role, granted_by) VALUES ($1, 'admin', $1)
     ON CONFLICT DO NOTHING`,
    [person.userId],
  );
  await enrolAndElevate(app, pool, person.token, person.userId);
  return person;
}

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: DATABASE_URL, max: 6 });
  const mod = await Test.createTestingModule({
    imports: [
      AppModule.forRoot({
        config: testApiConfig(DATABASE_URL as string, {
          // The environment holds one value; the database will hold another.
          // Which wins is the point of the test below.
          bitnobClientId: 'from-the-environment',
        }),
        pool,
        clock: systemClock,
      }),
    ],
  }).compile();
  app = mod.createNestApplication(new ExpressAdapter());
  await app.init();
  credentials = app.get(ProviderCredentialService);
});

afterAll(async () => {
  await app?.close();
  await pool?.end();
});

describe('pasting a provider key', () => {
  it('stores it sealed, and answers with a hint rather than the key', async () => {
    const operator = await makeAdmin();

    const res = await request(app.getHttpServer())
      .post('/v1/admin/credentials/bitnob/api_key')
      .set('Authorization', `Bearer ${operator.token}`)
      .send({ secret: KEY, transaction_pin: PIN })
      .expect(200);

    expect(res.body.is_set).toBe(true);
    expect(res.body.hint).toBe('8888');
    // The response to the request that CARRIED the key must not echo it.
    expect(JSON.stringify(res.body)).not.toContain(KEY);

    const stored = await pool.query<{ secret_sealed: string; hint: string }>(
      `SELECT secret_sealed, hint FROM provider_credentials
        WHERE provider = 'bitnob' AND name = 'api_key'`,
    );
    // Structural: the CHECK refuses a value with no key version, so a
    // plaintext key cannot reach the row even from psql.
    expect(stored.rows[0]?.secret_sealed).toMatch(/^v[0-9]+:/);
    expect(stored.rows[0]?.secret_sealed).not.toContain(KEY);
    expect(stored.rows[0]?.hint).toBe('8888');
  });

  it('is what the adapter then reads, over the environment', async () => {
    // The database is authoritative and the environment is the fallback — the
    // same order settings use, and the reason a key can be replaced during an
    // incident without a deploy.
    expect(await credentials.secretFor('bitnob', 'api_key', 'from-the-environment')).toBe(KEY);
    // And an unfilled slot still falls back, so an instance configured the old
    // way keeps working.
    expect(await credentials.secretFor('resend', 'api_key', 'env-resend-key')).toBe(
      'env-resend-key',
    );
  });

  it('never returns the key from ANY admin endpoint', async () => {
    // The claim the whole feature rests on. Checked across the surface rather
    // than on the one endpoint somebody remembered, because the failure this
    // guards against is a field added later to a different response.
    const operator = await makeAdmin();
    const paths = [
      '/v1/admin/credentials',
      '/v1/admin/credentials/bitnob/api_key/rotations',
      '/v1/admin/audit',
      '/v1/admin/settings',
    ];

    for (const path of paths) {
      const res = await request(app.getHttpServer())
        .get(path)
        .set('Authorization', `Bearer ${operator.token}`)
        .expect(200);
      expect(JSON.stringify(res.body)).not.toContain(KEY);
      // Not the ciphertext either. An operator with the keyring and a response
      // body would otherwise hold the key.
      expect(JSON.stringify(res.body)).not.toContain('secret_sealed');
    }
  });

  it('records the rotation with hints and no values', async () => {
    const operator = await makeAdmin();
    const replacement = 'XETRAL-TEST-CREDENTIAL-REPLACEMENT-2222';

    await request(app.getHttpServer())
      .post('/v1/admin/credentials/bitnob/api_key')
      .set('Authorization', `Bearer ${operator.token}`)
      .send({ secret: replacement, transaction_pin: PIN })
      .expect(200);

    const res = await request(app.getHttpServer())
      .get('/v1/admin/credentials/bitnob/api_key/rotations')
      .set('Authorization', `Bearer ${operator.token}`)
      .expect(200);

    const latest = res.body.rotations[0];
    expect(latest.new_hint).toBe('2222');
    expect(latest.old_hint).toBe('8888');
    expect(latest.changed_by).toBe(operator.email);
    expect(JSON.stringify(res.body)).not.toContain(replacement);

    // Replacing it takes effect at once rather than after the cache expires.
    // The reason to replace one of these is usually that it has leaked, and a
    // key that keeps working for a few more seconds is not revoked.
    expect(await credentials.secretFor('bitnob', 'api_key', 'from-the-environment')).toBe(
      replacement,
    );
  });

  it('refuses a slot this platform does not know about', async () => {
    // A credential nothing reads is one an operator believes is live.
    const operator = await makeAdmin();
    const res = await request(app.getHttpServer())
      .post('/v1/admin/credentials/paystack/api_key')
      .set('Authorization', `Bearer ${operator.token}`)
      .send({ secret: 'XETRAL-TEST-CREDENTIAL-WHATEVER', transaction_pin: PIN });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('credential_not_found');
  });

  it('offers the Dojah slots and marks them not yet connected', async () => {
    // Pasted now, in the right place, read by nothing. `in_use` is what stops
    // a filled box implying that identity verification is running.
    const operator = await makeAdmin();
    const res = await request(app.getHttpServer())
      .get('/v1/admin/credentials')
      .set('Authorization', `Bearer ${operator.token}`)
      .expect(200);

    const dojah = (res.body.credentials as { provider: string; in_use: boolean }[]).filter(
      (row) => row.provider === 'dojah',
    );
    expect(dojah.length).toBeGreaterThan(0);
    expect(dojah.every((row) => row.in_use === false)).toBe(true);
  });

  it('is refused to a signed-in customer who is not an admin', async () => {
    const customer = await register();
    const res = await request(app.getHttpServer())
      .get('/v1/admin/credentials')
      .set('Authorization', `Bearer ${customer.token}`);
    expect(res.status).toBe(403);
  });
});
