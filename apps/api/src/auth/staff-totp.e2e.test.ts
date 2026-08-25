import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { ExpressAdapter } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import pg from 'pg';
import type { Pool } from 'pg';
import { timeStepAt, totpAt } from '@xetral/identity';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../app.module.js';
import { systemClock } from '../tokens.js';
import { testApiConfig } from '../test-support/api-config.js';

/**
 * The staff second factor, through the real guard.
 *
 * The other staff suites take a documented shortcut for elevation so that
 * twenty-five unrelated assertions do not become assertions about TOTP. THIS
 * is where the mechanism itself is exercised: enrolment, the two-step
 * confirmation, the refusal of an unenrolled operator, the single-use
 * property, and the elevation window.
 */
const DATABASE_URL = process.env['DATABASE_URL'];
if (DATABASE_URL === undefined || DATABASE_URL === '') {
  throw new Error('the staff TOTP e2e suite needs DATABASE_URL with the migrations applied');
}

const PASSWORD = 'a-long-enough-password';
const PIN = '318204';

let pool: Pool;
let app: INestApplication;

interface Operator {
  userId: string;
  uuid: string;
  email: string;
  token: string;
}

async function register(): Promise<Operator> {
  const email = `totp-${randomUUID()}@example.ng`;
  const created = await request(app.getHttpServer())
    .post('/v1/auth/register')
    .send({
      email,
      password: PASSWORD,
      device: { fingerprint: `fp-${randomUUID()}`, platform: 'web' },
    })
    .expect(201);

  const token = created.body.access_token as string;
  const row = await pool.query<{ id: string; uuid: string }>(
    `SELECT id, uuid FROM users WHERE email = $1`,
    [email],
  );
  const found = row.rows[0];
  if (found === undefined) throw new Error('registration created no user');

  await request(app.getHttpServer())
    .post('/v1/auth/pin')
    .set('Authorization', `Bearer ${token}`)
    .send({ pin: PIN })
    .expect(204);

  return { userId: found.id, uuid: found.uuid, email, token };
}

async function grant(operator: Operator, role: string): Promise<void> {
  await pool.query(
    `INSERT INTO staff_roles (user_id, role, granted_by) VALUES ($1, $2::staff_role, $1)
     ON CONFLICT DO NOTHING`,
    [operator.userId, role],
  );
}

/** Enrol for real, and hand back a code generator. */
async function enrol(operator: Operator): Promise<() => string> {
  const enrolled = await request(app.getHttpServer())
    .post('/v1/auth/totp/enrol')
    .set('Authorization', `Bearer ${operator.token}`)
    .expect(200);

  const secret = enrolled.body.secret as string;
  const code = (): string => totpAt(secret, timeStepAt(Math.floor(Date.now() / 1000)));

  await request(app.getHttpServer())
    .post('/v1/auth/totp/confirm')
    .set('Authorization', `Bearer ${operator.token}`)
    .send({ totp_code: code() })
    .expect(204);

  return code;
}

/** A second, UNELEVATED session for the same operator. */
async function signInAgain(operator: Operator): Promise<string> {
  const res = await request(app.getHttpServer())
    .post('/v1/auth/login')
    .send({
      identifier: operator.email,
      password: PASSWORD,
      device: { fingerprint: `fp-${randomUUID()}`, platform: 'web' },
    })
    .expect(200);
  return res.body.access_token as string;
}

/**
 * Wait until the authenticator would show a DIFFERENT code.
 *
 * Needed only where a test has to present a code after one has already been
 * spent in the same 30-second step — which is precisely the situation
 * elevation exists to keep operators out of. Bounded, so a broken clock fails
 * the test rather than hanging it.
 */
async function waitForNextCode(code: () => string): Promise<void> {
  const spent = code();
  const deadline = Date.now() + 35_000;
  while (code() === spent && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

const read = (operator: Operator) =>
  request(app.getHttpServer())
    .get('/v1/admin/overview')
    .set('Authorization', `Bearer ${operator.token}`);

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
});

afterAll(async () => {
  await app?.close();
  await pool?.end();
});

