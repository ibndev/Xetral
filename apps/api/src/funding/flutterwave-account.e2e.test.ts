import 'reflect-metadata';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { ExpressAdapter } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import pg from 'pg';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashPassword, seal } from '@xetral/identity';
import { AppModule } from '../app.module.js';
import { systemClock } from '../tokens.js';
import { testApiConfig } from '../test-support/api-config.js';
import { approveKyc } from '../test-support/kyc-fixture.js';
import { DepositReconciliationService } from './deposit-reconciliation.service.js';
import { ProviderRouterService } from '../routing/provider-router.service.js';

/**
 * A NAIRA ACCOUNT NUMBER ON FLUTTERWAVE, end to end, through the REAL adapter
 * over HTTP to a stub speaking their published v3 protocol.
 *
 * What it pins, each observed at the only place it is observable:
 *   - 076 routes the next naira account to Flutterwave, and the BVN that
 *     reaches their wire is the one sealed at KYC — and none reaches it for an
 *     unverified customer, who is refused before anything is sent;
 *   - a transfer into the account is credited on FLUTTERWAVE'S answer about
 *     their transaction id, not on the unsigned body that announced it;
 *   - the webhook and the sweep derive one key, so either arriving second is
 *     a replay rather than a second credit.
 */
const DATABASE_URL = process.env['DATABASE_URL'];
if (DATABASE_URL === undefined || DATABASE_URL === '') {
  throw new Error('this suite needs DATABASE_URL pointing at a migrated database');
}

const PASSWORD = 'a-long-enough-password';
const HASH = 'flutterwave-hash-for-tests';
const BVN = '22212345678';

let pool: Pool;
let app: INestApplication;
/** ONE config, kept: its keyring is random per call, and the BVN a fixture
 *  seals has to be one this app can open. */
const config = testApiConfig(DATABASE_URL);
let stub: Server;
let routeBefore: string | undefined;

const seen: { method: string; url: string; body: unknown }[] = [];
/** What their API says about each transaction id, and each account's history. */
const transactions = new Map<string, Record<string, unknown>>();

/** Paystack refusing the account, for the one test about what is said then. */
let paystackRefuses = false;

beforeAll(async () => {
  stub = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const url = req.url ?? '';
      seen.push({ method: req.method ?? '', url, body: raw === '' ? undefined : JSON.parse(raw) });
      res.setHeader('content-type', 'application/json');

      /*
       * PAYSTACK, for the account fallback — the rail 079 moves on to when
       * Flutterwave refuses an unverified customer. Served here so no test in
       * this file can reach the real api.paystack.co with a made-up key.
       */
      if (req.method === 'POST' && url === '/customer') {
        res.end(JSON.stringify({ status: true, data: { customer_code: `CUS_${randomUUID().slice(0, 8)}` } }));
        return;
      }
      if (req.method === 'GET' && url.startsWith('/dedicated_account?')) {
        res.end(JSON.stringify({ status: true, data: [] }));
        return;
      }
      if (req.method === 'POST' && url === '/dedicated_account' && paystackRefuses) {
        res.statusCode = 400;
        res.end(JSON.stringify({ status: false, message: 'Dedicated NUBAN is not available for this business' }));
        return;
      }
      if (req.method === 'POST' && url === '/dedicated_account') {
        res.end(
          JSON.stringify({
            status: true,
            data: {
              id: Math.floor(Math.random() * 1e9),
              account_number: String(9_000_000_000 + Math.floor(Math.random() * 999_999_999)),
              account_name: 'XETRAL/ADA OBI',
              bank: { name: 'Test Bank' },
              active: true,
            },
          }),
        );
        return;
      }
      if (req.method === 'POST' && url === '/v3/virtual-account-numbers') {
        res.end(
          JSON.stringify({
            status: 'success',
            message: 'Virtual account created',
            data: {
              order_ref: `URF_${randomUUID()}`,
              flw_ref: 'FLW-x',
              account_number: String(7_000_000_000 + Math.floor(Math.random() * 999_999_999)),
              bank_name: 'WEMA BANK',
            },
          }),
        );
        return;
      }
      const verify = /^\/v3\/transactions\/([^/]+)\/verify$/.exec(url);
      if (verify !== null) {
        const row = transactions.get(decodeURIComponent(verify[1] as string));
        res.end(JSON.stringify(row === undefined ? { status: 'error', message: 'No transaction' } : { status: 'success', data: row }));
        return;
      }
      if (url.startsWith('/v3/transactions?')) {
        // DELIBERATELY IGNORES THE FILTER and returns everything, which is the
        // server the adapter's own re-filter exists for.
        res.end(JSON.stringify({ status: 'success', data: [...transactions.values()] }));
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ status: 'error', message: 'no such endpoint' }));
    });
  });
  await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve));
  const port = (stub.address() as { port: number }).port;

  pool = new pg.Pool({ connectionString: DATABASE_URL, max: 6 });

  // PINNED, and put back afterwards: another suite may have moved it, and
  // this one must not leave the shared database pointing anywhere unusual.
  const before = await pool.query<{ provider: string }>(
    `SELECT provider FROM provider_routes WHERE operation = 'account' AND currency = 'NGN'`,
  );
  routeBefore = before.rows[0]?.provider;
  await pool.query(
    `INSERT INTO provider_routes (operation, currency, provider) VALUES ('account', 'NGN', 'flutterwave')
     ON CONFLICT (operation, currency) DO UPDATE SET provider = 'flutterwave'`,
  );

  const mod = await Test.createTestingModule({
    imports: [
      AppModule.forRoot({
        config: {
          ...config,
          flutterwaveBaseUrl: `http://127.0.0.1:${port}`,
          flutterwaveSecretKey: 'FLWSECK_TEST-not-a-real-key',
          flutterwaveWebhookHash: HASH,
          paystackBaseUrl: `http://127.0.0.1:${port}`,
          paystackSecretKey: 'sk_test_not_a_real_key',
        },
        pool,
        clock: systemClock,
      }),
    ],
  }).compile();
  app = mod.createNestApplication(new ExpressAdapter(), { rawBody: true });
  await app.init();
});

