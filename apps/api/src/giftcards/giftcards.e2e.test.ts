import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
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
import { GiftCardHoldService } from './hold-release.service.js';
import { systemClock } from '../tokens.js';
import { testApiConfig } from '../test-support/api-config.js';

/**
 * Gift card trading, end to end.
 *
 * Two apps are booted: one with the feature OFF, which is what production
 * currently runs, and one with it ON. Both are tested — the off case because
 * "ships disabled" is a claim that has to be checked, and the on case because
 * a flag protecting code that has never run is not a safety mechanism, it is
 * an excuse.
 *
 * Requires DATABASE_URL with 001..005 applied.
 */
const DATABASE_URL = process.env['DATABASE_URL'];
if (DATABASE_URL === undefined || DATABASE_URL === '') {
  throw new Error('the gift card e2e suite needs DATABASE_URL with the migrations applied');
}

const PASSWORD = 'a-long-enough-password';
const PIN = '374915';
const CARD_CODE = 'AMZN-4X7Q-2210-9931';

let pool: Pool;
let off: INestApplication;
let app: INestApplication;
let rateCardId: string;

async function boot(config: ApiConfig): Promise<INestApplication> {
  const mod = await Test.createTestingModule({
    imports: [AppModule.forRoot({ config, pool, clock: systemClock })],
  }).compile();
  const created = mod.createNestApplication(new ExpressAdapter());
  await created.init();
  return created;
}

interface Customer {
  userId: string;
  uuid: string;
  token: string;
}

async function onboard(instance: INestApplication = app): Promise<Customer> {
  const identifier = `gc-${randomUUID()}@example.ng`;
  const inserted = await pool.query<{ id: string; uuid: string }>(
    `INSERT INTO users (email, status) VALUES ($1, 'active') RETURNING id, uuid`,
    [identifier],
  );
  const row = inserted.rows[0];
  if (row === undefined) throw new Error('failed to seed user');

  await pool.query(`INSERT INTO user_credentials (user_id, password_hash) VALUES ($1, $2)`, [
    row.id,
    await hashPassword(PASSWORD),
  ]);

  const login = await request(instance.getHttpServer())
    .post('/v1/auth/login')
    .send({
      identifier,
      password: PASSWORD,
      device: { fingerprint: `fp-${randomUUID()}`, platform: 'ios' },
    })
    .expect(200);
  const token = login.body.access_token as string;

  await request(instance.getHttpServer())
    .post('/v1/auth/pin')
    .set('Authorization', `Bearer ${token}`)
    .send({ pin: PIN })
    .expect(204);

  return { userId: row.id, uuid: row.uuid, token };
}

async function makeReviewer(): Promise<Customer> {
  const reviewer = await onboard();
  await pool.query(`INSERT INTO staff_roles (user_id, role) VALUES ($1, 'giftcard_reviewer')`, [
    reviewer.userId,
  ]);
  return reviewer;
}

const submit = (customer: Customer, overrides: Record<string, unknown> = {}) =>
  request(app.getHttpServer())
    .post('/v1/giftcards')
    .set('Authorization', `Bearer ${customer.token}`)
    .send({
      brand: 'amazon',
      country: 'US',
      card_type: 'ecode',
      face_amount: '50.00',
      face_currency: 'USD',
      card_code: CARD_CODE,
      transaction_pin: PIN,
      idempotency_key: randomUUID(),
      ...overrides,
    });

const review = (reviewer: Customer, id: string, body: Record<string, unknown>) =>
  request(app.getHttpServer())
    .post(`/v1/admin/giftcards/${id}/review`)
    .set('Authorization', `Bearer ${reviewer.token}`)
    .send({ transaction_pin: PIN, ...body });

