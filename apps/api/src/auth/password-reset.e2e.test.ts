import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { ExpressAdapter } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import pg from 'pg';
import type { Pool } from 'pg';
import { hashPassword, open } from '@xetral/identity';
import type { NotificationMessage, NotificationPort, NotificationReceipt } from '@xetral/providers';
import { ProviderRejectedError, ProviderUnavailableError } from '@xetral/providers';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from '../app.module.js';
import { systemClock } from '../tokens.js';
import { testApiConfig } from '../test-support/api-config.js';
import { NotificationWorker } from '../notifications/notification.worker.js';

/**
 * Password reset, over HTTP, against a real database.
 *
 * The parts worth proving here are the ones no unit test can reach: that a
 * request for an unknown address is INDISTINGUISHABLE from one for a real
 * customer, that the token in the email actually works exactly once, and that
 * using it ends every session that was open on the account.
 *
 * The email provider is a stand-in — this suite is about Xetral, not about
 * Resend — but the OUTBOX is real, and the worker that drains it is the real
 * one. What the customer receives is asserted by opening the sealed row.
 */
const DATABASE_URL = process.env['DATABASE_URL'];
if (DATABASE_URL === undefined || DATABASE_URL === '') {
  throw new Error('the password reset e2e suite needs DATABASE_URL with the migrations applied');
}

const PASSWORD = 'a-long-enough-password';
const NEW_PASSWORD = 'an-even-longer-password';

/** Records what it was asked to send, and can be told to fail. */
class StubMailer implements NotificationPort {
  readonly provider = 'stub';
  readonly sent: NotificationMessage[] = [];
  failWith: Error | undefined;

  async send(message: NotificationMessage): Promise<NotificationReceipt> {
    if (this.failWith !== undefined) throw this.failWith;
    this.sent.push(message);
    return { providerMessageId: `stub_${this.sent.length}` };
  }
}

let pool: Pool;
let app: INestApplication;
let mailer: StubMailer;
let worker: NotificationWorker;
let config: ReturnType<typeof testApiConfig>;

interface Seeded {
  userId: string;
  email: string;
}

async function seedCustomer(): Promise<Seeded> {
  const email = `reset-${randomUUID()}@example.ng`;
  const inserted = await pool.query<{ id: string }>(
    `INSERT INTO users (email, status) VALUES ($1, 'active') RETURNING id`,
    [email],
  );
  const userId = inserted.rows[0]?.id as string;
  await pool.query(`INSERT INTO user_credentials (user_id, password_hash) VALUES ($1, $2)`, [
    userId,
    await hashPassword(PASSWORD),
  ]);
  return { userId, email };
}

const login = async (identifier: string, password: string) =>
  await request(app.getHttpServer())
    .post('/v1/auth/login')
    .send({
      identifier,
      password,
      device: { fingerprint: `fp-${randomUUID()}`, platform: 'ios' },
    });

/** The reset link as the customer would receive it, read out of the outbox. */
async function linkFor(userId: string): Promise<string> {
  const row = await pool.query<{ payload_sealed: string }>(
    `SELECT payload_sealed FROM notification_outbox
      WHERE user_id = $1::bigint AND kind = 'password_reset' AND status = 'pending'
      ORDER BY id DESC LIMIT 1`,
    [userId],
  );
  const sealed = row.rows[0]?.payload_sealed;
  if (sealed === undefined) throw new Error('no reset email was queued');

  const keyring = config.encryptionKeyring;
  if (keyring === undefined) throw new Error('the fixture has no keyring');
  const rendered = JSON.parse(open(sealed, keyring)) as { text: string };

  const match = /https:\/\/\S+/.exec(rendered.text);
  if (match === null) throw new Error(`no link in the email body: ${rendered.text}`);
  return match[0];
}

const tokenFrom = (link: string): string =>
  new URL(link).searchParams.get('token') ?? '';

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: DATABASE_URL, max: 6 });
  mailer = new StubMailer();
  config = testApiConfig(DATABASE_URL as string);

  const mod = await Test.createTestingModule({
    imports: [
      AppModule.forRoot({ config, pool, clock: systemClock, notificationPort: mailer }),
    ],
  }).compile();
  app = mod.createNestApplication(new ExpressAdapter());
  await app.init();
  worker = app.get(NotificationWorker);
});

