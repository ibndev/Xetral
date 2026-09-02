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

/**
 * Consent, over HTTP.
 *
 * THE PROPERTY WORTH PROVING is that registering leaves a record. Every other
 * suite here seeds users with an INSERT, which is exactly how the audit's
 * first finding — that there was no registration endpoint at all — stayed
 * invisible; so this one goes through the endpoint deliberately.
 */
const DATABASE_URL = process.env['DATABASE_URL'];
if (DATABASE_URL === undefined || DATABASE_URL === '') {
  throw new Error('the consent e2e suite needs DATABASE_URL with the migrations applied');
}

const PASSWORD = 'a-long-enough-password';

let pool: Pool;
let app: INestApplication;

interface Customer {
  identifier: string;
  token: string;
}

/** Through the endpoint, because that is the path that records consent. */
async function register(): Promise<Customer> {
  const identifier = `consent-${randomUUID()}@example.ng`;
  const res = await request(app.getHttpServer())
    .post('/v1/auth/register')
    .set('User-Agent', 'xetral-test/1.0')
    .send({
      email: identifier,
      password: PASSWORD,
      // 040 made these required: a name, a place and a reachable number.
      full_name: 'E2E Test Person',
      country: 'NG',
      phone: String(8000000000 + Math.floor(Math.random() * 999999999)),
      device: { fingerprint: `fp-${randomUUID()}`, platform: 'ios' },
    })
    .expect(201);
  return { identifier, token: res.body.access_token as string };
}

const consents = (customer: Customer) =>
  request(app.getHttpServer())
    .get('/v1/consents')
    .set('Authorization', `Bearer ${customer.token}`);

const setConsent = (customer: Customer, kind: string, granted: boolean) =>
  request(app.getHttpServer())
    .post('/v1/consents')
    .set('Authorization', `Bearer ${customer.token}`)
    .send({ kind, granted });

async function recordsFor(identifier: string): Promise<
  { kind: string; granted: boolean; source: string; ip: string | null; user_agent: string | null }[]
> {
  const rows = await pool.query(
    `SELECT r.kind::TEXT AS kind, r.granted, r.source::TEXT AS source,
            host(r.ip) AS ip, r.user_agent
       FROM consent_records r JOIN users u ON u.id = r.user_id
      WHERE u.email = $1 ORDER BY r.id`,
    [identifier],
  );
  return rows.rows as never;
}

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: DATABASE_URL, max: 8 });
  const mod = await Test.createTestingModule({
    imports: [
      AppModule.forRoot({ config: testApiConfig(DATABASE_URL as string), pool, clock: systemClock }),
    ],
  }).compile();
  app = mod.createNestApplication(new ExpressAdapter());
  await app.init();
});

afterAll(async () => {
  await app?.close();
  await pool?.end();
});

describe('registering', () => {
  it('records agreement to the terms and the privacy notice', async () => {
    // Before this existed, "they agreed" was a sentence on a page and nothing
    // else. The NDPA asks the controller to DEMONSTRATE consent, and there
    // was nothing to demonstrate it with.
    const person = await register();
    const rows = await recordsFor(person.identifier);

    expect(rows.map((r) => r.kind).sort()).toEqual(['privacy', 'terms']);
    expect(rows.every((r) => r.granted)).toBe(true);
    expect(rows.every((r) => r.source === 'registration')).toBe(true);
    // What was recorded about the moment. Both describe the consent and
    // neither decides it.
    expect(rows.every((r) => r.user_agent === 'xetral-test/1.0')).toBe(true);
  });

  it('does NOT record a mailing-list consent', async () => {
    // Bundling one into "create account" is not consent to it, whatever the
    // button said — and the database refuses the pairing outright, so this
    // cannot regress by somebody adding a checkbox to the form.
    const person = await register();
    const rows = await recordsFor(person.identifier);
    expect(rows.some((r) => r.kind === 'marketing_email')).toBe(false);
  });

  it('leaves nothing behind when registration fails', async () => {
    // The record is written on the registration's own transaction. Written
    // afterwards, a failure between the two would leave consent for an
    // account that does not exist — or an account whose consent we cannot
    // show, depending on the order.
    const identifier = `consent-${randomUUID()}@example.ng`;
    await request(app.getHttpServer())
      .post('/v1/auth/register')
      .send({
        email: identifier,
        password: 'short',
        // 040 made these required. A registration is now a name, a place
        // and a reachable number as well as an address.
        full_name: 'E2E Test Person',
        country: 'NG',
        phone: String(8000000000 + Math.floor(Math.random() * 999999999)),
        device: { fingerprint: `fp-${randomUUID()}`, platform: 'ios' },
      })
      .expect(400);

    expect(await recordsFor(identifier)).toEqual([]);
  });
});

