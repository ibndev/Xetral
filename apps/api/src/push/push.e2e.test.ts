import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { ExpressAdapter } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import pg from 'pg';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PushMessage, PushOutcome, PushPort } from '@xetral/providers';
import { AppModule } from '../app.module.js';
import { systemClock } from '../tokens.js';
import { testApiConfig } from '../test-support/api-config.js';
import { PushBroadcastService } from './push-broadcast.service.js';

/**
 * Announcements, over HTTP and against a real database.
 *
 * WHAT ONLY THIS CAN PROVE is the half no unit test reaches: that a broadcast
 * is a ROW an endpoint writes and a WORKER drains, that the audience the
 * worker actually sends to is gated on a live marketing grant, and that a
 * handset the push service calls gone is retired rather than retried for ever.
 */
const DATABASE_URL = process.env['DATABASE_URL'];
if (DATABASE_URL === undefined || DATABASE_URL === '') {
  throw new Error('this suite needs DATABASE_URL pointing at a migrated database');
}

const PASSWORD = 'a-long-enough-password';

/**
 * A push service that records what it was asked to send.
 *
 * It echoes an outcome per token in ORDER, which is the contract the real
 * adapter is held to — there is no token in an Expo ticket, so position is the
 * only thing that attributes a refusal to a handset.
 */
class FakePush implements PushPort {
  readonly provider = 'fake';
  readonly sent: { message: PushMessage; tokens: readonly string[] }[] = [];
  gone = new Set<string>();

  send(message: PushMessage, tokens: readonly string[]): Promise<readonly PushOutcome[]> {
    this.sent.push({ message, tokens });
    return Promise.resolve(
      tokens.map((token) =>
        this.gone.has(token)
          ? { token, accepted: false, deviceGone: true, reason: 'DeviceNotRegistered' }
          : { token, accepted: true, deviceGone: false },
      ),
    );
  }
}

let pool: Pool;
let app: INestApplication;
const push = new FakePush();

interface Person {
  token: string;
  uuid: string;
}

async function register(country = 'NG'): Promise<Person> {
  const email = `push-${randomUUID()}@example.ng`;
  const national = String(8000000000 + Math.floor(Math.random() * 999999999));
  const created = await request(app.getHttpServer())
    .post('/v1/auth/register')
    .send({
      email,
      password: PASSWORD,
      full_name: 'Push Person',
      country,
      phone: country === 'NG' ? national : undefined,
      device: { fingerprint: `fp-${randomUUID()}`, platform: 'android' },
    })
    .expect(201);

  const token = created.body.access_token as string;
  const row = await pool.query<{ uuid: string }>(`SELECT uuid FROM users WHERE email = $1`, [
    email,
  ]);
  return { token, uuid: row.rows[0]!.uuid };
}

/** Grants product-news consent directly, the way the settings screen does. */
async function optIn(uuid: string): Promise<void> {
  await pool.query(
    `INSERT INTO consent_records (user_id, kind, document_id, granted, source)
     SELECT u.id, 'marketing_email', d.id, TRUE, 'settings'
       FROM users u
       CROSS JOIN LATERAL (
         SELECT id FROM consent_documents
          WHERE kind = 'marketing_email' AND retired_at IS NULL LIMIT 1
       ) d
      WHERE u.uuid = $1`,
    [uuid],
  );
}

const handset = () => `ExponentPushToken[${randomUUID().replace(/-/g, '').slice(0, 22)}]`;

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: DATABASE_URL, max: 6 });
  const mod = await Test.createTestingModule({
    imports: [
      AppModule.forRoot({
        config: testApiConfig(DATABASE_URL as string),
        pool,
        clock: systemClock,
        pushPort: push,
      }),
    ],
  }).compile();
  app = mod.createNestApplication(new ExpressAdapter());
  await app.init();
});

afterAll(async () => {
  await app?.close();
  await pool?.end();
});

describe('a customer registering a handset', () => {
  it('records it, with no PIN anywhere', async () => {
    const person = await register();
    const token = handset();

    // No PIN has been set on this account at all. A push token is an ADDRESS
    // and not a credential, so demanding the factor that authorises spending
    // would mean a customer without a PIN could never be told anything.
    await request(app.getHttpServer())
      .post('/v1/push/devices')
      .set('Authorization', `Bearer ${person.token}`)
      .send({ token, platform: 'android' })
      .expect(204);

    const row = await pool.query(`SELECT 1 FROM push_devices WHERE token = $1`, [token]);
    expect(row.rowCount).toBe(1);
  });

  it('REASSIGNS a shared handset rather than duplicating it', async () => {
    const first = await register();
    const second = await register();
    const token = handset();

    for (const person of [first, second]) {
      await request(app.getHttpServer())
        .post('/v1/push/devices')
        .set('Authorization', `Bearer ${person.token}`)
        .send({ token, platform: 'android' })
        .expect(204);
    }

    // Leaving it pointed at the first account would send one person's
    // notifications to another person's lock screen.
    const rows = await pool.query<{ uuid: string }>(
      `SELECT u.uuid FROM push_devices d JOIN users u ON u.id = d.user_id WHERE d.token = $1`,
      [token],
    );
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0]!.uuid).toBe(second.uuid);
  });

  it('refuses a token that is not an Expo push token', async () => {
    const person = await register();
    await request(app.getHttpServer())
      .post('/v1/push/devices')
      .set('Authorization', `Bearer ${person.token}`)
      .send({ token: 'not-a-token', platform: 'android' })
      .expect(400);
  });

  it('answers 204 when revoking a handset it does not hold', async () => {
    const person = await register();
    // A sign-out must never fail because the handset was already retired, and
    // an endpoint answering differently for "not yours" and "not here" would
    // say which tokens exist.
    await request(app.getHttpServer())
      .post('/v1/push/devices/revoke')
      .set('Authorization', `Bearer ${person.token}`)
      .send({ token: handset() })
      .expect(204);
  });

  it('cannot revoke somebody else’s handset by naming it', async () => {
    const mine = await register();
    const theirs = await register();
    const token = handset();

    await request(app.getHttpServer())
      .post('/v1/push/devices')
      .set('Authorization', `Bearer ${theirs.token}`)
      .send({ token, platform: 'ios' })
      .expect(204);

    await request(app.getHttpServer())
      .post('/v1/push/devices/revoke')
      .set('Authorization', `Bearer ${mine.token}`)
      .send({ token })
      .expect(204);

    const row = await pool.query<{ revoked_at: Date | null }>(
      `SELECT revoked_at FROM push_devices WHERE token = $1`,
      [token],
    );
    expect(row.rows[0]!.revoked_at).toBeNull();
  });
});