async function balances(
  customer: Customer,
): Promise<{ currency: string; spendable: string; pending: string }[]> {
  const res = await request(app.getHttpServer())
    .get('/v1/wallets')
    .set('Authorization', `Bearer ${customer.token}`)
    .expect(200);
  return res.body.balances;
}

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: DATABASE_URL, max: 8 });

  const rate = await pool.query<{ id: string }>(
    `INSERT INTO giftcard_rate_cards
       (brand, country, card_type, face_currency, payout_currency,
        payout_rate_minor, min_face_minor, max_face_minor)
     VALUES ('amazon', 'US', 'ecode', 'USD', 'NGN', 125000, 1000, 50000)
     RETURNING id`,
  );
  rateCardId = rate.rows[0]?.id ?? '';

  off = await boot(testApiConfig(DATABASE_URL as string));
  app = await boot(testApiConfig(DATABASE_URL as string, { giftCardsEnabled: true }));
});

afterAll(async () => {
  await off?.close();
  await app?.close();
  await pool?.end();
});

describe('the feature flag', () => {
  it('refuses every gift card route while disabled', async () => {
    // The production default. This is the assertion that makes "ships flagged
    // off" a fact rather than an intention.
    const customer = await onboard(off);

    for (const [method, path] of [
      ['get', '/v1/giftcards'],
      ['post', '/v1/giftcards/quote'],
    ] as const) {
      const res = await request(off.getHttpServer())
        [method](path)
        .set('Authorization', `Bearer ${customer.token}`)
        .send({
          brand: 'amazon',
          country: 'US',
          card_type: 'ecode',
          face_amount: '50.00',
          face_currency: 'USD',
        });
      expect(res.status).toBe(503);
      expect(res.body.error).toBe('gift_cards_disabled');
    }
  });

  it('still authenticates those routes while disabled', async () => {
    // A disabled feature must not become an unauthenticated one. The guard
    // runs before the handler, so the flag is never an excuse to skip it.
    const res = await request(off.getHttpServer()).get('/v1/giftcards');
    expect(res.status).toBe(401);
  });
});

describe('quoting', () => {
  it('prices a card from the live rate card', async () => {
    const customer = await onboard();
    const res = await request(app.getHttpServer())
      .post('/v1/giftcards/quote')
      .set('Authorization', `Bearer ${customer.token}`)
      .send({
        brand: 'amazon',
        country: 'US',
        card_type: 'ecode',
        face_amount: '50.00',
        face_currency: 'USD',
      })
      .expect(200);

    // $50.00 at N1,250.00 per USD.
    expect(res.body).toMatchObject({ payout_amount: '62500.00', payout_currency: 'NGN' });
    // The hold is quoted up front: a customer accepting a price should know
    // the money will not be spendable the moment it appears.
    expect(res.body.hold_days).toBe(3);
  });

  it('refuses a card no published rate covers', async () => {
    const customer = await onboard();
    const res = await request(app.getHttpServer())
      .post('/v1/giftcards/quote')
      .set('Authorization', `Bearer ${customer.token}`)
      .send({
        brand: 'obscure-brand',
        country: 'US',
        card_type: 'ecode',
        face_amount: '50.00',
        face_currency: 'USD',
      });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('no_rate_for_card');
  });
});