beforeEach(() => {
  mailer.failWith = undefined;
});

afterAll(async () => {
  await app?.close();
  await pool?.end();
});

describe('asking for a reset', () => {
  it('answers 204 and queues a link for a real customer', async () => {
    const { userId, email } = await seedCustomer();

    await request(app.getHttpServer())
      .post('/v1/auth/password/forgot')
      .send({ identifier: email })
      .expect(204);

    const link = await linkFor(userId);
    expect(link).toContain('/reset-password?token=');
  });

  it('answers 204 for an address with NO account', async () => {
    // The property the whole endpoint is shaped around. A different status,
    // a different body or a different error for an unknown address turns any
    // address list into a customer list — and a customer list for a Nigerian
    // fintech is worth money to the people who send phishing SMS.
    const known = await seedCustomer();

    const real = await request(app.getHttpServer())
      .post('/v1/auth/password/forgot')
      .send({ identifier: known.email });
    const fake = await request(app.getHttpServer())
      .post('/v1/auth/password/forgot')
      .send({ identifier: `nobody-${randomUUID()}@example.ng` });

    expect(fake.status).toBe(real.status);
    expect(fake.status).toBe(204);
    expect(fake.body).toEqual(real.body);
    expect(fake.text).toBe(real.text);
  });

  it('queues nothing for an address with no account', async () => {
    // The other half: identical on the wire, and no message owed.
    const before = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM notification_outbox WHERE kind = 'password_reset'`,
    );
    await request(app.getHttpServer())
      .post('/v1/auth/password/forgot')
      .send({ identifier: `nobody-${randomUUID()}@example.ng` })
      .expect(204);

    const after = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM notification_outbox WHERE kind = 'password_reset'`,
    );
    expect(after.rows[0]?.n).toBe(before.rows[0]?.n);
  });

  it('stores only a hash, never the token that was mailed', async () => {
    const { userId } = await seedCustomer();
    const seeded = await pool.query<{ email: string }>(
      `SELECT email FROM users WHERE id = $1::bigint`,
      [userId],
    );
    await request(app.getHttpServer())
      .post('/v1/auth/password/forgot')
      .send({ identifier: seeded.rows[0]?.email })
      .expect(204);

    const token = tokenFrom(await linkFor(userId));
    const stored = await pool.query<{ token_hash: string }>(
      `SELECT token_hash FROM password_reset_tokens WHERE user_id = $1::bigint`,
      [userId],
    );

    expect(stored.rows).toHaveLength(1);
    expect(stored.rows[0]?.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored.rows[0]?.token_hash).not.toBe(token);
  });

  it('two requests produce two usable links, not one', async () => {
    // Keyed on the token hash rather than on the customer. Keying on the user
    // would make the second request a replay and silently drop it — and the
    // customer may only ever see one of the two emails.
    const { userId, email } = await seedCustomer();

    await request(app.getHttpServer())
      .post('/v1/auth/password/forgot')
      .send({ identifier: email })
      .expect(204);
    await request(app.getHttpServer())
      .post('/v1/auth/password/forgot')
      .send({ identifier: email })
      .expect(204);

    const queued = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM notification_outbox
        WHERE user_id = $1::bigint AND kind = 'password_reset'`,
      [userId],
    );
    expect(queued.rows[0]?.n).toBe('2');
  });
});

describe('using the link', () => {
  it('sets the new password, and the old one stops working', async () => {
    const { userId, email } = await seedCustomer();
    await request(app.getHttpServer())
      .post('/v1/auth/password/forgot')
      .send({ identifier: email })
      .expect(204);

    const token = tokenFrom(await linkFor(userId));

    await request(app.getHttpServer())
      .post('/v1/auth/password/reset')
      .send({ token, new_password: NEW_PASSWORD })
      .expect(204);

    await login(email, NEW_PASSWORD).then((r) => expect(r.status).toBe(200));
    await login(email, PASSWORD).then((r) => expect(r.status).toBe(401));
  });

  it('issues NO tokens', async () => {
    // A leaked reset link must grant a password that can be used, not an
    // immediate live session. Returning a token pair here would undo the
    // session revocation two tests below in the same breath.
    const { userId, email } = await seedCustomer();
    await request(app.getHttpServer())
      .post('/v1/auth/password/forgot')
      .send({ identifier: email })
      .expect(204);

    const res = await request(app.getHttpServer())
      .post('/v1/auth/password/reset')
      .send({ token: tokenFrom(await linkFor(userId)), new_password: NEW_PASSWORD });

    expect(res.status).toBe(204);
    expect(res.text).toBe('');
    expect(res.body).toEqual({});
  });

  it('ends every session that was open on the account', async () => {
    // A reset is the recovery action for an account somebody else may be
    // sitting in. Finishing one while the intruder's session keeps working
    // would make the whole flow theatre.
    const { userId, email } = await seedCustomer();

    const first = await login(email, PASSWORD);
    expect(first.status).toBe(200);
    const stolen = first.body.access_token as string;

    // The stolen session works right now.
    await request(app.getHttpServer())
      .get('/v1/wallets')
      .set('Authorization', `Bearer ${stolen}`)
      .expect(200);

    await request(app.getHttpServer())
      .post('/v1/auth/password/forgot')
      .send({ identifier: email })
      .expect(204);
    await request(app.getHttpServer())
      .post('/v1/auth/password/reset')
      .send({ token: tokenFrom(await linkFor(userId)), new_password: NEW_PASSWORD })
      .expect(204);

    const live = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM auth_sessions
        WHERE user_id = $1::bigint AND revoked_at IS NULL`,
      [userId],
    );
    expect(live.rows[0]?.n).toBe('0');

    // The refresh token is dead, which is what actually stops the intruder:
    // the access token itself cannot be revoked mid-life, which is why it is
    // only 15 minutes long.
    const refreshed = await request(app.getHttpServer())
      .post('/v1/auth/refresh')
      .send({ refresh_token: first.body.refresh_token as string });
    expect(refreshed.status).toBe(401);
  });

  it('refuses the same token a second time', async () => {
    const { userId, email } = await seedCustomer();
    await request(app.getHttpServer())
      .post('/v1/auth/password/forgot')
      .send({ identifier: email })
      .expect(204);

    const token = tokenFrom(await linkFor(userId));
    await request(app.getHttpServer())
      .post('/v1/auth/password/reset')
      .send({ token, new_password: NEW_PASSWORD })
      .expect(204);

    const replay = await request(app.getHttpServer())
      .post('/v1/auth/password/reset')
      .send({ token, new_password: 'a-third-password-entirely' });

    expect(replay.status).toBe(401);
    expect(replay.body.error).toBe('invalid_grant');
    // And the replay changed nothing: the password set by the FIRST use still
    // works. A second use that succeeded would lock the customer out of the
    // account they had just recovered.
    await login(email, NEW_PASSWORD).then((r) => expect(r.status).toBe(200));
  });

  it('answers the same way for an unknown token as for a used one', async () => {
    const { userId, email } = await seedCustomer();
    await request(app.getHttpServer())
      .post('/v1/auth/password/forgot')
      .send({ identifier: email })
      .expect(204);
    const token = tokenFrom(await linkFor(userId));
    await request(app.getHttpServer())
      .post('/v1/auth/password/reset')
      .send({ token, new_password: NEW_PASSWORD })
      .expect(204);

    const used = await request(app.getHttpServer())
      .post('/v1/auth/password/reset')
      .send({ token, new_password: NEW_PASSWORD });
    const invented = await request(app.getHttpServer())
      .post('/v1/auth/password/reset')
      .send({ token: 'not-a-real-token-at-all', new_password: NEW_PASSWORD });

    // Distinguishing them would tell a prober which of their guesses was a
    // real token, which is the only thing they were missing.
    expect(invented.status).toBe(used.status);
    expect(invented.body).toEqual(used.body);
  });

  it('does not spend the token on a password the policy refuses', async () => {
    // Checked before the token is consumed, so a customer who picks something
    // too short gets another go with the link they are holding.
    const { userId, email } = await seedCustomer();
    await request(app.getHttpServer())
      .post('/v1/auth/password/forgot')
      .send({ identifier: email })
      .expect(204);

    const token = tokenFrom(await linkFor(userId));
    const weak = await request(app.getHttpServer())
      .post('/v1/auth/password/reset')
      .send({ token, new_password: 'short' });
    expect(weak.status).toBe(401);
    expect(weak.body.error).toBe('weak_password');

    await request(app.getHttpServer())
      .post('/v1/auth/password/reset')
      .send({ token, new_password: NEW_PASSWORD })
      .expect(204);

    const consumed = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM password_reset_tokens
        WHERE user_id = $1::bigint AND consumed_at IS NOT NULL`,
      [userId],
    );
    expect(consumed.rows[0]?.n).toBe('1');
  });
});

describe('the outbox worker', () => {
  it('sends a queued message and forgets its body', async () => {
    const { userId, email } = await seedCustomer();
    await request(app.getHttpServer())
      .post('/v1/auth/password/forgot')
      .send({ identifier: email })
      .expect(204);

    const before = mailer.sent.length;
    await worker.sweep();
    expect(mailer.sent.length).toBeGreaterThan(before);

    const row = await pool.query<{
      status: string;
      payload_sealed: string | null;
      provider_message_id: string | null;
    }>(
      `SELECT status::text AS status, payload_sealed, provider_message_id
         FROM notification_outbox
        WHERE user_id = $1::bigint AND kind = 'password_reset'
        ORDER BY id DESC LIMIT 1`,
      [userId],
    );

    expect(row.rows[0]?.status).toBe('sent');
    expect(row.rows[0]?.provider_message_id).not.toBeNull();
    // The delivered reset link is GONE from the database. It has no reason to
    // stay, and the safest place for a live bearer token is nowhere.
    expect(row.rows[0]?.payload_sealed).toBeNull();
  });

  it('does not send the same message twice', async () => {
    const { email } = await seedCustomer();
    await request(app.getHttpServer())
      .post('/v1/auth/password/forgot')
      .send({ identifier: email })
      .expect(204);

    await worker.sweep();
    const afterFirst = mailer.sent.length;
    await worker.sweep();
    expect(mailer.sent.length).toBe(afterFirst);
  });

  it('keeps a message for another attempt when the provider is down', async () => {
    const { userId, email } = await seedCustomer();
    await request(app.getHttpServer())
      .post('/v1/auth/password/forgot')
      .send({ identifier: email })
      .expect(204);

    mailer.failWith = new ProviderUnavailableError('stub', 'upstream down');
    await worker.sweep();

    const row = await pool.query<{ status: string; attempts: number }>(
      `SELECT status::text AS status, attempts FROM notification_outbox
        WHERE user_id = $1::bigint ORDER BY id DESC LIMIT 1`,
      [userId],
    );
    expect(row.rows[0]?.status).toBe('pending');
    expect(row.rows[0]?.attempts).toBe(1);
  });

  it('abandons a message the provider will never accept', async () => {
    // A refusal a retry cannot clear — an unverified sending domain, a
    // malformed address. Five more identical rejections over six hours would
    // tell nobody anything the first one did not.
    const { userId, email } = await seedCustomer();
    await request(app.getHttpServer())
      .post('/v1/auth/password/forgot')
      .send({ identifier: email })
      .expect(204);

    mailer.failWith = new ProviderRejectedError('stub', 'domain not verified', 'invalid_from_address');
    await worker.sweep();

    const row = await pool.query<{ status: string; payload_sealed: string | null }>(
      `SELECT status::text AS status, payload_sealed FROM notification_outbox
        WHERE user_id = $1::bigint ORDER BY id DESC LIMIT 1`,
      [userId],
    );
    expect(row.rows[0]?.status).toBe('abandoned');
    // Cleared here too. An abandoned reset still holds a live token, and it
    // would otherwise sit in this table for as long as anyone left it there.
    expect(row.rows[0]?.payload_sealed).toBeNull();
  });
});
