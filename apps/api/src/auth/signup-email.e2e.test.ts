import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { ExpressAdapter } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import pg from 'pg';
import type { Pool } from 'pg';
import type { NotificationMessage, NotificationPort, NotificationReceipt } from '@xetral/providers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../app.module.js';
import { systemClock } from '../tokens.js';
import { testApiConfig } from '../test-support/api-config.js';
import { SettingsService } from '../settings/settings.service.js';

/**
 * AN ACCOUNT IS OPENED ONLY ON AN ADDRESS SOMEBODY HAS PROVED.
 *
 * Driven through the endpoints a signup form calls, with the code read out of
 * the email that was sent — the way the customer reads it.
 */

const DATABASE_URL = process.env['DATABASE_URL'];
if (DATABASE_URL === undefined || DATABASE_URL === '') {
  throw new Error('the signup email e2e suite needs DATABASE_URL with the migrations applied');
}

class StubMailer implements NotificationPort {
  readonly provider = 'stub';
  readonly sent: NotificationMessage[] = [];
  async send(message: NotificationMessage): Promise<NotificationReceipt> {
    this.sent.push(message);
    return { providerMessageId: `stub_${this.sent.length}` };
  }
}

let pool: Pool;
let app: INestApplication;
let mailer: StubMailer;

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: DATABASE_URL, max: 6 });
  mailer = new StubMailer();
  const mod = await Test.createTestingModule({
    imports: [
      AppModule.forRoot({
        config: testApiConfig(DATABASE_URL as string, { signupEmailVerification: true }),
        pool,
        clock: systemClock,
        notificationPort: mailer,
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

const address = (): string => `signup-${randomUUID()}@example.ng`;

async function codeMailedTo(email: string): Promise<string> {
  for (let pass = 0; pass < 100; pass += 1) {
    const mail = [...mailer.sent].reverse().find((m) => m.to === email);
    if (mail !== undefined) {
      const match = /\b[0-9]{6}\b/.exec(mail.text);
      if (match === null) throw new Error(`no code in: ${mail.text}`);
      return match[0];
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`no code was mailed to ${email}`);
}

const register = (email: string, code?: string) =>
  request(app.getHttpServer())
    .post('/v1/auth/register')
    .send({
      email,
      password: 'a-long-enough-password',
      full_name: 'Adaeze Okonkwo',
      country: 'NG',
      phone: String(8000000000 + Math.floor(Math.random() * 999999999)),
      ...(code === undefined ? {} : { email_code: code }),
      device: { fingerprint: `fp-${randomUUID()}`, platform: 'web' },
    });

describe('proving the address before the account', () => {
  it('MAILS A CODE, and the account opens only with it', async () => {
    const email = address();
    const asked = await request(app.getHttpServer())
      .post('/v1/auth/signup/email-code')
      .send({ email })
      .expect(200);
    expect(asked.body).toEqual({ required: true });

    const code = await codeMailedTo(email);
    await register(email, code).expect(201);

    const row = await pool.query<{ email_verified_at: Date | null }>(
      `SELECT email_verified_at FROM users WHERE email = $1`,
      [email],
    );
    expect(row.rows[0]?.email_verified_at).not.toBeNull();
  });

  it('REFUSES A REGISTRATION WITH NO CODE, and opens nothing', async () => {
    const email = address();
    const refused = await register(email).expect(400);
    expect(refused.body.error).toBe('email_code_required');
    const row = await pool.query(`SELECT 1 FROM users WHERE email = $1`, [email]);
    expect(row.rowCount).toBe(0);
  });

  it('REFUSES A WRONG CODE, and a code mailed to one address cannot open another', async () => {
    const mine = address();
    await request(app.getHttpServer()).post('/v1/auth/signup/email-code').send({ email: mine }).expect(200);
    const code = await codeMailedTo(mine);
    const wrong = code === '000000' ? '111111' : '000000';

    expect((await register(mine, wrong).expect(400)).body.error).toBe('email_code_invalid');
    expect((await register(address(), code).expect(400)).body.error).toBe('email_code_invalid');
    // And the right one still works afterwards: a wrong guess charged, it did not spend.
    await register(mine, code).expect(201);
  });

  it('CHARGES A WRONG GUESS EVEN THOUGH THE REGISTRATION ROLLS BACK', async () => {
    const email = address();
    await request(app.getHttpServer()).post('/v1/auth/signup/email-code').send({ email }).expect(200);
    const code = await codeMailedTo(email);
    const wrong = code === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i += 1) await register(email, wrong).expect(400);
    // The ceiling is reached: even the right code is refused now.
    expect((await register(email, code).expect(400)).body.error).toBe('too_many_attempts');
  });

  it('SPENDS A CODE ONCE', async () => {
    const email = address();
    await request(app.getHttpServer()).post('/v1/auth/signup/email-code').send({ email }).expect(200);
    const code = await codeMailedTo(email);
    await register(email, code).expect(201);
    // The same address again is taken — and the code is gone either way.
    const again = await pool.query(
      `SELECT consumed_at FROM signup_email_codes WHERE email = $1`,
      [email],
    );
    expect(again.rows[0]?.consumed_at).not.toBeNull();
  });

  it('SAYS AN ADDRESS IS TAKEN rather than mailing a code to it', async () => {
    const email = address();
    await request(app.getHttpServer()).post('/v1/auth/signup/email-code').send({ email }).expect(200);
    await register(email, await codeMailedTo(email)).expect(201);
    const before = mailer.sent.length;
    const taken = await request(app.getHttpServer())
      .post('/v1/auth/signup/email-code')
      .send({ email })
      .expect(409);
    expect(taken.body.error).toBe('email_taken');
    expect(mailer.sent.length).toBe(before);
  });

  it('ASKS FOR NOTHING when an operator has switched verification off', async () => {
    await pool.query(`UPDATE platform_settings SET value = 'false' WHERE key = 'signup_email_verification'`);
    try {
      await app.get(SettingsService).refresh();
      const email = address();
      const asked = await request(app.getHttpServer())
        .post('/v1/auth/signup/email-code')
        .send({ email })
        .expect(200);
      expect(asked.body).toEqual({ required: false });
      await register(email).expect(201);
    } finally {
      await pool.query(`UPDATE platform_settings SET value = 'true' WHERE key = 'signup_email_verification'`);
      await app.get(SettingsService).refresh();
    }
  });
});
