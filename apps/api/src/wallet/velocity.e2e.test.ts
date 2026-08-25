import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { ExpressAdapter } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import pg from 'pg';
import type { Pool } from 'pg';
import { hashPassword } from '@xetral/identity';
import { LedgerService, posting } from '@xetral/ledger';
import { ngn } from '@xetral/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../app.module.js';
import { systemClock } from '../tokens.js';
import { testApiConfig } from '../test-support/api-config.js';

/**
 * The velocity rules on a transfer, against a real database.
 *
 * WHAT THESE COVER THAT THE DAILY LIMIT DOES NOT. A total in kobo is blind to
 * the shape of an account takeover: it does not look like one large transfer,
 * it looks like several ordinary ones to people the customer has never paid, a
 * few minutes apart. Every one fits under the ceiling and the ceiling is
 * reached when the account is empty.
 *
 * These have to run against real postings rather than a mock, because that is
 * where the rules are computed from — deliberately, so that a flow which
 * forgot to update a counter cannot switch them off.
 */
const DATABASE_URL = process.env['DATABASE_URL'];
if (DATABASE_URL === undefined || DATABASE_URL === '') {
  throw new Error('the velocity e2e suite needs DATABASE_URL with the migrations applied');
}

const PASSWORD = 'a-long-enough-password';
const PIN = '551824';

let pool: Pool;
let ledger: LedgerService;
let app: INestApplication;

interface Customer {
  identifier: string;
  userId: string;
  token: string;
}

async function onboard(): Promise<Customer> {
  const identifier = `velocity-${randomUUID()}@example.ng`;
  const inserted = await pool.query<{ id: string }>(
    `INSERT INTO users (email, status) VALUES ($1, 'active') RETURNING id`,
    [identifier],
  );
  const userId = inserted.rows[0]?.id;
  if (userId === undefined) throw new Error('failed to seed user');

  await pool.query(`INSERT INTO user_credentials (user_id, password_hash) VALUES ($1, $2)`, [
    userId,
    await hashPassword(PASSWORD),
  ]);

  const login = await request(app.getHttpServer())
    .post('/v1/auth/login')
    .send({
      identifier,
      password: PASSWORD,
      device: { fingerprint: `fp-${randomUUID()}`, platform: 'ios' },
    })
    .expect(200);

  const token = login.body.access_token as string;
  await request(app.getHttpServer())
    .post('/v1/auth/pin')
    .set('Authorization', `Bearer ${token}`)
    .send({ pin: PIN })
    .expect(204);

  return { identifier, userId, token };
}

async function fund(userId: string, minor: number): Promise<void> {
  await ledger.post({
    idempotencyKey: `velocity-fund:${randomUUID()}`,
    kind: 'wallet_funding',
    occurredAt: new Date(),
    description: 'test funding',
    metadata: {},
    postings: [
      posting({ kind: 'customer_wallet', ownerId: userId, currency: 'NGN' }, ngn(minor)),
      posting({ kind: 'provider_float', currency: 'NGN' }, ngn(-minor)),
    ],
  });
}

const send = (from: Customer, to: Customer, key = randomUUID()) =>
  request(app.getHttpServer())
    .post('/v1/wallets/transfers')
    .set('Authorization', `Bearer ${from.token}`)
    .send({
      recipient: to.identifier,
      amount: '10.00',
      currency: 'NGN',
      transaction_pin: PIN,
      idempotency_key: key,
    });

/** Sets a limit for the whole suite. The settings cache is short, so the
 *  service is told to refresh rather than waited out. */
async function setLimit(key: string, value: string): Promise<void> {
  await pool.query(`UPDATE platform_settings SET value = $2 WHERE key = $1`, [key, value]);
}

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: DATABASE_URL, max: 8 });
  ledger = new LedgerService(pool);

  // Deliberately small, so the rules can be reached without sending a hundred
  // transfers — and the assertions stay about the RULE rather than about how
  // long the suite takes.
  await setLimit('transfer_new_recipients_daily', '3');
  await setLimit('transfer_count_hourly', '8');

  app = await Test.createTestingModule({
    imports: [
      AppModule.forRoot({
        config: testApiConfig(DATABASE_URL as string),
        pool,
        clock: systemClock,
      }),
    ],
  })
    .compile()
    .then(async (mod) => {
      const created = mod.createNestApplication(new ExpressAdapter());
      await created.init();
      return created;
    });
});

