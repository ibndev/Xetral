import type { Pool, PoolClient } from 'pg';
import { assertBalanced } from './intent.js';
import type { AccountRef, LedgerIntent } from './intent.js';
import { InsufficientFundsError, InvalidEntryError, UnknownAccountError } from './errors.js';

/**
 * The only thing in this platform that writes postings.
 *
 * Rule 1 says every other module requests a journal entry and receives an id.
 * That rule buys the whole audit story, and it is the one under pressure from
 * every deadline — the shortcut is always four lines of INSERT in whichever
 * service is being written today. There is nothing clever here to justify the
 * indirection; the point is that there is exactly ONE place where the
 * invariants are known, so there is exactly one place to check when they are
 * in doubt.
 */

export interface PostedEntry {
  readonly entryId: string;
  readonly entryUuid: string;
  /**
   * True when this idempotency key had already been posted and the existing
   * entry was returned instead of a new one.
   *
   * A replay is a SUCCESS, not an error. A webhook handler that treats the
   * second delivery as a failure will keep failing, and the provider will keep
   * retrying, for ever. The caller usually does not care which it was — but a
   * reconciliation job does, so the flag is here rather than swallowed.
   */
  readonly replayed: boolean;
}

export interface AccountBalance {
  readonly accountId: string;
  readonly kind: AccountRef['kind'];
  readonly currency: string;
  readonly balanceMinor: bigint;
}

export interface WalletBalance {
  readonly currency: string;
  /** What the customer can spend right now. */
  readonly spendableMinor: bigint;
  /** Authorised but not yet settled — money committed and not yet gone. */
  readonly pendingMinor: bigint;
  /** spendable + pending. What the customer thinks of as "my money". */
  readonly totalMinor: bigint;
}

export interface HistoryEntry {
  /**
   * The cursor for the next page — pass it back as `before`.
   *
   * Exposed deliberately rather than left as an internal detail: without it a
   * caller cannot paginate at all, and would be pushed toward OFFSET, which is
   * the thing keyset pagination is here to avoid.
   */
  readonly postingId: string;
  readonly entryUuid: string;
  readonly kind: string;
  readonly description: string;
  readonly amountMinor: bigint;
  readonly currency: string;
  readonly occurredAt: Date;
}

/** Postgres SQLSTATEs this service translates rather than leaks. */
const UNIQUE_VIOLATION = '23505';
const CHECK_VIOLATION = '23514';
const RAISE_EXCEPTION = 'P0001';

function sqlState(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code: unknown }).code)
    : undefined;
}

export class LedgerService {
  constructor(private readonly pool: Pool) {}