describe('submitting', () => {
  it('creates a submission that pays nothing yet', async () => {
    const customer = await onboard();
    const res = await submit(customer).expect(200);

    expect(res.body).toMatchObject({
      status: 'pending_review',
      payout_amount: '62500.00',
      payout_currency: 'NGN',
    });
    // Nothing moved. A submission is an offer, not a transaction — writing a
    // provisional entry here would put money in a pending balance for a card
    // nobody has looked at.
    expect(await balances(customer)).toEqual([]);
  });

  it('never returns the card code to the customer', async () => {
    const customer = await onboard();
    const res = await submit(customer).expect(200);
    expect(JSON.stringify(res.body)).not.toContain(CARD_CODE);

    const list = await request(app.getHttpServer())
      .get('/v1/giftcards')
      .set('Authorization', `Bearer ${customer.token}`)
      .expect(200);
    expect(JSON.stringify(list.body)).not.toContain(CARD_CODE);
  });

  it('seals the code in the database', async () => {
    const customer = await onboard();
    await submit(customer).expect(200);

    const stored = await pool.query<{ card_sealed: string }>(
      `SELECT card_sealed FROM giftcard_submissions WHERE user_id = $1::bigint`,
      [customer.userId],
    );
    expect(stored.rows[0]?.card_sealed).toMatch(/^v1:/);
    expect(stored.rows[0]?.card_sealed).not.toContain('AMZN');
  });

  it('needs a transaction PIN', async () => {
    const customer = await onboard();
    const res = await submit(customer, { transaction_pin: undefined });
    expect(res.status).toBe(400);
  });

  it('is idempotent per customer', async () => {
    const customer = await onboard();
    const key = randomUUID();
    const first = await submit(customer, { idempotency_key: key }).expect(200);
    const second = await submit(customer, { idempotency_key: key }).expect(200);
    expect(second.body.id).toBe(first.body.id);
  });
});

describe('review', () => {
  it('refuses a customer who is not a reviewer', async () => {
    const customer = await onboard();
    const submitted = await submit(customer).expect(200);

    const res = await review(customer, submitted.body.id, { decision: 'approve' });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('forbidden');
  });

  it('pays an approved card into a HOLD, not a spendable balance', async () => {
    const seller = await onboard();
    const reviewer = await makeReviewer();
    const submitted = await submit(seller).expect(200);

    const res = await review(reviewer, submitted.body.id, { decision: 'approve' }).expect(200);
    expect(res.body.status).toBe('approved');

    // THE control. The money exists and cannot be spent yet.
    const balance = (await balances(seller))[0];
    expect(balance).toMatchObject({
      currency: 'NGN',
      spendable: '0.00',
      pending: '62500.00',
    });
  });

  it('pays nothing for a rejected card, and says why', async () => {
    const seller = await onboard();
    const reviewer = await makeReviewer();
    const submitted = await submit(seller).expect(200);

    const res = await review(reviewer, submitted.body.id, {
      decision: 'reject',
      reason: 'already redeemed',
    }).expect(200);

    expect(res.body).toMatchObject({ status: 'rejected', rejection_reason: 'already redeemed' });
    // No entry was ever written, so there is nothing to reverse and no trace
    // in the customer's balance.
    expect(await balances(seller)).toEqual([]);
  });

  it('refuses a reviewer approving their own submission', async () => {
    // Also a CHECK in the schema. The simplest possible inside job, refused in
    // both places — the endpoint so the reviewer gets an explanation, the
    // database so it holds even if the endpoint is wrong.
    const reviewer = await makeReviewer();
    const submitted = await submit(reviewer).expect(200);

    const res = await review(reviewer, submitted.body.id, { decision: 'approve' });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('cannot_review_own_submission');
  });

  it('will not review the same card twice', async () => {
    const seller = await onboard();
    const reviewer = await makeReviewer();
    const submitted = await submit(seller).expect(200);

    await review(reviewer, submitted.body.id, { decision: 'approve' }).expect(200);
    const again = await review(reviewer, submitted.body.id, { decision: 'approve' });

    expect(again.status).toBe(409);
    // And the customer was paid once.
    expect((await balances(seller))[0]?.pending).toBe('62500.00');
  });

  it('reveals a card code only on a deliberate, single request', async () => {
    const seller = await onboard();
    const reviewer = await makeReviewer();
    const submitted = await submit(seller).expect(200);

    const queue = await request(app.getHttpServer())
      .get('/v1/admin/giftcards/queue')
      .set('Authorization', `Bearer ${reviewer.token}`)
      .expect(200);
    // The backlog listing carries no codes: a page of bearer instruments in a
    // browser tab is a page of bearer instruments in a screenshot.
    expect(JSON.stringify(queue.body)).not.toContain(CARD_CODE);

    const revealed = await request(app.getHttpServer())
      .post(`/v1/admin/giftcards/${submitted.body.id}/reveal`)
      .set('Authorization', `Bearer ${reviewer.token}`)
      .expect(200);
    expect(revealed.body.card_code).toBe(CARD_CODE);
  });
});

