import { createHmac, randomUUID } from 'node:crypto';
import pg from 'pg';
import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BITNOB_EVENTS } from './events.js';
import { parseWebhook, toLedgerIntent, verifyWebhookSignature } from './webhooks.js';
import type { AccountRef, LedgerIntent } from '@xetral/ledger';

/**
 * The adapter's output against the real ledger schema.
 *
 * Everything else in this package tests the adapter against its own idea of
 * what the ledger accepts. This tests it against the actual tables — which is
 * the only way to catch an `EntryKind` that TypeScript is perfectly happy with
 * and the `entry_kind` enum has never heard of, or an account role that
 * resolves to nothing.
 *
 * It also proves the replay guard end to end, which is the point the provider
 * rules make: the same webhook delivered twice must produce ONE journal entry.
 * Asserting that two calls derive the same idempotency key is not the same
 * claim — the guarantee lives in a UNIQUE constraint, so it has to be tested
 * against one.
 *
 * Requires DATABASE_URL with 001_ledger.sql applied.
 */
const DATABASE_URL = process.env['DATABASE_URL'];
if (DATABASE_URL === undefined || DATABASE_URL === '') {
  throw new Error('the providers e2e suite needs DATABASE_URL with the ledger schema applied');
}

const SECRET = 'whsec_e2e';
let pool: pg.Pool;
let ownerId: string;

/**
 * Resolves an account role to its id, creating it on demand.
 *
 * This is the job the ledger service will own in Phase 4. It lives here as a
 * test helper because the thing under test is whether the adapter's roles
 * CAN be resolved at all — a role naming an account kind the enum does not
 * have fails right here.
 */
async function accountId(client: PoolClient, ref: AccountRef): Promise<string> {
  const owner = 'ownerId' in ref ? ref.ownerId : null;

  const existing = await client.query<{ id: string }>(
    `SELECT id FROM accounts
      WHERE kind = $1::account_kind AND currency = $2
        AND owner_id IS NOT DISTINCT FROM $3::bigint`,
    [ref.kind, ref.currency, owner],
  );
  const found = existing.rows[0];
  if (found !== undefined) return found.id;

  const created = await client.query<{ id: string }>(
    `INSERT INTO accounts (kind, owner_type, owner_id, currency, normal_balance)
     VALUES ($1::account_kind, $2, $3::bigint, $4, $5) RETURNING id`,
    [
      ref.kind,
      owner === null ? null : 'user',
      owner,
      ref.currency,
      ref.kind.startsWith('customer_') ? 'credit' : 'debit',
    ],
  );
  const row = created.rows[0];
  if (row === undefined) throw new Error('account insert returned no row');
  return row.id;
}

/** Writes an intent as a journal entry. Stands in for the Phase 4 ledger
 *  service; deliberately does nothing the adapter could not ask for. */
async function writeIntent(intent: LedgerIntent): Promise<string> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const entry = await client.query<{ id: string }>(
      `INSERT INTO journal_entries (idempotency_key, kind, description, metadata, occurred_at)
       VALUES ($1, $2::entry_kind, $3, $4::jsonb, $5) RETURNING id`,
      [
        intent.idempotencyKey,
        intent.kind,
        intent.description,
        JSON.stringify(intent.metadata),
        intent.occurredAt,
      ],
    );
    const entryId = entry.rows[0]?.id;
    if (entryId === undefined) throw new Error('entry insert returned no row');

    for (const p of intent.postings) {
      await client.query(
        `INSERT INTO postings (journal_entry_id, account_id, amount_minor, currency)
         VALUES ($1, $2, $3, $4)`,
        [entryId, await accountId(client, p.account), p.amountMinor.toString(), p.currency],
      );
    }

    await client.query('COMMIT');
    return entryId;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function balanceOf(ref: AccountRef): Promise<bigint> {
  const client = await pool.connect();
  try {
    const id = await accountId(client, ref);
    const result = await client.query<{ balance_minor: string }>(
      `SELECT balance_minor FROM account_balances WHERE account_id = $1`,
      [id],
    );
    return BigInt(result.rows[0]?.balance_minor ?? '0');
  } finally {
    client.release();
  }
}

