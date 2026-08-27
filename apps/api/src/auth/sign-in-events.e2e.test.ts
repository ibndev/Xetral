import 'reflect-metadata';
import { createHash, randomUUID } from 'node:crypto';
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

/**
 * That every sign-in is recorded, including the ones that failed.
 *
 * The half worth an end-to-end suite is the FAILURES. `login()` throws on a
 * refusal and its transaction rolls back, so a failed attempt written on that
 * transaction is a failed attempt that is never written — and no unit test can
 * hold an opinion about that, because the rollback is the database's.
 */

const DATABASE_URL = process.env['DATABASE_URL'];
if (DATABASE_URL === undefined || DATABASE_URL === '') {
  throw new Error('this suite needs DATABASE_URL pointing at a migrated database');
}

const PASSWORD = 'a-long-enough-password';

let pool: Pool;
let app: INestApplication;

const hashOf = (identifier: string): string =>
  createHash('sha256').update(identifier.trim().toLowerCase(), 'utf8').digest('hex');

const device = () => ({
  fingerprint: `fingerprint-${randomUUID()}`,
  platform: 'android' as const,
  displayName: 'e2e handset',
});

async function seedUser(): Promise<{ identifier: string; userId: string }> {
  const identifier = `signin-${randomUUID()}@example.ng`;
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

interface EventRow {
  outcome: string;
  ip: string | null;
  country: string | null;
  platform: string | null;
  user_id: string | null;
}

const eventsFor = async (identifier: string): Promise<readonly EventRow[]> =>
  (
    await pool.query<EventRow>(
      `SELECT outcome, host(ip) AS ip, country, platform, user_id::text AS user_id
         FROM sign_in_events WHERE identifier_hash = $1 ORDER BY id`,
      [hashOf(identifier)],
    )
  ).rows;

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: DATABASE_URL, max: 5 });
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
  // Without this Express does not resolve `x-forwarded-for`, and every test
  // below would read the loopback address instead of the one it sent.
  app.getHttpAdapter().getInstance().set('trust proxy', 1);
  await app.init();
});

afterAll(async () => {
  await app?.close();
  await pool?.end();
});

describe('recording a sign-in', () => {
  it('records a success with where it came from', async () => {
    const { identifier, userId } = await seedUser();

    await request(app.getHttpServer())
      .post('/v1/auth/login')
      .set('x-forwarded-for', '102.89.40.7')
      .set('cf-ipcountry', 'ng')
      .send({ identifier, password: PASSWORD, device: device() })
      .expect(200);

    const events = await eventsFor(identifier);
    expect(events).toHaveLength(1);
    expect(events[0]?.outcome).toBe('succeeded');
    expect(events[0]?.ip).toBe('102.89.40.7');
    // Upper-cased on the way in: the header's case is the edge's business.
    expect(events[0]?.country).toBe('NG');
    expect(events[0]?.platform).toBe('android');
    expect(events[0]?.user_id).toBe(userId);
  });

  it('records a WRONG PASSWORD, which the login transaction rolled back', async () => {
    // The whole reason `recordFailure` uses a connection of its own. On the
    // login's transaction this row would be rolled back with the refusal, and
    // the credential-stuffing view would see a clean database during an attack.
    const { identifier, userId } = await seedUser();

    await request(app.getHttpServer())
      .post('/v1/auth/login')
      .set('x-forwarded-for', '198.51.100.22')
      .send({ identifier, password: 'not-the-password', device: device() })
      .expect(401);

    const events = await eventsFor(identifier);
    expect(events).toHaveLength(1);
    expect(events[0]?.outcome).toBe('bad_credentials');
    expect(events[0]?.ip).toBe('198.51.100.22');
    // The account is named even though the caller was told nothing about it.
    expect(events[0]?.user_id).toBe(userId);
  });

  it('records a guess at an account that does not exist, and names nobody', async () => {
    // Recorded because the guessing IS the signal, and separated from a wrong
    // password because "somebody is guessing passwords" and "somebody is
    // guessing which accounts exist" are different attacks. The endpoint
    // answering identically is what makes keeping the distinction here safe.
    const identifier = `ghost-${randomUUID()}@example.ng`;

    await request(app.getHttpServer())
      .post('/v1/auth/login')
      .set('x-forwarded-for', '198.51.100.23')
      .send({ identifier, password: PASSWORD, device: device() })
      .expect(401);

    const events = await eventsFor(identifier);
    expect(events).toHaveLength(1);
    expect(events[0]?.outcome).toBe('unknown_identifier');
    expect(events[0]?.user_id).toBeNull();
  });

  it('never stores the identifier itself', async () => {
    // A guess at an address that matched nothing is somebody else's email,
    // placed here by whoever guessed it.
    const identifier = `plain-${randomUUID()}@example.ng`;
    await request(app.getHttpServer())
      .post('/v1/auth/login')
      .send({ identifier, password: PASSWORD, device: device() })
      .expect(401);

    const found = await pool.query(
      `SELECT 1 FROM sign_in_events WHERE identifier_hash = $1`,
      [identifier],
    );
    expect(found.rowCount).toBe(0);
    expect(await eventsFor(identifier)).toHaveLength(1);
  });

  it('drops a country header that is not a country code', async () => {
    // The header means something only because the one route to this API is
    // through the edge. A request that came another way carries whatever its
    // sender typed, and it stops here rather than in the database.
    const { identifier } = await seedUser();

    await request(app.getHttpServer())
      .post('/v1/auth/login')
      .set('cf-ipcountry', 'Nigeria')
      .send({ identifier, password: PASSWORD, device: device() })
      .expect(200);

    expect((await eventsFor(identifier))[0]?.country).toBeNull();
  });
});

