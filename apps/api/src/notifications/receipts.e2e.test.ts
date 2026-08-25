import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { ExpressAdapter } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import pg from 'pg';
import type { Pool } from 'pg';
import { open } from '@xetral/identity';
import { LedgerService, posting } from '@xetral/ledger';
import { money } from '@xetral/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../app.module.js';
import { LEDGER, systemClock } from '../tokens.js';
import { testApiConfig } from '../test-support/api-config.js';
import { ALL_NOTIFICATION_KINDS } from './templates.js';

/**
 * Alerts and receipts, over HTTP, against a real database.
 *
 * The claim under test is not "a template renders" — `templates.test.ts`
 * covers that — but that the enqueue actually happens ON the path that moves
 * the money or opens the session, and that it does NOT happen when it should
 * not: no receipt for a replayed transfer, no alert for a device the customer
 * has used before.
 *
 * Everything is asserted against the OUTBOX rather than against a mail
 * provider. The outbox row is the guarantee; what happens after it is the
 * worker's problem and is tested separately.
 */
const DATABASE_URL = process.env['DATABASE_URL'];
if (DATABASE_URL === undefined || DATABASE_URL === '') {
  throw new Error('the receipts e2e suite needs DATABASE_URL with the migrations applied');
}

const PASSWORD = 'a-long-enough-password';
const PIN = '481902';

let pool: Pool;
let app: INestApplication;
let ledger: LedgerService;
let config: ReturnType<typeof testApiConfig>;

interface Customer {
  id: string;
  email: string;
  token: string;
  fingerprint: string;
}

/**
 * A customer created the way a real one is: through the registration
 * endpoint.
 *
 * NOT by inserting a user row and then logging in. That version seeds an
 * account with no devices, so its first login is genuinely a sign-in from an
 * unknown device and correctly raises an alert — which meant the helper
 * manufactured the very thing these tests then measured. The endpoint creates
 * the customer AND their first device together, which is what actually
 * happens.
 */
async function newCustomer(): Promise<Customer> {
  const email = `receipt-${randomUUID()}@example.ng`;
  const fingerprint = `fp-${randomUUID()}`;

  const registered = await request(app.getHttpServer())
    .post('/v1/auth/register')
    .send({ email, password: PASSWORD, device: { fingerprint, platform: 'ios' } })
    .expect(201);

  const row = await pool.query<{ id: string }>(`SELECT id FROM users WHERE email = $1`, [email]);
  const id = row.rows[0]?.id as string;

  const token = registered.body.access_token as string;
  await request(app.getHttpServer())
    .post('/v1/auth/pin')
    .set('Authorization', `Bearer ${token}`)
    .send({ pin: PIN })
    .expect(204);

  return { id, email, token, fingerprint };
}

/** Put money in a wallet the way every other suite does — an ordinary entry. */
async function fund(userId: string, amountKobo: bigint): Promise<void> {
  await ledger.post({
    idempotencyKey: `receipt-fund:${randomUUID()}`,
    kind: 'wallet_funding',
    occurredAt: new Date(),
    description: 'test funding',
    metadata: {},
    postings: [
      posting({ kind: 'provider_float', currency: 'NGN' }, money(-amountKobo, 'NGN')),
      posting({ kind: 'customer_wallet', ownerId: userId, currency: 'NGN' }, money(amountKobo, 'NGN')),
    ],
  });
}