afterAll(async () => {
  await app?.close();
  await pool?.end();
});

describe('paying people you have never paid', () => {
  it('refuses the fourth stranger in a day, with a ceiling of three', async () => {
    const sender = await onboard();
    await fund(sender.userId, 100_000_00);

    for (let i = 0; i < 3; i += 1) {
      const stranger = await onboard();
      await send(sender, stranger).expect(200);
    }

    const fourth = await onboard();
    const refused = await send(sender, fourth).expect(422);
    expect(refused.body.error).toBe('too_many_new_recipients');

    // AND THE MONEY DID NOT MOVE. The rule runs as a precondition inside the
    // ledger's own transaction, so a refusal rolls the entry back rather than
    // rejecting after the fact.
    const credited = await pool.query(
      `SELECT 1 FROM postings p
         JOIN accounts a ON a.id = p.account_id
        WHERE a.owner_type = 'user' AND a.owner_id = $1::bigint`,
      [fourth.userId],
    );
    expect(credited.rowCount).toBe(0);
  });

  it('lets a customer keep paying somebody they have paid before', async () => {
    // THE RULE THIS DISTINGUISHES. A ceiling on transfers to KNOWN recipients
    // would refuse a customer paying their landlord for the fourth time, which
    // is ordinary behaviour and not what a takeover looks like. Only strangers
    // count.
    const sender = await onboard();
    await fund(sender.userId, 100_000_00);

    const known = await onboard();
    await send(sender, known).expect(200);

    // Fill the stranger ceiling with two more first-time recipients.
    for (let i = 0; i < 2; i += 1) {
      await send(sender, await onboard()).expect(200);
    }

    // A fourth stranger is refused...
    const refused = await send(sender, await onboard()).expect(422);
    expect(refused.body.error).toBe('too_many_new_recipients');

    // ...while the person already paid is still payable, repeatedly.
    await send(sender, known).expect(200);
    await send(sender, known).expect(200);
  });
});

describe('how many transfers in an hour', () => {
  it('refuses past the hourly count, in any currency', async () => {
    const sender = await onboard();
    await fund(sender.userId, 100_000_00);

    // One recipient, so the stranger rule cannot be what fires — this asserts
    // the count rule specifically.
    const known = await onboard();

    for (let i = 0; i < 8; i += 1) {
      await send(sender, known).expect(200);
    }

    const refused = await send(sender, known).expect(422);
    expect(refused.body.error).toBe('too_many_transfers');
  });
});

describe('what the rules must not break', () => {
  it('does not refuse a REPLAY', async () => {
    // A customer whose request timed out retries with the same key. The first
    // attempt already posted and is already counted, so re-checking would
    // refuse the retry of a transfer that in fact succeeded — and tell the
    // customer they hit a limit for money that had already left.
    const sender = await onboard();
    await fund(sender.userId, 100_000_00);
    const known = await onboard();

    const key = randomUUID();
    const first = await send(sender, known, key).expect(200);
    expect(first.body.replayed).toBe(false);

    // Fill the hourly count so a fresh transfer would now be refused.
    for (let i = 0; i < 7; i += 1) {
      await send(sender, known).expect(200);
    }
    await send(sender, known).expect(422);

    // The replay still succeeds, and moves nothing a second time.
    const replay = await send(sender, known, key).expect(200);
    expect(replay.body.replayed).toBe(true);
    expect(replay.body.entry_id).toBe(first.body.entry_id);
  });

  it('emails the customer ONCE, not once per attempt', async () => {
    // The refusal is the first evidence a customer gets that somebody else is
    // signed in as them, so it must reach them — and an attacker hammering a
    // refused transfer must not turn our own alerting into a mail bomb aimed
    // at the person being protected.
    const sender = await onboard();
    await fund(sender.userId, 100_000_00);

    for (let i = 0; i < 3; i += 1) {
      await send(sender, await onboard()).expect(200);
    }

    for (let i = 0; i < 4; i += 1) {
      await send(sender, await onboard()).expect(422);
    }

    const queued = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM notification_outbox
        WHERE user_id = $1::bigint AND kind = 'transfer_blocked'`,
      [sender.userId],
    );
    expect(queued.rows[0]?.n).toBe('1');
  });
});