afterAll(async () => {
  if (routeBefore !== undefined) {
    await pool.query(
      `UPDATE provider_routes SET provider = $1 WHERE operation = 'account' AND currency = 'NGN'`,
      [routeBefore],
    );
  }
  await app?.close();
  await pool?.end();
  await new Promise<void>((resolve) => stub.close(() => resolve()));
});

interface Customer {
  readonly userId: string;
  readonly token: string;
}

async function nigerian(verified: boolean): Promise<Customer> {
  const email = `fw-account-${randomUUID()}@example.ng`;
  const inserted = await pool.query<{ id: string }>(
    `INSERT INTO users (email, status, country, full_name) VALUES ($1, 'active', 'NG', 'Ada Obi') RETURNING id`,
    [email],
  );
  const userId = inserted.rows[0]!.id;
  await pool.query(`INSERT INTO user_credentials (user_id, password_hash) VALUES ($1, $2)`, [
    userId,
    await hashPassword(PASSWORD),
  ]);
  if (verified) {
    const keyring = config.encryptionKeyring!;
    await approveKyc(pool, userId, { bvnSealed: seal(BVN, keyring) });
  }
  const login = await request(app.getHttpServer())
    .post('/v1/auth/login')
    .send({
      identifier: email,
      password: PASSWORD,
      device: { fingerprint: `fp-${randomUUID()}`, platform: 'android' },
    })
    .expect(200);
  return { userId, token: login.body.access_token as string };
}

const openAccount = (c: Customer) =>
  request(app.getHttpServer())
    .post('/v1/funding/account')
    .set('Authorization', `Bearer ${c.token}`)
    .send({});

async function reference(userId: string): Promise<string> {
  const row = await pool.query<{ provider: string; provider_customer_ref: string }>(
    `SELECT provider, provider_customer_ref FROM virtual_accounts WHERE user_id = $1::bigint`,
    [userId],
  );
  expect(row.rows[0]?.provider).toBe('flutterwave');
  return row.rows[0]!.provider_customer_ref;
}

async function balance(userId: string, currency = 'NGN'): Promise<bigint> {
  const row = await pool.query<{ balance_minor: string }>(
    `SELECT b.balance_minor FROM accounts a JOIN account_balances b ON b.account_id = a.id
      WHERE a.kind = 'customer_wallet' AND a.owner_id = $1::bigint AND a.currency = $2`,
    [userId, currency],
  );
  return BigInt(row.rows[0]?.balance_minor ?? '0');
}

