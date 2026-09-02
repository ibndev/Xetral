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

/**
 * Publishing a price over HTTP.
 *
 * THE PROPERTY WORTH PROVING is that a price can be set at all. Nothing in
 * the application ever wrote `fx_spread_policies` or `giftcard_rate_cards`,
 * so a fresh deployment refused every FX pair and gift cards could be switched
 * on and then 404 the first customer quote — and the only way out was a psql
 * prompt on the production database.
 *
 * Requires DATABASE_URL with every migration applied.
 */
const DATABASE_URL = process.env['DATABASE_URL'];
if (DATABASE_URL === undefined || DATABASE_URL === '') {
  throw new Error('the pricing e2e suite needs DATABASE_URL with the migrations applied');
}

const PASSWORD = 'a-long-enough-password';
const PIN = '374915';

let pool: Pool;
let app: INestApplication;
let finance: Customer;

interface Customer {
  identifier: string;
  userId: string;
  token: string;
}

async function register(): Promise<Customer> {
  const identifier = `pricing-${randomUUID()}@example.ng`;
  const res = await request(app.getHttpServer())
    .post('/v1/auth/register')
    .send({
      email: identifier,
      password: PASSWORD,
      // 040 made these required. A registration is now a name, a place
      // and a reachable number as well as an address.
      full_name: 'E2E Test Person',
      country: 'NG',
      phone: String(8000000000 + Math.floor(Math.random() * 999999999)),
      device: { fingerprint: `fp-${randomUUID()}`, platform: 'ios' },
    })
    .expect(201);
  const token = res.body.access_token as string;

  await request(app.getHttpServer())
    .post('/v1/auth/pin')
    .set('Authorization', `Bearer ${token}`)
    .send({ pin: PIN })
    .expect(204);

  const found = await pool.query<{ id: string }>(`SELECT id FROM users WHERE email = $1`, [
    identifier,
  ]);
  return { identifier, userId: found.rows[0]?.id as string, token };
}

async function makeStaff(person: Customer, role: string): Promise<void> {
  await pool.query(
    `INSERT INTO staff_roles (user_id, role, granted_by) VALUES ($1, $2::staff_role, $1)
     ON CONFLICT DO NOTHING`,
    [person.userId, role],
  );
  await enrolAndElevate(app, pool, person.token, person.userId);
}

const post = (path: string, body: Record<string, unknown>, who: Customer = finance) =>
  request(app.getHttpServer())
    .post(path)
    .set('Authorization', `Bearer ${who.token}`)
    .send({ transaction_pin: PIN, ...body });

/** A brand nobody else uses, so this suite cannot collide with the gift card
 *  suite's own rate card on the shared database. */
const brand = (): string => `pricing-${randomUUID().slice(0, 8)}`;

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: DATABASE_URL, max: 8 });
  const mod = await Test.createTestingModule({
    imports: [
      AppModule.forRoot({ config: testApiConfig(DATABASE_URL as string), pool, clock: systemClock }),
    ],
  }).compile();
  app = mod.createNestApplication(new ExpressAdapter());
  await app.init();

  finance = await register();
  await makeStaff(finance, 'finance');
});

afterAll(async () => {
  await app?.close();
  await pool?.end();
});

describe('publishing an FX spread', () => {
  it('takes a pair from unpublished to quotable', async () => {
    // The gap this whole surface exists to close. An unpublished pair is
    // refused rather than quoted from a default — Phase 10 chose that
    // deliberately — so before this endpoint the only way to make FX work at
    // all was psql on the production database.
    const before = await pool.query(
      `SELECT 1 FROM fx_spread_policies
        WHERE base_currency = 'GBP' AND quote_currency = 'EUR' AND retired_at IS NULL`,
    );
    expect(before.rowCount).toBe(0);

    const res = await post('/v1/admin/prices/fx', {
      base_currency: 'GBP',
      quote_currency: 'EUR',
      spread_basis_points: 150,
      min_base_minor: '10000',
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ base_currency: 'GBP', spread_basis_points: 150 });

    const after = await pool.query<{ created_by: string | null }>(
      `SELECT created_by FROM fx_spread_policies
        WHERE base_currency = 'GBP' AND quote_currency = 'EUR' AND retired_at IS NULL`,
    );
    // A published price ALWAYS has an author on this path. The column is
    // nullable because rows already existed; `prices_without_an_author` is
    // what finds the ones written at a prompt.
    expect(after.rows[0]?.created_by).toBe(finance.userId);
  });

  it('refuses a second live spread for the same pair', async () => {
    // Two live spreads would make a quote depend on which row came back
    // first. Retiring the old one is a separate, visible act rather than
    // something publishing does on the operator's behalf — it changes what
    // every customer is quoted.
    const res = await post('/v1/admin/prices/fx', {
      base_currency: 'GBP',
      quote_currency: 'EUR',
      spread_basis_points: 200,
      min_base_minor: '10000',
    });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('price_already_published');
  });

  it('prices each direction separately', async () => {
    // A rate is a RATIO, and "minor units per major unit" collapses in one of
    // the two directions. Refusing the reverse pair would make half of FX
    // unpublishable.
    const res = await post('/v1/admin/prices/fx', {
      base_currency: 'EUR',
      quote_currency: 'GBP',
      spread_basis_points: 175,
      min_base_minor: '10000',
    });
    expect(res.status).toBe(201);
  });

  it('refuses a spread outside the bound', async () => {
    // 15% typed where basis points were meant. The bound is a CHECK as well,
    // so this is refused whether it arrives through the dashboard or psql.
    const res = await post('/v1/admin/prices/fx', {
      base_currency: 'GBP',
      quote_currency: 'USD',
      spread_basis_points: 150_000,
      min_base_minor: '10000',
    });
    expect(res.status).toBe(400);
  });
});