describe('what a customer can see', () => {
  it('shows which version they agreed to', async () => {
    const person = await register();
    const res = await consents(person).expect(200);

    const terms = (res.body.consents as { kind: string; version: string; covers_current: boolean }[])
      .find((c) => c.kind === 'terms');
    expect(terms?.version).toMatch(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/);
    // Recording "yes" without recording WHICH WORDS cannot answer the only
    // question that matters once a notice is republished.
    expect(terms?.covers_current).toBe(true);
  });

  it('needs a token', async () => {
    const res = await request(app.getHttpServer()).get('/v1/consents');
    expect(res.status).toBe(401);
  });
});

describe('the mailing list', () => {
  it('starts off, and can be turned on and off again', async () => {
    const person = await register();

    const before = await consents(person).expect(200);
    const marketingBefore = (before.body.documents as { kind: string; agreed: boolean }[]).find(
      (d) => d.kind === 'marketing_email',
    );
    // NOT opted in is the resting state. A default of "yes" would mean an
    // opt-in nobody made.
    expect(marketingBefore?.agreed).toBe(false);

    await setConsent(person, 'marketing_email', true).expect(200);
    const on = await consents(person).expect(200);
    expect(
      (on.body.documents as { kind: string; agreed: boolean }[]).find(
        (d) => d.kind === 'marketing_email',
      )?.agreed,
    ).toBe(true);

    // ONE CALL, no PIN, no confirmation. Consent harder to withdraw than to
    // give is not freely given.
    await setConsent(person, 'marketing_email', false).expect(200);
    const off = await consents(person).expect(200);
    expect(
      (off.body.documents as { kind: string; agreed: boolean }[]).find(
        (d) => d.kind === 'marketing_email',
      )?.agreed,
    ).toBe(false);

    // And BOTH answers are still on record. A withdrawal that erased the
    // grant would make "had they consented when we mailed them?" a claim
    // about the present.
    const rows = await recordsFor(person.identifier);
    const marketing = rows.filter((r) => r.kind === 'marketing_email');
    expect(marketing.map((r) => r.granted)).toEqual([true, false]);
  });

  it('refuses to withdraw the terms', async () => {
    // Not obstruction: withdrawing the terms is closing the account, which
    // moves money and has its own path. Recording it here would leave a
    // customer holding a balance under terms they are recorded as refusing.
    const person = await register();
    const res = await setConsent(person, 'terms', false);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('consent_not_withdrawable');
  });

  it('refuses a kind nobody publishes', async () => {
    const person = await register();
    const res = await setConsent(person, 'something_else', true);
    expect(res.status).toBe(400);
  });
});

describe('what an operator sees', () => {
  it('lists nobody once everyone has agreed to what is published', async () => {
    // The resting state, and the one that fills the moment a notice is
    // republished — which is exactly when somebody needs to see it.
    const person = await register();
    const outstanding = await pool.query(
      `SELECT 1 FROM consent_outstanding o JOIN users u ON u.id = o.user_id
        WHERE u.email = $1`,
      [person.identifier],
    );
    expect(outstanding.rowCount).toBe(0);
  });
});