function webhook(body: Record<string, unknown>, hash = HASH) {
  return request(app.getHttpServer())
    .post('/v1/webhooks/flutterwave/deposits')
    .set('verif-hash', hash)
    .set('content-type', 'application/json')
    .send(JSON.stringify(body));
}

function deposited(id: string, txRef: string, overrides: Record<string, unknown> = {}) {
  transactions.set(id, {
    id: Number(id),
    tx_ref: txRef,
    amount: 5000,
    currency: 'NGN',
    status: 'successful',
    payment_type: 'bank_transfer',
    created_at: new Date().toISOString(),
    meta: { originatorname: 'EMEKA OBI', bankname: 'Kuda' },
    ...overrides,
  });
}

let nextId = 900_000_000 + Math.floor(Math.random() * 90_000_000);
const newId = () => String(nextId++);

async function setFallback(on: boolean): Promise<void> {
  // Through the service, not a raw UPDATE, so its five-second cache is
  // cleared and the next request reads what was just written.
  await app.get(ProviderRouterService).setPolicy({
    mode: 'per_route',
    preferredProvider: null,
    singleProvider: null,
    accountFallback: on,
    byUserUuid: randomUUID(),
  });
}

describe('opening a naira account number on Flutterwave', () => {
  it('with the fallback OFF, refuses an unverified customer with kyc_required and sends Flutterwave nothing', async () => {
    await setFallback(false);
    try {
      const customer = await nigerian(false);
      seen.length = 0;
      const res = await openAccount(customer);
      expect(res.status).toBe(422);
      expect(res.body.error).toBe('kyc_required');
      expect(seen.filter((r) => r.url === '/v3/virtual-account-numbers')).toHaveLength(0);
    } finally {
      await setFallback(true);
    }
  });

  /*
   * THE ACTIVATE ACCOUNT FAULT, as a test. Flutterwave will not open a
   * permanent naira account without a verified BVN, and nothing else was ever
   * asked — so an unverified Nigerian was refused while Paystack, which opens
   * a tier 1 account from a name, sat one row away. With 079's fallback on
   * (as it ships) the refusal moves on, and the account is recorded against
   * the rail that actually opened it.
   */
  it('with the fallback ON, opens an unverified customer an account on the next rail', async () => {
    const customer = await nigerian(false);
    seen.length = 0;
    const res = await openAccount(customer);
    expect(res.status).toBe(200);
    expect(res.body.currency).toBe('NGN');
    expect(seen.filter((r) => r.url === '/v3/virtual-account-numbers')).toHaveLength(0);
    expect(seen.some((r) => r.method === 'POST' && r.url === '/dedicated_account')).toBe(true);

    const row = await pool.query<{ provider: string }>(
      `SELECT provider FROM virtual_accounts WHERE user_id = $1::bigint`,
      [customer.userId],
    );
    expect(row.rows[0]?.provider).toBe('paystack');
  });

  /*
   * NOT A KYC PROMPT ABOUT AN OPERATOR'S PROBLEM. Flutterwave wanted a BVN;
   * Paystack — which needs none — refused for a reason of its own. Telling
   * this customer to verify would send them to do something that changes
   * nothing, and it is the prompt the auto-opened account exists to not show.
   * The refusal relayed is the one somebody can act on.
   */
  it('names the rail that failed for its own reason rather than asking an unverified customer to verify', async () => {
    paystackRefuses = true;
    try {
      const customer = await nigerian(false);
      const res = await openAccount(customer);
      expect(res.body.error).not.toBe('kyc_required');
      expect(res.body.error).toBe('account_issue_refused');
    } finally {
      paystackRefuses = false;
    }
  });

  it('sends the BVN sealed at KYC, and records the reference deposits arrive under', async () => {
    const customer = await nigerian(true);
    seen.length = 0;
    const res = await openAccount(customer);
    expect(res.status).toBe(200);

    const create = seen.find((r) => r.url === '/v3/virtual-account-numbers');
    expect(create?.body).toMatchObject({ bvn: BVN, is_permanent: true, currency: 'NGN' });
    expect(await reference(customer.userId)).toBe(`xetral-va-${customer.userId}-NGN`);
  });
});