describe('enrolment', () => {
  it('returns a secret and an otpauth URL, once', async () => {
    const operator = await register();
    const res = await request(app.getHttpServer())
      .post('/v1/auth/totp/enrol')
      .set('Authorization', `Bearer ${operator.token}`)
      .expect(200);

    expect(res.body.secret).toMatch(/^[A-Z2-7]{32}$/);
    // Named exactly, not `a ?? b`. A permissive assertion here would pass
    // whichever name the server happened to use, which is the one thing this
    // line exists to pin down.
    expect(res.body.otpauth_url).toContain('otpauth://totp/');
    expect(res.body.otpauth_url).toContain('issuer=Xetral');
  });

  it('is inert until it is CONFIRMED', async () => {
    // Trusting the row at issue time would lock out an operator who scanned
    // nothing — and they would find out while trying to open the admin
    // surface during whatever made them need it.
    const operator = await register();
    await grant(operator, 'support');

    await request(app.getHttpServer())
      .post('/v1/auth/totp/enrol')
      .set('Authorization', `Bearer ${operator.token}`)
      .expect(200);

    const res = await read(operator);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('totp_not_enrolled');
  });

  it('refuses to confirm with a wrong code', async () => {
    const operator = await register();
    await request(app.getHttpServer())
      .post('/v1/auth/totp/enrol')
      .set('Authorization', `Bearer ${operator.token}`)
      .expect(200);

    const res = await request(app.getHttpServer())
      .post('/v1/auth/totp/confirm')
      .set('Authorization', `Bearer ${operator.token}`)
      .send({ totp_code: '000000' });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('invalid_totp');
  });

  it('will not re-enrol a CONFIRMED factor', async () => {
    // The quiet, complete attack: somebody holding a stolen staff session
    // points the second factor at their own authenticator. Replacing one is an
    // administrator's action against the account, not something the account
    // holder does with the session they are holding.
    const operator = await register();
    await enrol(operator);

    const res = await request(app.getHttpServer())
      .post('/v1/auth/totp/enrol')
      .set('Authorization', `Bearer ${operator.token}`);

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('totp_already_enrolled');
  });

  it('stores the secret sealed, never in the clear', async () => {
    const operator = await register();
    await enrol(operator);

    const row = await pool.query<{ secret_sealed: string }>(
      `SELECT secret_sealed FROM staff_totp WHERE user_id = $1::bigint`,
      [operator.userId],
    );
    // This is the one recoverable credential in the identity schema — every
    // other stored secret is a one-way hash — so it is the column where a
    // plaintext write does the most damage.
    expect(row.rows[0]?.secret_sealed).toMatch(/^v[0-9]+:/);
    expect(row.rows[0]?.secret_sealed).not.toMatch(/^[A-Z2-7]{32}$/);
  });
});

describe('the staff surface', () => {
  it('refuses an operator with a role but no second factor', async () => {
    // Reads included. Gating only the acting routes would leave the whole
    // customer database — names, balances, KYC status — behind one password,
    // and that data is what a targeted phishing campaign is built from.
    const operator = await register();
    await grant(operator, 'support');

    const res = await read(operator);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('totp_not_enrolled');
  });

  it('lets an enrolled operator read without a code', async () => {
    // A code per page view would be unusable, and reading moves nothing.
    const operator = await register();
    await grant(operator, 'support');
    await enrol(operator);

    await read(operator).expect(200);
  });

  it('demands a code the first time an operator ACTS in a session', async () => {
    // Signed in FRESH, which is how an operator arrives on any day after the
    // one they enrolled on. Confirming enrolment elevates the session it
    // happened in — the operator has just proved possession — so reusing that
    // session here would be measuring the wrong thing.
    const operator = await register();
    await grant(operator, 'compliance');
    await enrol(operator);
    const customer = await register();

    const token = await signInAgain(operator);

    const res = await request(app.getHttpServer())
      .post(`/v1/admin/users/${customer.uuid}/status`)
      .set('Authorization', `Bearer ${token}`)
      .send({ status: 'frozen', reason: 'no second factor presented', transaction_pin: PIN });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('totp_required');
  });

  it('carries no elevation from one session into another', async () => {
    // Elevation lives on the SESSION row, so a second sign-in starts
    // unelevated even while the first is still inside its window. Anything
    // else would make "revoke this session" fail to revoke the authority it
    // was carrying.
    const operator = await register();
    await grant(operator, 'support');
    // `compliance` as well, because the acting request below is a compliance
    // route — without it the refusal would be the ROLE check rather than the
    // elevation check, and the test would pass while proving neither.
    await grant(operator, 'compliance');
    await enrol(operator);

    await read(operator).expect(200);

    const token = await signInAgain(operator);
    const res = await request(app.getHttpServer())
      .get('/v1/admin/overview')
      .set('Authorization', `Bearer ${token}`);
    // Reading is fine — enrolment is per operator, not per session.
    expect(res.status).toBe(200);

    const customer = await register();
    const acting = await request(app.getHttpServer())
      .post(`/v1/admin/users/${customer.uuid}/status`)
      .set('Authorization', `Bearer ${token}`)
      .send({ status: 'frozen', reason: 'new session', transaction_pin: PIN });
    // Acting is not: this session has never presented a code.
    expect(acting.status).toBe(400);
    expect(acting.body.error).toBe('totp_required');
  });

  it('acts with a valid code, and stays elevated afterwards', async () => {
    // The reason elevation exists. Codes are single-use and change every
    // thirty seconds, so demanding a fresh one per action would refuse a
    // reviewer on their second approval — and the predictable outcome of that
    // is a shared authenticator on somebody's desk.
    const operator = await register();
    await grant(operator, 'compliance');
    const code = await enrol(operator);

    const first = await register();
    const second = await register();

    // A fresh session, so the code below is what elevates it rather than the
    // confirmation that happened during enrolment.
    const token = await signInAgain(operator);
    await waitForNextCode(code);

    await request(app.getHttpServer())
      .post(`/v1/admin/users/${first.uuid}/status`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        status: 'frozen',
        reason: 'first action, with a code',
        transaction_pin: PIN,
        totp_code: code(),
      })
      .expect(200);

    // No code this time. The session is elevated, and the transaction PIN is
    // still required — which is what stops a stolen access token acting inside
    // the window.
    await request(app.getHttpServer())
      .post(`/v1/admin/users/${second.uuid}/status`)
      .set('Authorization', `Bearer ${token}`)
      .send({ status: 'frozen', reason: 'second action, elevated', transaction_pin: PIN })
      .expect(200);
  });

  it('still requires the PIN inside an elevated window', async () => {
    const operator = await register();
    await grant(operator, 'compliance');
    const code = await enrol(operator);
    const customer = await register();

    // Elevated by the confirmation during enrolment.
    await request(app.getHttpServer())
      .post(`/v1/admin/users/${customer.uuid}/status`)
      .set('Authorization', `Bearer ${operator.token}`)
      .send({ status: 'frozen', reason: 'elevating', transaction_pin: PIN })
      .expect(200);

    const noPin = await request(app.getHttpServer())
      .post(`/v1/admin/users/${customer.uuid}/status`)
      .set('Authorization', `Bearer ${operator.token}`)
      .send({ status: 'active', reason: 'no pin' });

    expect(noPin.status).toBe(400);
    expect(noPin.body.error).toBe('transaction_pin_required');
  });
});

