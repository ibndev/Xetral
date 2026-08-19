import 'reflect-metadata';
import { randomBytes, randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { ExpressAdapter } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import pg from 'pg';
import type { Pool } from 'pg';
import { hashPassword } from '@xetral/identity';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../app.module.js';
import type { ApiConfig } from '../config.js';
import { systemClock } from '../tokens.js';

/**
 * The auth flows against a real PostgreSQL, because the invariants that matter
 * most here live in the database. Reuse detection in particular is a property
 * of `rotate_refresh_token`, and a suite that mocked the database would be
 * asserting that the mock behaves the way the author believed the function does.
 *
 * Requires DATABASE_URL and a database with 001_ledger.sql and 002_identity.sql
 * applied. Fails loudly if it is missing rather than skipping — see
 * vitest.e2e.config.ts.
 */

const DATABASE_URL = process.env['DATABASE_URL'];
if (DATABASE_URL === undefined || DATABASE_URL === '') {
  throw new Error(
    'the e2e suite needs DATABASE_URL pointing at a database with the migrations applied',
  );
}

const PASSWORD = 'a-long-enough-password';
const key = { version: 'v1', secret: randomBytes(32) };

function makeConfig(overrides: Partial<ApiConfig> = {}): ApiConfig {
  return {
    databaseUrl: DATABASE_URL as string,
    accessTokenKeyring: { current: key, accepted: [key] },
    accessTokenTtlSeconds: 900,
    refreshTokenTtlSeconds: 2_592_000,
    loginRateLimit: {
      // Deliberately high by default so the flow tests are not throttled by
      // each other. The rate-limit test builds its own app with real limits.
      perIdentifier: { max: 1000, windowSeconds: 900 },
      perIp: { max: 1000, windowSeconds: 900 },
    },
    trustProxyHops: 0,
    ...overrides,
  };
}

let pool: Pool;
let app: INestApplication;

async function createApp(config: ApiConfig): Promise<INestApplication> {
  const mod = await Test.createTestingModule({
    imports: [AppModule.forRoot({ config, pool, clock: systemClock })],
  }).compile();
  const created = mod.createNestApplication(new ExpressAdapter());
  await created.init();
  return created;
}

/** A fresh user per call, so a rerun against the same database cannot collide
 *  with the rows a previous run left behind. */
async function seedUser(): Promise<{ identifier: string; userId: string }> {
  const identifier = `e2e-${randomUUID()}@example.ng`;
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
  return { identifier, userId };
}

const device = (name = 'e2e handset') => ({
  fingerprint: `fingerprint-${randomUUID()}`,
  platform: 'ios' as const,
  displayName: name,
});

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: DATABASE_URL, max: 5 });
  app = await createApp(makeConfig());
});

afterAll(async () => {
  await app?.close();
  await pool?.end();
});