describe('the worker that drains a queued broadcast', () => {
  it('SENDS ONLY TO CUSTOMERS WHO OPTED IN, and counts the rest', async () => {
    const optedIn = await register();
    const quiet = await register();
    await optIn(optedIn.uuid);

    const reachable = handset();
    const unreachable = handset();
    for (const [person, token] of [
      [optedIn, reachable],
      [quiet, unreachable],
    ] as const) {
      await request(app.getHttpServer())
        .post('/v1/push/devices')
        .set('Authorization', `Bearer ${person.token}`)
        .send({ token, platform: 'android' })
        .expect(204);
    }

    const staff = await register();
    const queued = await pool.query<{ uuid: string }>(
      `INSERT INTO push_broadcasts (title, body, created_by)
       SELECT 'Scheduled maintenance', 'Back within the hour.', id FROM users WHERE uuid = $1
       RETURNING uuid`,
      [staff.uuid],
    );

    push.sent.length = 0;
    await app.get(PushBroadcastService).run();

    const tokens = push.sent.flatMap((call) => call.tokens);
    expect(tokens).toContain(reachable);
    // A consent nothing reads is a checkbox — the lesson Tier 1 records about
    // `crypto_enabled`, and 033's argument for gating the outbox by trigger.
    expect(tokens).not.toContain(unreachable);

    const row = await pool.query<{
      sent_at: Date | null;
      accepted: number;
      without_consent: number;
    }>(`SELECT sent_at, accepted, without_consent FROM push_broadcasts WHERE uuid = $1`, [
      queued.rows[0]!.uuid,
    ]);
    expect(row.rows[0]!.sent_at).not.toBeNull();
    expect(Number(row.rows[0]!.accepted)).toBeGreaterThanOrEqual(1);
    // Reported rather than hidden: an operator seeing fewer handsets than
    // expected must be able to learn the difference is consent.
    expect(Number(row.rows[0]!.without_consent)).toBeGreaterThanOrEqual(1);
  });

  it('RETIRES A HANDSET THE SERVICE SAYS IS GONE', async () => {
    const person = await register();
    await optIn(person.uuid);
    const token = handset();
    await request(app.getHttpServer())
      .post('/v1/push/devices')
      .set('Authorization', `Bearer ${person.token}`)
      .send({ token, platform: 'ios' })
      .expect(204);

    push.gone.add(token);
    const staff = await register();
    await pool.query(
      `INSERT INTO push_broadcasts (title, body, created_by)
       SELECT 'A new corridor', 'You can now send money to Kenya.', id
         FROM users WHERE uuid = $1`,
      [staff.uuid],
    );

    await app.get(PushBroadcastService).run();

    // Kept, it is a permanent error on every future broadcast, and a report
    // that always says "n failed" is a report nobody reads.
    const row = await pool.query<{ revoked_at: Date | null }>(
      `SELECT revoked_at FROM push_devices WHERE token = $1`,
      [token],
    );
    expect(row.rows[0]!.revoked_at).not.toBeNull();
    push.gone.delete(token);
  });

  it('does not send the same broadcast twice', async () => {
    const staff = await register();
    const queued = await pool.query<{ uuid: string }>(
      `INSERT INTO push_broadcasts (title, body, created_by)
       SELECT 'Rates updated', 'Our naira to cedi rate has improved.', id
         FROM users WHERE uuid = $1
       RETURNING uuid`,
      [staff.uuid],
    );

    await app.get(PushBroadcastService).run();
    push.sent.length = 0;
    // A second pass must find nothing. `sent_at IS NULL` is the whole state
    // machine, and 065's trigger refuses a second write on top of it.
    await app.get(PushBroadcastService).run();

    expect(push.sent).toHaveLength(0);
    const row = await pool.query<{ sent_at: Date | null }>(
      `SELECT sent_at FROM push_broadcasts WHERE uuid = $1`,
      [queued.rows[0]!.uuid],
    );
    expect(row.rows[0]!.sent_at).not.toBeNull();
  });
});