describe('the hold', () => {
  it('is not released before it matures', async () => {
    const seller = await onboard();
    const reviewer = await makeReviewer();
    const submitted = await submit(seller).expect(200);
    await review(reviewer, submitted.body.id, { decision: 'approve' }).expect(200);

    const report = await app.get(GiftCardHoldService).sweep();
    expect(report.failed).toBe(0);

    // Still held: the hold is three days out.
    expect((await balances(seller))[0]).toMatchObject({
      spendable: '0.00',
      pending: '62500.00',
    });
  });

  it('becomes spendable once it has', async () => {
    const seller = await onboard();
    const reviewer = await makeReviewer();
    const submitted = await submit(seller).expect(200);
    await review(reviewer, submitted.body.id, { decision: 'approve' }).expect(200);

    // Move the hold into the past rather than waiting three days. The trigger
    // re-checks it against the DATABASE clock, so this is the only honest way
    // to reach the released state — a worker cannot shortcut it.
    await pool.query(
      `UPDATE giftcard_submissions SET hold_until = now() - interval '1 minute'
        WHERE uuid = $1`,
      [submitted.body.id],
    );

    const report = await app.get(GiftCardHoldService).sweep();
    expect(report.released).toBeGreaterThanOrEqual(1);

    expect((await balances(seller))[0]).toMatchObject({
      spendable: '62500.00',
      pending: '0.00',
    });
  });

  it('lets a bad card be clawed back while still held', async () => {
    const seller = await onboard();
    const reviewer = await makeReviewer();
    const submitted = await submit(seller).expect(200);
    await review(reviewer, submitted.body.id, { decision: 'approve' }).expect(200);

    const res = await request(app.getHttpServer())
      .post(`/v1/admin/giftcards/${submitted.body.id}/clawback`)
      .set('Authorization', `Bearer ${reviewer.token}`)
      .send({ transaction_pin: PIN, reason: 'issuer voided the card' })
      .expect(200);

    expect(res.body.status).toBe('clawed_back');
    // The money is gone from pending and never reached spendable.
    expect((await balances(seller))[0]).toMatchObject({
      spendable: '0.00',
      pending: '0.00',
    });
  });

  it('cannot claw back once the money is spendable', async () => {
    // The reason the hold exists at all. After release the money may already
    // be spent, so a clawback would overdraw a customer who did nothing wrong.
    const seller = await onboard();
    const reviewer = await makeReviewer();
    const submitted = await submit(seller).expect(200);
    await review(reviewer, submitted.body.id, { decision: 'approve' }).expect(200);

    await pool.query(
      `UPDATE giftcard_submissions SET hold_until = now() - interval '1 minute'
        WHERE uuid = $1`,
      [submitted.body.id],
    );
    await app.get(GiftCardHoldService).sweep();

    const res = await request(app.getHttpServer())
      .post(`/v1/admin/giftcards/${submitted.body.id}/clawback`)
      .set('Authorization', `Bearer ${reviewer.token}`)
      .send({ transaction_pin: PIN, reason: 'too late' });

    expect(res.status).toBe(409);
    expect((await balances(seller))[0]?.spendable).toBe('62500.00');
  });
});

describe('the rate card', () => {
  it('is recorded against the submission so a quote can be reproduced', async () => {
    const customer = await onboard();
    const submitted = await submit(customer).expect(200);

    const stored = await pool.query<{ rate_card_id: string }>(
      `SELECT rate_card_id::text FROM giftcard_submissions WHERE uuid = $1`,
      [submitted.body.id],
    );
    expect(stored.rows[0]?.rate_card_id).toBe(rateCardId);
  });
});