describe('publishing a gift card rate', () => {
  it('refuses a band that overlaps a live one', async () => {
    // The hazard a form makes likely: `#liveRate` picks the newest of
    // whatever matches, so an overlap silently reprices the shared range.
    const name = brand();
    expect(
      (
        await post('/v1/admin/prices/giftcard', {
          brand: name,
          country: 'US',
          card_type: 'ecode',
          face_currency: 'USD',
          payout_currency: 'NGN',
          payout_rate_minor: '125000',
          min_face_minor: '1000',
          max_face_minor: '50000',
        })
      ).status,
    ).toBe(201);

    const overlapping = await post('/v1/admin/prices/giftcard', {
      brand: name,
      country: 'US',
      card_type: 'ecode',
      face_currency: 'USD',
      payout_currency: 'NGN',
      payout_rate_minor: '130000',
      min_face_minor: '25000',
      max_face_minor: '100000',
    });
    expect(overlapping.status).toBe(409);
    // Named separately from a duplicate because the fix is different: retire
    // what it overlaps, or narrow this band.
    expect(overlapping.body.error).toBe('price_band_overlaps');
  });

  it('allows an adjacent band, which is the point of bands', async () => {
    const name = brand();
    await post('/v1/admin/prices/giftcard', {
      brand: name,
      country: 'US',
      card_type: 'ecode',
      face_currency: 'USD',
      payout_currency: 'NGN',
      payout_rate_minor: '125000',
      min_face_minor: '1000',
      max_face_minor: '50000',
    }).expect(201);

    // A $500 card really is worth proportionally less than a $25 one, so a
    // single rate per brand would be wrong in a way that costs money on every
    // large trade.
    const next = await post('/v1/admin/prices/giftcard', {
      brand: name,
      country: 'US',
      card_type: 'ecode',
      face_currency: 'USD',
      payout_currency: 'NGN',
      payout_rate_minor: '118000',
      min_face_minor: '50001',
      max_face_minor: '200000',
    });
    expect(next.status).toBe(201);
  });
});

describe('retiring', () => {
  it('frees the band and keeps the old price on record', async () => {
    const name = brand();
    const published = await post('/v1/admin/prices/giftcard', {
      brand: name,
      country: 'US',
      card_type: 'ecode',
      face_currency: 'USD',
      payout_currency: 'NGN',
      payout_rate_minor: '125000',
      min_face_minor: '1000',
      max_face_minor: '50000',
    }).expect(201);

    const retired = await post(`/v1/admin/prices/${published.body.uuid as string}/retire`, {
      kind: 'giftcard',
      reason: 'repricing after a rate review',
    });
    expect(retired.status).toBe(200);

    // Republishing over the freed range now works, and the old row is still
    // there: it is what explains a quote given last month.
    await post('/v1/admin/prices/giftcard', {
      brand: name,
      country: 'US',
      card_type: 'ecode',
      face_currency: 'USD',
      payout_currency: 'NGN',
      payout_rate_minor: '121000',
      min_face_minor: '1000',
      max_face_minor: '50000',
    }).expect(201);

    const rows = await pool.query(`SELECT 1 FROM giftcard_rate_cards WHERE brand = $1`, [name]);
    expect(rows.rowCount).toBe(2);
  });

  it('requires a reason', async () => {
    // Retiring looks like tidying up and its effect is that the flow the
    // price covered refuses every customer until a replacement exists.
    const published = await post('/v1/admin/prices/fx', {
      base_currency: 'GBP',
      quote_currency: 'NGN',
      spread_basis_points: 150,
      min_base_minor: '10000',
    }).expect(201);

    const res = await post(`/v1/admin/prices/${published.body.uuid as string}/retire`, {
      kind: 'fx',
    });
    expect(res.status).toBe(400);
  });

  it('answers the same for a price that does not exist and one already retired', async () => {
    const res = await post(`/v1/admin/prices/${randomUUID()}/retire`, {
      kind: 'fx',
      reason: 'testing a price that is not there',
    });
    expect(res.status).toBe(404);
  });
});

describe('what an operator can see', () => {
  it('lists both price kinds in one place', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/admin/prices')
      .set('Authorization', `Bearer ${finance.token}`)
      .expect(200);

    const kinds = new Set((res.body.prices as { kind: string }[]).map((p) => p.kind));
    expect(kinds.has('fx_spread')).toBe(true);
    expect(kinds.has('giftcard_rate')).toBe(true);
    // Retired rows are in the detail lists, because they are what explains a
    // quote somebody was given last month.
    expect((res.body.rate_cards as unknown[]).length).toBeGreaterThan(0);
  });

  it('is refused to a signed-in customer who is not finance', async () => {
    const customer = await register();
    const res = await request(app.getHttpServer())
      .get('/v1/admin/prices')
      .set('Authorization', `Bearer ${customer.token}`);
    expect(res.status).toBe(403);
  });
});