function webhook(event: string, eventId: string, amountMicro: string): string {
  return JSON.stringify({
    event_id: eventId,
    event,
    created_at: '2026-08-19T10:30:00.000Z',
    data: {
      id: 'txn_e2e',
      card_id: 'card_e2e',
      customer_id: 'cus_e2e',
      amount: amountMicro,
      currency: 'USD',
      merchant: 'Netflix',
    },
  });
}

/** The whole inbound path: verify, parse, map, write. */
async function deliver(raw: string): Promise<LedgerIntent | undefined> {
  verifyWebhookSignature(
    raw,
    { 'x-bitnob-signature': createHmac('sha256', SECRET).update(raw).digest('hex') },
    { secret: SECRET },
  );
  const intent = toLedgerIntent(parseWebhook(raw), { ownerId });
  if (intent !== undefined) await writeIntent(intent);
  return intent;
}

const wallet = (): AccountRef => ({ kind: 'customer_wallet', ownerId, currency: 'USD' });
const card = (): AccountRef => ({ kind: 'customer_card', ownerId, currency: 'USD' });
const pending = (): AccountRef => ({ kind: 'customer_pending', ownerId, currency: 'USD' });
const float = (): AccountRef => ({ kind: 'provider_float', currency: 'USD' });

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: DATABASE_URL, max: 4 });

  // A high synthetic owner id rather than MAX(owner_id) + 1. accounts.owner_id
  // is polymorphic and unconstrained, but the api suite creates real users from
  // the users sequence against the same database -- and an id chosen just above
  // today's maximum is one the sequence will eventually issue, at which point a
  // real customer inherits this suite's balances.
  ownerId = String(8_000_000_000n + BigInt(Math.floor(Math.random() * 1_000_000)));

  // Load the CARD, not the wallet: an authorization draws on the card's own
  // balance, and the overdraft guard is real, so an authorization against an
  // empty card would be refused by the database rather than by anything this
  // suite is testing.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const entry = await client.query<{ id: string }>(
      `INSERT INTO journal_entries (idempotency_key, kind, occurred_at)
       VALUES ($1, 'wallet_funding', now()) RETURNING id`,
      [`e2e:fund-${randomUUID()}`],
    );
    const entryId = entry.rows[0]?.id;
    for (const [ref, amount] of [
      [card(), '100000'],
      [float(), '-100000'],
    ] as const) {
      await client.query(
        `INSERT INTO postings (journal_entry_id, account_id, amount_minor, currency)
         VALUES ($1, $2, $3, 'USD')`,
        [entryId, await accountId(client, ref), amount],
      );
    }
    await client.query('COMMIT');
  } finally {
    client.release();
  }
});

afterAll(async () => {
  await pool?.end();
});