describe('login', () => {
  it('issues a usable token pair', async () => {
    const { identifier } = await seedUser();

    const res = await request(app.getHttpServer())
      .post('/v1/auth/login')
      .send({ identifier, password: PASSWORD, device: device() })
      .expect(200);

    expect(res.body.token_type).toBe('Bearer');
    expect(res.body.expires_in).toBe(900);
    expect(typeof res.body.access_token).toBe('string');
    expect(typeof res.body.refresh_token).toBe('string');

    const session = await request(app.getHttpServer())
      .get('/v1/auth/session')
      .set('Authorization', `Bearer ${res.body.access_token}`)
      .expect(200);
    expect(session.body.session_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('stores only the hash of the refresh token', async () => {
    // The raw token must not be findable anywhere in the table. A database
    // dump has to be useless as a set of credentials.
    const { identifier } = await seedUser();
    const res = await request(app.getHttpServer())
      .post('/v1/auth/login')
      .send({ identifier, password: PASSWORD, device: device() })
      .expect(200);

    const found = await pool.query(`SELECT 1 FROM refresh_tokens WHERE token_hash = $1`, [
      res.body.refresh_token,
    ]);
    expect(found.rowCount).toBe(0);
  });

  it('answers a wrong password and an unknown account identically', async () => {
    // Any difference here — status, body, or wording — turns the endpoint into
    // a way to find out which of our customers exist.
    const { identifier } = await seedUser();

    const wrongPassword = await request(app.getHttpServer())
      .post('/v1/auth/login')
      .send({ identifier, password: 'not-the-right-password', device: device() });

    const unknownUser = await request(app.getHttpServer())
      .post('/v1/auth/login')
      .send({
        identifier: `absent-${randomUUID()}@example.ng`,
        password: PASSWORD,
        device: device(),
      });

    expect(wrongPassword.status).toBe(401);
    expect(unknownUser.status).toBe(401);
    expect(wrongPassword.body).toEqual(unknownUser.body);
    expect(wrongPassword.body.error).toBe('invalid_credentials');
  });

  it('refuses a revoked device even with the right password', async () => {
    // Revoking a device is the "this phone was stolen" action. Letting a
    // correct password quietly re-activate it would undo a revocation somebody
    // performed deliberately.
    const { identifier } = await seedUser();
    const d = device();

    await request(app.getHttpServer())
      .post('/v1/auth/login')
      .send({ identifier, password: PASSWORD, device: d })
      .expect(200);

    await pool.query(
      `UPDATE devices SET status = 'revoked'
        WHERE fingerprint_hash = encode(sha256($1::bytea), 'hex')`,
      [d.fingerprint],
    );

    const res = await request(app.getHttpServer())
      .post('/v1/auth/login')
      .send({ identifier, password: PASSWORD, device: d });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('invalid_credentials');
  });

  it('rejects a malformed body without reaching the database', async () => {
    const res = await request(app.getHttpServer())
      .post('/v1/auth/login')
      .send({ identifier: 'a', password: '' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_request');
  });
});

describe('refresh rotation', () => {
  it('rotates, and the presented token stops working', async () => {
    const { identifier } = await seedUser();
    const login = await request(app.getHttpServer())
      .post('/v1/auth/login')
      .send({ identifier, password: PASSWORD, device: device() })
      .expect(200);

    const rotated = await request(app.getHttpServer())
      .post('/v1/auth/refresh')
      .send({ refresh_token: login.body.refresh_token })
      .expect(200);

    expect(rotated.body.refresh_token).not.toBe(login.body.refresh_token);

    // The new one works.
    await request(app.getHttpServer())
      .get('/v1/auth/session')
      .set('Authorization', `Bearer ${rotated.body.access_token}`)
      .expect(200);
  });

  it('detects reuse and kills the whole family', async () => {
    // The invariant this phase exists for. Generation 1 is live and unused;
    // replaying generation 0 must kill it too, because generation 1 is exactly
    // what a thief would be holding if they rotated first.
    const { identifier } = await seedUser();
    const login = await request(app.getHttpServer())
      .post('/v1/auth/login')
      .send({ identifier, password: PASSWORD, device: device() })
      .expect(200);

    const rotated = await request(app.getHttpServer())
      .post('/v1/auth/refresh')
      .send({ refresh_token: login.body.refresh_token })
      .expect(200);

    const replay = await request(app.getHttpServer())
      .post('/v1/auth/refresh')
      .send({ refresh_token: login.body.refresh_token });
    expect(replay.status).toBe(401);
    expect(replay.body.error).toBe('invalid_grant');

    // The live sibling is dead as well.
    const sibling = await request(app.getHttpServer())
      .post('/v1/auth/refresh')
      .send({ refresh_token: rotated.body.refresh_token });
    expect(sibling.status).toBe(401);

    const incident = await pool.query(
      `SELECT revoked_reason FROM auth_sessions
        WHERE user_id = (SELECT id FROM users WHERE email = $1)`,
      [identifier],
    );
    expect(incident.rows[0]?.revoked_reason).toBe('token_reuse');
  });

  it('answers an unknown token the same way as a reused one', async () => {
    const res = await request(app.getHttpServer())
      .post('/v1/auth/refresh')
      .send({ refresh_token: randomBytes(32).toString('base64url') });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('invalid_grant');
  });
});

describe('logout', () => {
  it('revokes the session so the refresh token is dead', async () => {
    const { identifier } = await seedUser();
    const login = await request(app.getHttpServer())
      .post('/v1/auth/login')
      .send({ identifier, password: PASSWORD, device: device() })
      .expect(200);

    await request(app.getHttpServer())
      .post('/v1/auth/logout')
      .set('Authorization', `Bearer ${login.body.access_token}`)
      .expect(204);

    const refreshed = await request(app.getHttpServer())
      .post('/v1/auth/refresh')
      .send({ refresh_token: login.body.refresh_token });
    expect(refreshed.status).toBe(401);
  });

  it('leaves the already-issued access token working until it expires', async () => {
    // Documented and deliberate: a signed access token cannot be revoked
    // mid-life. This test exists so that the day it stops being true, somebody
    // notices it was a decision rather than an accident.
    const { identifier } = await seedUser();
    const login = await request(app.getHttpServer())
      .post('/v1/auth/login')
      .send({ identifier, password: PASSWORD, device: device() })
      .expect(200);

    await request(app.getHttpServer())
      .post('/v1/auth/logout')
      .set('Authorization', `Bearer ${login.body.access_token}`)
      .expect(204);

    await request(app.getHttpServer())
      .get('/v1/auth/session')
      .set('Authorization', `Bearer ${login.body.access_token}`)
      .expect(200);
  });
});

describe('login rate limiting', () => {
  it('blocks an identifier after the configured number of attempts', async () => {
    const limited = await createApp(
      makeConfig({
        loginRateLimit: {
          perIdentifier: { max: 3, windowSeconds: 900 },
          perIp: { max: 1000, windowSeconds: 900 },
        },
      }),
    );

    try {
      const { identifier } = await seedUser();
      const attempt = () =>
        request(limited.getHttpServer())
          .post('/v1/auth/login')
          .send({ identifier, password: 'wrong-password-here', device: device() });

      for (let i = 0; i < 3; i++) expect((await attempt()).status).toBe(401);

      const blocked = await attempt();
      expect(blocked.status).toBe(429);
      expect(blocked.body.error).toBe('too_many_attempts');
      expect(blocked.body.retry_after_seconds).toBeGreaterThan(0);

      // A correct password does not get past the limit either -- otherwise the
      // limit only slows down attackers who guess wrong.
      const correct = await request(limited.getHttpServer())
        .post('/v1/auth/login')
        .send({ identifier, password: PASSWORD, device: device() });
      expect(correct.status).toBe(429);
    } finally {
      await limited.close();
    }
  });

  it('does not let one account lock out another', async () => {
    const limited = await createApp(
      makeConfig({
        loginRateLimit: {
          perIdentifier: { max: 2, windowSeconds: 900 },
          perIp: { max: 1000, windowSeconds: 900 },
        },
      }),
    );

    try {
      const victim = await seedUser();
      const bystander = await seedUser();

      for (let i = 0; i < 3; i++) {
        await request(limited.getHttpServer())
          .post('/v1/auth/login')
          .send({ identifier: victim.identifier, password: 'wrong', device: device() });
      }

      const other = await request(limited.getHttpServer())
        .post('/v1/auth/login')
        .send({ identifier: bystander.identifier, password: PASSWORD, device: device() });
      expect(other.status).toBe(200);
    } finally {
      await limited.close();
    }
  });
});