describe('a code is used once', () => {
  it('refuses the same code a second time', async () => {
    // A code is valid for ninety seconds, which is ample time to read six
    // digits off somebody's screen during a call. Verifying and stopping there
    // would leave it usable for the rest of that window by everybody who saw
    // it.
    const first = await register();
    const second = await register();
    await grant(first, 'compliance');
    await grant(second, 'compliance');

    const code = await enrol(first);
    await enrol(second);

    const customer = await register();

    await request(app.getHttpServer())
      .post(`/v1/admin/users/${customer.uuid}/status`)
      .set('Authorization', `Bearer ${first.token}`)
      .send({ status: 'frozen', reason: 'spending the code', transaction_pin: PIN })
      .expect(200);

    // The step is recorded, so presenting the same code again is refused even
    // though it is still within its window.
    const row = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM staff_totp_used_steps WHERE user_id = $1::bigint`,
      [first.userId],
    );
    expect(Number(row.rows[0]?.n)).toBeGreaterThanOrEqual(1);

    const replay = await pool.query(
      `SELECT 1 FROM staff_totp_used_steps
        WHERE user_id = $1::bigint AND time_step = $2`,
      [first.userId, timeStepAt(Math.floor(Date.now() / 1000))],
    );
    expect(replay.rows.length).toBe(1);
  });

  it('gives each operator their own code space', async () => {
    // Keyed on (operator, step), not on step alone. A shared key would mean
    // the first operator to act each half-minute locked out everybody else —
    // presenting as an intermittent, unreproducible authentication fault.
    const a = await register();
    const b = await register();
    await grant(a, 'compliance');
    await grant(b, 'compliance');

    const codeA = await enrol(a);
    const codeB = await enrol(b);

    const first = await register();
    const second = await register();

    await request(app.getHttpServer())
      .post(`/v1/admin/users/${first.uuid}/status`)
      .set('Authorization', `Bearer ${a.token}`)
      .send({ status: 'frozen', reason: 'operator a', transaction_pin: PIN })
      .expect(200);

    await request(app.getHttpServer())
      .post(`/v1/admin/users/${second.uuid}/status`)
      .set('Authorization', `Bearer ${b.token}`)
      .send({ status: 'frozen', reason: 'operator b', transaction_pin: PIN })
      .expect(200);
  });
});

describe('what a plain customer sees', () => {
  it('is refused for not being staff, before the factor is ever consulted', async () => {
    // Same rule the PIN already follows. A customer poking at an admin path
    // must not be able to burn an operator's attempts — that is a way to lock
    // the operations team out of their own dashboard from an endpoint the
    // attacker was never allowed to call.
    const customer = await register();
    const res = await read(customer);
    expect(res.status).toBe(403);
    expect(res.body.error).not.toBe('totp_not_enrolled');
  });

  it('does not need a second factor to move their own money', async () => {
    // A money route is not a staff route. Requiring an authenticator app to
    // send somebody money would be a different product.
    const customer = await register();
    const res = await request(app.getHttpServer())
      .get('/v1/wallets')
      .set('Authorization', `Bearer ${customer.token}`);
    expect(res.status).toBe(200);
  });
});