describe('money arriving in it', () => {
  it('credits what FLUTTERWAVE says arrived, not what the webhook body claims', async () => {
    const customer = await nigerian(true);
    await openAccount(customer).expect(200);
    const ref = await reference(customer.userId);
    const id = newId();
    deposited(id, ref, { amount: 5000 });

    const before = await balance(customer.userId);
    await webhook({
      event: 'charge.completed',
      data: { id: Number(id), tx_ref: ref, amount: 9_999_999, currency: 'NGN', status: 'successful' },
    }).expect((r) => expect(r.status).toBeLessThan(300));

    expect((await balance(customer.userId)) - before).toBe(500_000n);
    const row = await pool.query<{ status: string; sender_name: string }>(
      `SELECT status, sender_name FROM deposits WHERE provider = 'flutterwave' AND provider_reference = $1`,
      [id],
    );
    expect(row.rows[0]).toEqual({ status: 'credited', sender_name: 'EMEKA OBI' });
  });

  it('credits a redelivered event once', async () => {
    const customer = await nigerian(true);
    await openAccount(customer).expect(200);
    const ref = await reference(customer.userId);
    const id = newId();
    deposited(id, ref);

    const event = { event: 'charge.completed', data: { id: Number(id), tx_ref: ref, status: 'successful' } };
    await webhook(event).expect((r) => expect(r.status).toBeLessThan(300));
    await webhook(event).expect((r) => expect(r.status).toBeLessThan(300));
    expect(await balance(customer.userId)).toBe(500_000n);
  });

  it('holds a cedi amount that landed on a naira account in suspense', async () => {
    const customer = await nigerian(true);
    await openAccount(customer).expect(200);
    const ref = await reference(customer.userId);
    const id = newId();
    deposited(id, ref, { currency: 'GHS', amount: 50 });

    await webhook({
      event: 'charge.completed',
      data: { id: Number(id), tx_ref: ref, status: 'successful' },
    }).expect((r) => expect(r.status).toBeLessThan(300));

    expect(await balance(customer.userId)).toBe(0n);
    const row = await pool.query<{ status: string; suspense_reason: string }>(
      `SELECT status, suspense_reason FROM deposits WHERE provider = 'flutterwave' AND provider_reference = $1`,
      [id],
    );
    expect(row.rows[0]?.status).toBe('suspense');
    expect(row.rows[0]?.suspense_reason).toMatch(/GHS on a NGN account/);
  });

  it('asks them to retry an event their API does not yet call successful', async () => {
    const customer = await nigerian(true);
    await openAccount(customer).expect(200);
    const ref = await reference(customer.userId);
    const id = newId();
    deposited(id, ref, { status: 'pending' });

    const res = await webhook({
      event: 'charge.completed',
      data: { id: Number(id), tx_ref: ref, status: 'successful' },
    });
    // Acknowledging would drop money that is on its way; a non-2xx is what
    // makes Flutterwave deliver it again once it has settled.
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(await balance(customer.userId)).toBe(0n);
  });

  it('refuses an event without the right hash', async () => {
    await webhook({ event: 'charge.completed', data: { id: 1, tx_ref: 'x' } }, 'wrong').expect(401);
  });
});

describe('the sweep, for a webhook that never came', () => {
  it('finds it under the same key, so the late webhook is a replay', async () => {
    const customer = await nigerian(true);
    await openAccount(customer).expect(200);
    const ref = await reference(customer.userId);
    const id = newId();
    deposited(id, ref, { amount: 1234.5 });

    await app.get(DepositReconciliationService).sweep();
    expect(await balance(customer.userId)).toBe(123_450n);

    await webhook({
      event: 'charge.completed',
      data: { id: Number(id), tx_ref: ref, status: 'successful' },
    }).expect((r) => expect(r.status).toBeLessThan(300));
    expect(await balance(customer.userId)).toBe(123_450n);
  });

  it('credits nobody else’s money, even from a server that ignored the filter', async () => {
    // Every transaction above is in the stub's list for EVERY account; each
    // account must be credited only with its own.
    const customer = await nigerian(true);
    await openAccount(customer).expect(200);
    await app.get(DepositReconciliationService).sweep();
    expect(await balance(customer.userId)).toBe(0n);
  });
});