describe('the two-phase card flow against the real ledger', () => {
  it('authorization moves the card balance into pending, leaving the total alone', async () => {
    const before = { card: await balanceOf(card()), pending: await balanceOf(pending()) };

    await deliver(webhook(BITNOB_EVENTS.cardAuthorization, `evt-auth-${randomUUID()}`, '25000000'));

    const after = { card: await balanceOf(card()), pending: await balanceOf(pending()) };
    expect(after.card).toBe(before.card - 2500n);
    expect(after.pending).toBe(before.pending + 2500n);
    // Committed, not yet spent: card + pending is unchanged.
    expect(after.card + after.pending).toBe(before.card + before.pending);
  });

  it('never touches the wallet on a card event', async () => {
    // The wallet funds the card; it does not back the card's spending. A card
    // event reaching the wallet would mean a ten-dollar card could spend the
    // whole balance.
    const walletBefore = await balanceOf(wallet());
    await deliver(webhook(BITNOB_EVENTS.cardAuthorization, `evt-nw-${randomUUID()}`, '1000000'));
    expect(await balanceOf(wallet())).toBe(walletBefore);
  });

  it('settlement moves pending out to the provider', async () => {
    const beforePending = await balanceOf(pending());
    const beforeFloat = await balanceOf(float());

    await deliver(webhook(BITNOB_EVENTS.cardSettlement, `evt-settle-${randomUUID()}`, '25000000'));

    expect(await balanceOf(pending())).toBe(beforePending - 2500n);
    expect(await balanceOf(float())).toBe(beforeFloat + 2500n);
  });

  it('an expiry returns the hold to the card', async () => {
    await deliver(webhook(BITNOB_EVENTS.cardAuthorization, `evt-auth2-${randomUUID()}`, '10000000'));

    const heldCard = await balanceOf(card());
    const heldPending = await balanceOf(pending());

    await deliver(
      webhook(BITNOB_EVENTS.cardAuthorizationExpired, `evt-exp-${randomUUID()}`, '10000000'),
    );

    expect(await balanceOf(card())).toBe(heldCard + 1000n);
    expect(await balanceOf(pending())).toBe(heldPending - 1000n);
  });
});

describe('replay', () => {
  it('produces exactly one journal entry for a redelivered webhook', async () => {
    // Bitnob retries. The guarantee is the ledger's UNIQUE constraint on
    // idempotency_key, so it is tested against the constraint rather than
    // against the key-derivation function.
    const raw = webhook(BITNOB_EVENTS.cardAuthorization, `evt-replay-${randomUUID()}`, '5000000');

    const intent = await deliver(raw);
    expect(intent).toBeDefined();

    const cardAfterFirst = await balanceOf(card());

    await expect(deliver(raw)).rejects.toMatchObject({ code: '23505' });

    // The balance did not move a second time, which is the thing that actually
    // matters to the customer.
    expect(await balanceOf(card())).toBe(cardAfterFirst);

    const entries = await pool.query(
      `SELECT COUNT(*)::int AS n FROM journal_entries WHERE idempotency_key = $1`,
      [intent?.idempotencyKey],
    );
    expect(entries.rows[0]?.n).toBe(1);
  });

  it('does not confuse a settlement with a replay of its authorization', async () => {
    // Both events describe one card spend but carry different event ids, so
    // both must land. Sharing a key would swallow the settlement and strand
    // the money in pending for ever.
    const suffix = randomUUID();
    await deliver(webhook(BITNOB_EVENTS.cardAuthorization, `evt-a-${suffix}`, '1000000'));
    const settled = await deliver(webhook(BITNOB_EVENTS.cardSettlement, `evt-s-${suffix}`, '1000000'));
    expect(settled).toBeDefined();
  });
});

describe('the ledger still refuses what it always refused', () => {
  it('rejects an entry naming an account kind that does not exist', async () => {
    // The check TypeScript cannot do: EntryKind and AccountRef are literal
    // unions here and enums in the database, and only the database knows if
    // they have drifted apart.
    const client = await pool.connect();
    try {
      await expect(
        accountId(client, { kind: 'not_a_real_kind', currency: 'USD' } as unknown as AccountRef),
      ).rejects.toThrow();
    } finally {
      client.release();
    }
  });

  it('rejects an overdraft even though the adapter produced a balanced entry', async () => {
    // Balanced is not the same as permitted. The card holds far less than this,
    // and the database refuses regardless of how well-formed the entry is.
    const huge = String(50_000n * 1_000_000n);
    await expect(
      deliver(webhook(BITNOB_EVENTS.cardAuthorization, `evt-over-${randomUUID()}`, huge)),
    ).rejects.toThrow(/overdraft/i);
  });

  it('leaves no drift behind', async () => {
    const drift = await pool.query(`SELECT COUNT(*)::int AS n FROM ledger_drift`);
    expect(drift.rows[0]?.n).toBe(0);
  });
});