  /**
   * Writes an entry, or returns the one already written under this key.
   *
   * Everything happens in ONE transaction, so the deferred balance constraint
   * fires at COMMIT with all the postings present. Splitting the postings
   * across transactions would trip it on the first one.
   */
  async post(intent: LedgerIntent): Promise<PostedEntry> {
    // Checked here as well as by the database. The database is the authority
    // and stays so, but its check is deferred to COMMIT, by which point the
    // error is a transaction abort several layers from whoever built the bad
    // entry. This one names the entry while that is still in hand.
    assertBalanced(intent);

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const entry = await client.query<{ id: string; uuid: string }>(
        `INSERT INTO journal_entries (idempotency_key, kind, description, metadata, occurred_at)
         VALUES ($1, $2::entry_kind, $3, $4::jsonb, $5)
         RETURNING id, uuid`,
        [
          intent.idempotencyKey,
          intent.kind,
          intent.description,
          JSON.stringify(intent.metadata),
          intent.occurredAt,
        ],
      );

      const row = entry.rows[0];
      if (row === undefined) throw new InvalidEntryError('journal entry insert returned no row');

      for (const p of intent.postings) {
        await client.query(
          `INSERT INTO postings (journal_entry_id, account_id, amount_minor, currency)
           VALUES ($1, $2, $3, $4)`,
          [
            row.id,
            await this.#resolveAccount(client, p.account),
            // Sent as a string. node-postgres would render a bigint through
            // JSON otherwise, and a value past 2^53 does not survive that.
            p.amountMinor.toString(),
            p.currency,
          ],
        );
      }

      await client.query('COMMIT');
      return { entryId: row.id, entryUuid: row.uuid, replayed: false };
    } catch (error) {
      await client.query('ROLLBACK');

      if (sqlState(error) === UNIQUE_VIOLATION) {
        // The replay guard fired. Somebody else already posted this exact
        // business event, which is the constraint doing its job rather than a
        // failure — hand back what is already there.
        const existing = await this.#findByIdempotencyKey(intent.idempotencyKey);
        if (existing !== undefined) return existing;
      }

      throw this.#translate(error);
    } finally {
      client.release();
    }
  }

  /**
   * Resolves an account role to its id, creating the account if it does not
   * exist yet.
   *
   * Creating on demand is safe because of the two partial unique indexes in
   * 001_ledger.sql: a customer gets at most one account per (kind, currency),
   * and a platform account at most one per (kind, currency) with a NULL owner.
   * Two concurrent first-postings therefore race into the same constraint and
   * one loses, which is why the loser re-reads rather than failing.
   */
  async #resolveAccount(client: PoolClient, ref: AccountRef): Promise<string> {
    const owner = 'ownerId' in ref ? ref.ownerId : null;

    const found = await client.query<{ id: string }>(
      `SELECT id FROM accounts
        WHERE kind = $1::account_kind AND currency = $2
          AND owner_id IS NOT DISTINCT FROM $3::bigint`,
      [ref.kind, ref.currency, owner],
    );
    const existing = found.rows[0];
    if (existing !== undefined) return existing.id;

    try {
      const created = await client.query<{ id: string }>(
        `INSERT INTO accounts (kind, owner_type, owner_id, currency, normal_balance)
         VALUES ($1::account_kind, $2, $3::bigint, $4, $5)
         RETURNING id`,
        [
          ref.kind,
          owner === null ? null : 'user',
          owner,
          ref.currency,
          normalBalanceFor(ref.kind),
        ],
      );
      const row = created.rows[0];
      if (row === undefined) throw new UnknownAccountError('account insert returned no row');
      return row.id;
    } catch (error) {
      if (sqlState(error) !== UNIQUE_VIOLATION) throw error;

      // Lost the race. The winner's row is the one both of us wanted.
      const raced = await client.query<{ id: string }>(
        `SELECT id FROM accounts
          WHERE kind = $1::account_kind AND currency = $2
            AND owner_id IS NOT DISTINCT FROM $3::bigint`,
        [ref.kind, ref.currency, owner],
      );
      const row = raced.rows[0];
      if (row === undefined) {
        throw new UnknownAccountError(
          `could not resolve ${ref.kind}/${ref.currency} after a unique violation`,
        );
      }
      return row.id;
    }
  }

  async #findByIdempotencyKey(key: string): Promise<PostedEntry | undefined> {
    const result = await this.pool.query<{ id: string; uuid: string }>(
      `SELECT id, uuid FROM journal_entries WHERE idempotency_key = $1`,
      [key],
    );
    const row = result.rows[0];
    return row === undefined
      ? undefined
      : { entryId: row.id, entryUuid: row.uuid, replayed: true };
  }

  /** Turns a database rejection into something a caller can act on. */
  #translate(error: unknown): unknown {
    const state = sqlState(error);
    const message = error instanceof Error ? error.message : String(error);

    if (state === CHECK_VIOLATION && /overdraft/i.test(message)) {
      return new InsufficientFundsError('insufficient funds', { cause: error });
    }
    if (state === CHECK_VIOLATION || state === RAISE_EXCEPTION) {
      return new InvalidEntryError(message, { cause: error });
    }
    return error;
  }

  /**
   * A customer's spendable and pending balance per currency.
   *
   * Both come from `account_balances`, which is maintained by trigger from the
   * postings — so this is a read of derived data whose source of truth is the
   * postings themselves, and `ledger_drift` exists to prove the two agree.
   */
  async walletBalances(ownerId: string): Promise<readonly WalletBalance[]> {
    const result = await this.pool.query<{
      currency: string;
      spendable: string;
      pending: string;
    }>(
      `SELECT a.currency,
              COALESCE(SUM(b.balance_minor) FILTER (WHERE a.kind = 'customer_wallet'), 0)::text
                AS spendable,
              COALESCE(SUM(b.balance_minor) FILTER (WHERE a.kind = 'customer_pending'), 0)::text
                AS pending
         FROM accounts a
         JOIN account_balances b ON b.account_id = a.id
        WHERE a.owner_id = $1::bigint
          AND a.kind IN ('customer_wallet', 'customer_pending')
        GROUP BY a.currency
        ORDER BY a.currency`,
      [ownerId],
    );

    return result.rows.map((row) => {
      const spendable = BigInt(row.spendable);
      const pending = BigInt(row.pending);
      return {
        currency: row.currency,
        spendableMinor: spendable,
        pendingMinor: pending,
        totalMinor: spendable + pending,
      };
    });
  }

  async balanceOf(ref: AccountRef): Promise<AccountBalance | undefined> {
    const owner = 'ownerId' in ref ? ref.ownerId : null;
    const result = await this.pool.query<{
      account_id: string;
      kind: AccountRef['kind'];
      currency: string;
      balance_minor: string;
    }>(
      `SELECT b.account_id, a.kind, a.currency, b.balance_minor
         FROM account_balances b
         JOIN accounts a ON a.id = b.account_id
        WHERE a.kind = $1::account_kind AND a.currency = $2
          AND a.owner_id IS NOT DISTINCT FROM $3::bigint`,
      [ref.kind, ref.currency, owner],
    );
    const row = result.rows[0];
    return row === undefined
      ? undefined
      : {
          accountId: row.account_id,
          kind: row.kind,
          currency: row.currency,
          balanceMinor: BigInt(row.balance_minor),
        };
  }

  /**
   * A customer's transaction history for one currency, newest first.
   *
   * Reads `postings` rather than `journal_entries`, because the customer's view
   * of an entry is their own leg of it: a transfer is +₦5,000 to the recipient
   * and -₦5,050 to the sender, and neither of them wants to see the other's
   * side or the fee leg.
   *
   * Keyset pagination on the posting id rather than OFFSET. An offset walks
   * rows the customer already saw and shifts under them whenever a new entry
   * lands, which on an active account means duplicates and gaps.
   */
  async history(
    ownerId: string,
    currency: string,
    options: { readonly limit?: number; readonly before?: string } = {},
  ): Promise<readonly HistoryEntry[]> {
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);

    const result = await this.pool.query<{
      posting_id: string;
      uuid: string;
      kind: string;
      description: string;
      amount_minor: string;
      currency: string;
      occurred_at: Date;
    }>(
      `SELECT p.id AS posting_id, e.uuid, e.kind, e.description,
              p.amount_minor, p.currency, e.occurred_at
         FROM postings p
         JOIN accounts a        ON a.id = p.account_id
         JOIN journal_entries e ON e.id = p.journal_entry_id
        WHERE a.owner_id = $1::bigint
          AND a.kind = 'customer_wallet'
          AND p.currency = $2
          AND ($3::bigint IS NULL OR p.id < $3::bigint)
        ORDER BY p.id DESC
        LIMIT $4`,
      [ownerId, currency, options.before ?? null, limit],
    );

    return result.rows.map((row) => ({
      entryUuid: row.uuid,
      kind: row.kind,
      description: row.description,
      amountMinor: BigInt(row.amount_minor),
      currency: row.currency,
      occurredAt: row.occurred_at,
      postingId: row.posting_id,
    }));
  }
}

/**
 * Which direction increases an account.
 *
 * Assets and expenses are debit-normal; liabilities, equity and revenue are
 * credit-normal. Stored on the row so reporting never special-cases by kind,
 * and so a new kind cannot quietly inherit the wrong sign.
 */
function normalBalanceFor(kind: AccountRef['kind']): 'debit' | 'credit' {
  switch (kind) {
    case 'customer_wallet':
    case 'customer_card':
    case 'customer_pending':
    case 'liability_customer_funds':
    case 'revenue_fees':
    case 'revenue_fx_spread':
      return 'credit';
    case 'provider_float':
    case 'expense_provider_cost':
    case 'suspense':
      return 'debit';
  }
}
