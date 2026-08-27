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
import { MonitoringService } from './monitoring.service.js';

/**
 * The case file, over HTTP.
 *
 * The claim worth an end-to-end suite is that CLOSING ONE CASE DECIDES EVERY
 * SIGNAL IT COVERS. That is the whole reason a case exists rather than a
 * reviewer closing five rows, and it happens by trigger — so no unit test can
 * hold an opinion about it, and a service-level test would be asserting that
 * the author's mental model of the trigger matches the trigger.
 */

const DATABASE_URL = process.env['DATABASE_URL'];
if (DATABASE_URL === undefined || DATABASE_URL === '') {
  throw new Error('this suite needs DATABASE_URL pointing at a migrated database');
}

const PASSWORD = 'a-long-enough-password';
const PIN = '481902';

let pool: Pool;
let app: INestApplication;
let monitoring: MonitoringService;

interface Person {
  email: string;
  userId: string;
  uuid: string;
  token: string;
}

async function register(): Promise<Person> {
  const email = `case-${randomUUID()}@example.ng`;
  const created = await request(app.getHttpServer())
    .post('/v1/auth/register')
    .send({
      email,
      password: PASSWORD,
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

/**
 * Signals written directly, not swept for.
 *
 * `monitoring.e2e.test.ts` already proves the rules see real money; this suite
 * is about what a CASE does with signals, and driving real transfers to
 * manufacture four of them would make every assertion below depend on
 * thresholds it does not own.
 */
async function seedSignals(userId: string, count: number): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    await pool.query(
      `INSERT INTO risk_signals (rule, user_id, signal_key, detail)
       VALUES ('large_value', $1::bigint, $2, '{"currency":"NGN"}'::jsonb)`,
      [userId, `case-e2e:${userId}:${randomUUID()}`],
    );
  }
}

const openSignals = async (userId: string): Promise<number> =>
  Number(
    (
      await pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM risk_signals
          WHERE user_id = $1::bigint AND resolved_at IS NULL`,
        [userId],
      )
    ).rows[0]?.n ?? '0',
  );

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: DATABASE_URL, max: 8 });
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
});

afterAll(async () => {
  await app?.close();
  await pool?.end();
});

describe('working a case', () => {
  it('opens one, pulls in the signals, takes notes, and closes the lot', async () => {
    const reviewer = await makeReviewer();
    const customer = await register();
    await seedSignals(customer.userId, 3);
    expect(await openSignals(customer.userId)).toBe(3);

    const opened = await request(app.getHttpServer())
      .post('/v1/admin/risk/cases')
      .set('Authorization', `Bearer ${reviewer.token}`)
      .send({ user_id: customer.uuid, reason: 'three large movements in one morning' })
      .expect(201);

    const caseId = opened.body.id as string;

    // Opening pulled in the customer's loose signals, so nobody else picks one
    // up and starts a second investigation.
    const detail = await request(app.getHttpServer())
      .get(`/v1/admin/risk/cases/${caseId}`)
      .set('Authorization', `Bearer ${reviewer.token}`)
      .expect(200);
    expect(detail.body.signals).toHaveLength(3);
    expect(detail.body.status).toBe('open');

    await request(app.getHttpServer())
      .post(`/v1/admin/risk/cases/${caseId}/notes`)
      .set('Authorization', `Bearer ${reviewer.token}`)
      .send({ note: 'Called the customer; they say it is a property sale.' })
      .expect(204);

    await request(app.getHttpServer())
      .post(`/v1/admin/risk/cases/${caseId}/notes`)
      .set('Authorization', `Bearer ${reviewer.token}`)
      .send({ note: 'Sale agreement received and consistent with the amounts.' })
      .expect(204);

    const closed = await request(app.getHttpServer())
      .post(`/v1/admin/risk/cases/${caseId}/close`)
      .set('Authorization', `Bearer ${reviewer.token}`)
      .send({
        outcome: 'no_action',
        summary: 'Property sale, agreement on file and consistent with the amounts.',
        transaction_pin: PIN,
      })
      .expect(200);
    expect(closed.body.id).toBe(caseId);

    // THE CLAIM. One act decided all three, and each carries the same true
    // statement rather than three separately typed ones.
    expect(await openSignals(customer.userId)).toBe(0);
    const resolutions = await pool.query<{ resolution: string }>(
      `SELECT resolution FROM risk_signals WHERE user_id = $1::bigint`,
      [customer.userId],
    );
    expect(resolutions.rows).toHaveLength(3);
    for (const row of resolutions.rows) {
      expect(row.resolution).toContain('Property sale');
    }

    // The notes survive the closure. A file that lost its working notes when
    // it was decided would be a file nobody could review afterwards.
    const after = await request(app.getHttpServer())
      .get(`/v1/admin/risk/cases/${caseId}`)
      .set('Authorization', `Bearer ${reviewer.token}`)
      .expect(200);
    expect(after.body.notes).toHaveLength(2);
    expect(after.body.status).toBe('closed');
  });

  it('refuses a second open case on the same customer', async () => {
    // Two reviewers investigating one person separately, each seeing half the
    // signals, is exactly what a case file exists to prevent.
    const reviewer = await makeReviewer();
    const customer = await register();
    await seedSignals(customer.userId, 1);

    await request(app.getHttpServer())
      .post('/v1/admin/risk/cases')
      .set('Authorization', `Bearer ${reviewer.token}`)
      .send({ user_id: customer.uuid, reason: 'first look at this customer' })
      .expect(201);

    const second = await request(app.getHttpServer())
      .post('/v1/admin/risk/cases')
      .set('Authorization', `Bearer ${reviewer.token}`)
      .send({ user_id: customer.uuid, reason: 'a colleague looking too' })
      .expect(409);
    expect(second.body.error).toBe('case_already_open');
  });

  it('will not record a report without its reference', async () => {
    // A report nobody can point at is one nobody can prove was filed.
    const reviewer = await makeReviewer();
    const customer = await register();
    await seedSignals(customer.userId, 1);

    const opened = await request(app.getHttpServer())
      .post('/v1/admin/risk/cases')
      .set('Authorization', `Bearer ${reviewer.token}`)
      .send({ user_id: customer.uuid, reason: 'movements the customer will not explain' })
      .expect(201);

    const refused = await request(app.getHttpServer())
      .post(`/v1/admin/risk/cases/${opened.body.id}/close`)
      .set('Authorization', `Bearer ${reviewer.token}`)
      .send({
        outcome: 'reported',
        summary: 'Filed with the NFIU; the explanations did not hold up.',
        transaction_pin: PIN,
      });
    expect(refused.status).toBe(422);
    expect(refused.body.error).toBe('report_reference_required');

    // With the reference, it goes through.
    await request(app.getHttpServer())
      .post(`/v1/admin/risk/cases/${opened.body.id}/close`)
      .set('Authorization', `Bearer ${reviewer.token}`)
      .send({
        outcome: 'reported',
        summary: 'Filed with the NFIU; the explanations did not hold up.',
        report_reference: 'NFIU-STR-2026-004411',
        transaction_pin: PIN,
      })
      .expect(200);
  });

  it('is finished once closed: no reopening, no new notes', async () => {
    // New information opens a NEW case. Reopening in place would mean a file
    // decided on one set of facts now reads as though it was decided on
    // another.
    const reviewer = await makeReviewer();
    const customer = await register();
    await seedSignals(customer.userId, 1);

    const opened = await request(app.getHttpServer())
      .post('/v1/admin/risk/cases')
      .set('Authorization', `Bearer ${reviewer.token}`)
      .send({ user_id: customer.uuid, reason: 'one movement worth explaining' })
      .expect(201);

    await request(app.getHttpServer())
      .post(`/v1/admin/risk/cases/${opened.body.id}/close`)
      .set('Authorization', `Bearer ${reviewer.token}`)
      .send({
        outcome: 'no_action',
        summary: 'Salary payment from a named employer, seen every month.',
        transaction_pin: PIN,
      })
      .expect(200);

    const note = await request(app.getHttpServer())
      .post(`/v1/admin/risk/cases/${opened.body.id}/notes`)
      .set('Authorization', `Bearer ${reviewer.token}`)
      .send({ note: 'one more thought' });
    expect(note.status).toBe(409);
    expect(note.body.error).toBe('case_closed');

    // And a NEW case is permitted, which is the whole point of refusing the
    // reopen rather than simply forbidding further work.
    await request(app.getHttpServer())
      .post('/v1/admin/risk/cases')
      .set('Authorization', `Bearer ${reviewer.token}`)
      .send({ user_id: customer.uuid, reason: 'new information since the first case' })
      .expect(201);
  });

  it('refuses a summary that says nothing', async () => {
    // It becomes the resolution on every signal the case covers.
    const reviewer = await makeReviewer();
    const customer = await register();
    await seedSignals(customer.userId, 1);

    const opened = await request(app.getHttpServer())
      .post('/v1/admin/risk/cases')
      .set('Authorization', `Bearer ${reviewer.token}`)
      .send({ user_id: customer.uuid, reason: 'a movement worth a look' })
      .expect(201);

    const res = await request(app.getHttpServer())
      .post(`/v1/admin/risk/cases/${opened.body.id}/close`)
      .set('Authorization', `Bearer ${reviewer.token}`)
      .send({ outcome: 'no_action', summary: 'fine', transaction_pin: PIN });
    expect(res.status).toBe(400);
  });

  it('is refused to a signed-in customer', async () => {
    const customer = await register();
    const res = await request(app.getHttpServer())
      .get('/v1/admin/risk/cases')
      .set('Authorization', `Bearer ${customer.token}`);
    expect(res.status).toBe(403);
  });
});

describe('a pattern that opens its own case', () => {
  it('opens one when a customer accrues enough signals', async () => {
    // Noticing a pattern otherwise means somebody sorting the queue by
    // customer and counting, which is the work nobody does at four in the
    // afternoon.
    const reviewer = await makeReviewer();
    const customer = await register();
    await seedSignals(customer.userId, 4);

    const report = await monitoring.sweep();
    expect(report.casesOpened).toBeGreaterThan(0);

    const queue = await request(app.getHttpServer())
      .get('/v1/admin/risk/cases')
      .set('Authorization', `Bearer ${reviewer.token}`)
      .expect(200);

    const mine = (
      queue.body.cases as {
        id: string;
        email: string;
        opened_by_the_sweep: boolean;
        signals: number;
      }[]
    ).find((c) => c.email === customer.email);

    expect(mine).toBeDefined();
    // Said out loud, because "opened by counting" is a different starting
    // point for a reviewer than "opened because somebody judged it worth it".
    expect(mine?.opened_by_the_sweep).toBe(true);
    expect(mine?.signals).toBe(4);
  });

  it('does not open a second one on the next pass', async () => {
    const customer = await register();
    await seedSignals(customer.userId, 4);

    await monitoring.sweep();
    await monitoring.sweep();

    const cases = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM risk_cases WHERE user_id = $1::bigint`,
      [customer.userId],
    );
    expect(Number(cases.rows[0]?.n)).toBe(1);
  });
});