describe('alerting on a new country', () => {
  const queued = async (userId: string): Promise<readonly string[]> =>
    (
      await pool.query<{ kind: string }>(
        `SELECT kind::text AS kind FROM notification_outbox WHERE user_id = $1::bigint`,
        [userId],
      )
    ).rows.map((r) => r.kind);

  it('does not also alert when the DEVICE is new', async () => {
    // A takeover normally arrives on new hardware, which `new_device` already
    // covers. Sending both would mail the customer twice about one event and
    // teach them that our security alerts come in pairs.
    const { identifier, userId } = await seedUser();

    await request(app.getHttpServer())
      .post('/v1/auth/login')
      .set('cf-ipcountry', 'GB')
      .send({ identifier, password: PASSWORD, device: device() })
      .expect(200);

    const kinds = await queued(userId);
    expect(kinds).toContain('new_device');
    expect(kinds).not.toContain('new_location');
  });

  it('alerts on a KNOWN device in an unknown country', async () => {
    // The case `new_device` cannot see: a fingerprint we already trust,
    // presented from somewhere this account has never been.
    const { identifier, userId } = await seedUser();
    const handset = device();

    await request(app.getHttpServer())
      .post('/v1/auth/login')
      .set('cf-ipcountry', 'NG')
      .send({ identifier, password: PASSWORD, device: handset })
      .expect(200);

    expect(await queued(userId)).not.toContain('new_location');

    await request(app.getHttpServer())
      .post('/v1/auth/login')
      .set('cf-ipcountry', 'RU')
      .send({ identifier, password: PASSWORD, device: handset })
      .expect(200);

    expect(await queued(userId)).toContain('new_location');
  });

  it('says it once, not on every sign-in until the customer comes home', async () => {
    // Keyed on the country rather than on the moment, so somebody who has
    // genuinely moved is told about the move and not about each morning.
    const { identifier, userId } = await seedUser();
    const handset = device();

    for (const country of ['NG', 'GH', 'GH', 'GH']) {
      await request(app.getHttpServer())
        .post('/v1/auth/login')
        .set('cf-ipcountry', country)
        .send({ identifier, password: PASSWORD, device: handset })
        .expect(200);
    }

    const alerts = (await queued(userId)).filter((k) => k === 'new_location');
    expect(alerts).toHaveLength(1);
  });
});