async function queued(userId: string, kind: string): Promise<number> {
  const row = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM notification_outbox
      WHERE user_id = $1::bigint AND kind = $2::notification_kind`,
    [userId, kind],
  );
  return Number(row.rows[0]?.n ?? '0');
}

/** What the customer would actually read. */
async function body(userId: string, kind: string): Promise<string> {
  const row = await pool.query<{ payload_sealed: string }>(
    `SELECT payload_sealed FROM notification_outbox
      WHERE user_id = $1::bigint AND kind = $2::notification_kind
      ORDER BY id DESC LIMIT 1`,
    [userId, kind],
  );
  const sealed = row.rows[0]?.payload_sealed;
  if (sealed === undefined) throw new Error(`no ${kind} message queued`);
  const keyring = config.encryptionKeyring;
  if (keyring === undefined) throw new Error('the fixture has no keyring');
  const rendered = JSON.parse(open(sealed, keyring)) as { subject: string; text: string };
  return `${rendered.subject}\n${rendered.text}`;
}

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: DATABASE_URL, max: 6 });
  config = testApiConfig(DATABASE_URL as string);

  const mod = await Test.createTestingModule({
    imports: [AppModule.forRoot({ config, pool, clock: systemClock })],
  }).compile();
  app = mod.createNestApplication(new ExpressAdapter());
  await app.init();
  ledger = app.get(LEDGER);
});

afterAll(async () => {
  await app?.close();
  await pool?.end();
});

describe('signing in from somewhere new', () => {
  it('alerts on a device the customer has never used', async () => {
    const customer = await newCustomer();
    expect(await queued(customer.id, 'new_device')).toBe(0);

    await request(app.getHttpServer())
      .post('/v1/auth/login')
      .send({
        identifier: customer.email,
        password: PASSWORD,
        device: { fingerprint: `fp-${randomUUID()}`, platform: 'android' },
      })
      .expect(200);

    expect(await queued(customer.id, 'new_device')).toBe(1);
  });

  it('says nothing when the customer signs in again on the SAME device', async () => {
    // The alert has to mean something. One on every login trains customers to
    // ignore the one that matters.
    const customer = await newCustomer();

    for (let i = 0; i < 3; i += 1) {
      await request(app.getHttpServer())
        .post('/v1/auth/login')
        .send({
          identifier: customer.email,
          password: PASSWORD,
          device: { fingerprint: customer.fingerprint, platform: 'ios' },
        })
        .expect(200);
    }

    expect(await queued(customer.id, 'new_device')).toBe(0);
  });

  it('does not alert on the device the account was opened with', async () => {
    // Registration creates the customer's first device. Alerting there would
    // mean every new customer's first email is a security warning about
    // themselves.
    const email = `signup-${randomUUID()}@example.ng`;
    await request(app.getHttpServer())
      .post('/v1/auth/register')
      .send({
        email,
        password: PASSWORD,
        device: { fingerprint: `fp-${randomUUID()}`, platform: 'web' },
      })
      .expect(201);

    const row = await pool.query<{ id: string }>(`SELECT id FROM users WHERE email = $1`, [email]);
    const id = row.rows[0]?.id as string;
    expect(await queued(id, 'new_device')).toBe(0);
  });
});

describe('money leaving a wallet', () => {
  it('queues a receipt for the sender, and only the sender', async () => {
    const sender = await newCustomer();
    const recipient = await newCustomer();
    await fund(sender.id, 500_000n);

    await request(app.getHttpServer())
      .post('/v1/wallets/transfers')
      .set('Authorization', `Bearer ${sender.token}`)
      .send({
        recipient: recipient.email,
        amount: '1000.00',
        currency: 'NGN',
        transaction_pin: PIN,
        idempotency_key: randomUUID(),
      })
      .expect(200);

    expect(await queued(sender.id, 'transfer_sent')).toBe(1);
    // The recipient gets nothing here. A "you have been paid" message is a
    // different decision with a different privacy question attached — it tells
    // one customer's contact list something about another's activity — and it
    // is not this change.
    expect(await queued(recipient.id, 'transfer_sent')).toBe(0);
  });

  it('does NOT queue a second receipt when a transfer is replayed', async () => {
    // The property `onEntry` gives for free: it is not called on a replay. A
    // customer retrying a transfer that timed out must not be told twice that
    // they sent money once.
    const sender = await newCustomer();
    const recipient = await newCustomer();
    await fund(sender.id, 500_000n);

    const key = randomUUID();
    const send = async () =>
      await request(app.getHttpServer())
        .post('/v1/wallets/transfers')
        .set('Authorization', `Bearer ${sender.token}`)
        .send({
          recipient: recipient.email,
          amount: '1000.00',
          currency: 'NGN',
          transaction_pin: PIN,
          idempotency_key: key,
        });

    await send().then((r) => expect(r.status).toBe(200));
    const replay = await send();
    expect(replay.status).toBe(200);
    expect(replay.body.replayed).toBe(true);

    expect(await queued(sender.id, 'transfer_sent')).toBe(1);
  });

  it('does not queue a receipt for a transfer that was refused', async () => {
    // No money moved, so nothing to report. The entry never committed, and the
    // receipt was enqueued on that entry's transaction.
    const sender = await newCustomer();
    const recipient = await newCustomer();

    await request(app.getHttpServer())
      .post('/v1/wallets/transfers')
      .set('Authorization', `Bearer ${sender.token}`)
      .send({
        recipient: recipient.email,
        amount: '1000.00',
        currency: 'NGN',
        transaction_pin: PIN,
        idempotency_key: randomUUID(),
      })
      .expect(422);

    expect(await queued(sender.id, 'transfer_sent')).toBe(0);
  });

  it('reports the amount as a string, never a number', async () => {
    const sender = await newCustomer();
    const recipient = await newCustomer();
    await fund(sender.id, 500_000n);

    await request(app.getHttpServer())
      .post('/v1/wallets/transfers')
      .set('Authorization', `Bearer ${sender.token}`)
      .send({
        recipient: recipient.email,
        amount: '1234.56',
        currency: 'NGN',
        transaction_pin: PIN,
        idempotency_key: randomUUID(),
      })
      .expect(200);

    // The exact digits the customer sees. A float somewhere in this path would
    // show up here as 1234.5599999999999 — which is precisely the number a
    // customer would screenshot and send to support.
    expect(await body(sender.id, 'transfer_sent')).toContain('1,234.56');
  });
});

describe('revoking other devices', () => {
  it('confirms it by email', async () => {
    const customer = await newCustomer();
    await request(app.getHttpServer())
      .post('/v1/auth/login')
      .send({
        identifier: customer.email,
        password: PASSWORD,
        device: { fingerprint: `fp-${randomUUID()}`, platform: 'android' },
      })
      .expect(200);

    await request(app.getHttpServer())
      .post('/v1/auth/devices/revoke-others')
      .set('Authorization', `Bearer ${customer.token}`)
      .send({ transaction_pin: PIN })
      .expect(201);

    expect(await queued(customer.id, 'devices_revoked')).toBe(1);
  });

  it('says nothing when there was nothing to revoke', async () => {
    const customer = await newCustomer();
    await request(app.getHttpServer())
      .post('/v1/auth/devices/revoke-others')
      .set('Authorization', `Bearer ${customer.token}`)
      .send({ transaction_pin: PIN })
      .expect(201);

    expect(await queued(customer.id, 'devices_revoked')).toBe(0);
  });
});

describe('the TypeScript union and the Postgres enum agree', () => {
  it('every declared kind can actually be written', async () => {
    // ONLY AN INSERT PROVES THIS. `NotificationRequest` is a literal union in
    // TypeScript and `notification_kind` is an enum in Postgres; the compiler
    // cannot see the second one, so the two drift silently until something
    // tries to write a row.
    //
    // That is not hypothetical here: `operations_alert` was added to the union
    // and to the templates, passed typecheck and every unit test, and failed
    // on the first real enqueue with "invalid input value for enum". It is the
    // same finding Phase 3 recorded about `EntryKind` and `AccountRef`.
    const kinds = await pool.query<{ label: string }>(
      `SELECT enumlabel AS label FROM pg_enum e
         JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname = 'notification_kind'`,
    );
    const inDatabase = new Set(kinds.rows.map((r) => r.label));

    const missing = ALL_NOTIFICATION_KINDS.filter((kind) => !inDatabase.has(kind));
    expect(
      missing,
      `these kinds exist in TypeScript and would fail on write: ${missing.join(', ')}`,
    ).toEqual([]);
  });
});
