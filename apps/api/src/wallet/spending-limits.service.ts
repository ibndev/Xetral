import { Injectable, UnprocessableEntityException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { Currency, Money } from '@xetral/shared';
import { SettingsService } from '../settings/settings.service.js';
import { Inject } from '@nestjs/common';

/**
 * A daily ceiling on what one customer can move.
 *
 * This is NOT a solvency check, and the distinction matters because the
 * codebase forbids the thing it superficially resembles. A balance must never
 * be pre-checked: the database's overdraft guard is the only correct place for
 * it, and a pre-check is a weaker copy plus a race. A daily limit has no such
 * guard — it is a policy about a rolling total, expressed in a table an
 * operator edits — so there is nothing in the database to defer to, and it has
 * to be computed.
 *
 * Which leaves the race. Two transfers arriving together would each read the
 * day's total, each find room, and each post: the customer sends twice the
 * limit, and the control that exists to cap what a stolen session can move
 * caps nothing at the one moment it is being tested.
 *
 * So the check runs as a `precondition` INSIDE the ledger's own transaction,
 * on the ledger's own connection, holding a transaction advisory lock keyed on
 * the customer. The check and the posting are then one atomic unit and the
 * lock is released by the COMMIT.
 *
 * IT WAS NOT ALWAYS SHAPED THIS WAY, and the first shape is worth recording:
 * it opened its own transaction on its own pool connection and called the
 * ledger from inside. That works until `pool.max` customers transfer at once,
 * at which point every connection is held by a limit check waiting for a
 * connection the ledger will never get, and the API stops answering. A test
 * with ten concurrent callers against a pool of eight found it; nothing else
 * would have, until production.
 *
 * The cost that remains is real and is worth naming: one customer's concurrent
 * transfers queue behind each other. That is the correct trade — a customer
 * sending two transfers at the same instant is rare, and a stolen session
 * sending forty is exactly what this is for.
 */

export type LimitScope = 'transfer' | 'purchase';

/**
 * What counts toward each limit.
 *
 * Entry kinds rather than a single "spend" flag, so adding a money flow later
 * is a decision made here in the open rather than a silent inheritance. A new
 * kind counts toward nothing until it is written down, which is the safe
 * default for a limit: an uncounted flow lets money out, so its absence must
 * be visible rather than assumed.
 */
const COUNTED: Readonly<Record<LimitScope, readonly string[]>> = {
  transfer: ['wallet_transfer', 'wallet_withdrawal'],
  purchase: ['bill_payment', 'esim_purchase', 'number_purchase'],
};

/**
 * The limits are published in KOBO, so they are a statement about naira and
 * about nothing else.
 *
 * A ceiling of 500,000,000 kobo says nothing whatever about how many USDT a
 * customer may send, and applying the number to another currency because both
 * are integers is the same class of mistake as adding kobo to cents. Other
 * currencies are therefore uncapped here — deliberately, and stated, rather
 * than capped by an accident of units.
 */
const LIMITED_CURRENCY = 'NGN';

/** Distinct lock spaces per scope, so the two limits do not contend. */
const SCOPE_LOCK_KEY: Readonly<Record<LimitScope, number>> = {
  transfer: 0x7845_7401,
  purchase: 0x7845_7402,
};

/**
 * Generic over its currency, and it has to be.
 *
 * `Money` is declared `in out`, so a bare `Money` field means
 * `Money<Currency>` — the UNION of every currency — and `Money<'NGN'>` is not
 * assignable to it. A caller holding real naira would be rejected by a type
 * that reads as though it accepts any money at all. CLAUDE.md records this
 * rule and Phase 10 walked into it anyway; so did this file.
 */
export interface LimitCheck<C extends Currency> {
  readonly userId: string;
  readonly scope: LimitScope;
  readonly amount: Money<C>;
  /**
   * The ledger key this entry will be posted under.
   *
   * Required, because without it the limit breaks retries. A customer near
   * their ceiling whose request times out sends the same request again; the
   * first one had already posted, so its amount is already in today's total,
   * and re-checking would refuse the retry while the money has in fact moved.
   * The customer is then told they hit a limit for a transfer that succeeded,
   * which invites them to send it again tomorrow.
   *
   * A key the ledger has already accepted is therefore a replay, and a replay
   * moves nothing and is not checked. The read happens inside the ledger's own
   * transaction, so it cannot race the posting it is asking about.
   */
  readonly idempotencyKey: string;
}

@Injectable()
export class SpendingLimitService {
  constructor(@Inject(SettingsService) private readonly settings: SettingsService) {}

  /**
   * Builds the precondition to hand to `LedgerService.post`.
   *
   * Returns `undefined` when there is nothing to enforce, so the caller passes
   * no precondition at all rather than one that does nothing — a hook that
   * always runs and sometimes decides not to is a hook somebody later adds a
   * side effect to.
   */
  async precondition<C extends Currency>(
    check: LimitCheck<C>,
  ): Promise<((client: PoolClient) => Promise<void>) | undefined> {
    if (check.amount.currency !== LIMITED_CURRENCY) return undefined;

    // Read OUTSIDE the transaction, deliberately. It is a cached settings
    // lookup that may itself hit the database, and doing it while holding the
    // ledger's transaction open would lengthen every transfer's transaction
    // for a value that changes a few times a year.
    const limit =
      check.scope === 'transfer'
        ? await this.settings.transferDailyLimitKobo()
        : await this.settings.purchaseDailyLimitKobo();

    return async (client: PoolClient): Promise<void> => {
      await client.query(`SELECT pg_advisory_xact_lock($1::int, $2::int)`, [
        SCOPE_LOCK_KEY[check.scope],
        // The lock space is 32-bit and user ids are BIGINT. A collision costs
        // two unrelated customers a little contention and nothing else — the
        // lock is not what makes the sum correct, only what makes it stable
        // while it is read.
        Number(BigInt(check.userId) % 2147483647n),
      ]);

      if (await alreadyPosted(client, check.idempotencyKey)) return;

      const spent = await spentToday(client, check.userId, check.scope);
      if (spent + check.amount.amount > limit) {
        // 422 and no figure, for the same reason `InsufficientFundsError`
        // carries none: "₦412,000 of your ₦5,000,000 left today" is a report on
        // the customer's activity, and a stolen session must not be able to
        // farm one out of an error body.
        throw new UnprocessableEntityException({ error: 'daily_limit_exceeded' });
      }
    };
  }
}

/** Has the ledger already accepted this key? Then the money moved, the total
 *  already includes it, and this call is a redelivery rather than a new
 *  spend. */
async function alreadyPosted(client: PoolClient, key: string): Promise<boolean> {
  const found = await client.query(`SELECT 1 FROM journal_entries WHERE idempotency_key = $1`, [
    key,
  ]);
  return found.rowCount !== null && found.rowCount > 0;
}

/**
 * What this customer has already moved today, in minor units.
 *
 * Read from POSTINGS, not from a counter. A counter is a second record of the
 * same facts and drifts the first time a flow forgets to increment it; the
 * postings are what actually happened, and a limit computed from them cannot
 * disagree with the ledger.
 *
 * "Today" is a Lagos day. The customers are Nigerian and their day ends at
 * midnight where they are — a UTC boundary would reset the limit at 1am local,
 * which is both surprising to them and an hour a fraudster would learn.
 */
async function spentToday(
  client: PoolClient,
  userId: string,
  scope: LimitScope,
): Promise<bigint> {
  const result = await client.query<{ spent: string }>(
    `SELECT COALESCE(-SUM(p.amount_minor), 0)::text AS spent
       FROM postings p
       JOIN accounts a        ON a.id = p.account_id
       JOIN journal_entries e ON e.id = p.journal_entry_id
      WHERE a.kind       = 'customer_wallet'
        AND a.owner_type = 'user'
        AND a.owner_id   = $1::bigint
        AND a.currency   = $2
        AND p.amount_minor < 0
        AND e.kind::text  = ANY($3::text[])
        AND p.created_at >=
            (date_trunc('day', now() AT TIME ZONE 'Africa/Lagos')
               AT TIME ZONE 'Africa/Lagos')`,
    [userId, LIMITED_CURRENCY, COUNTED[scope]],
  );
  return BigInt(result.rows[0]?.spent ?? '0');
}
