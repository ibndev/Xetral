import { Injectable, UnprocessableEntityException } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import type { Currency, Money } from '@xetral/shared';
import { SettingsService } from '../settings/settings.service.js';
import { DATABASE } from '../tokens.js';
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

export type LimitScope =
  | 'transfer'
  | 'purchase'
  /* The only money movement here that nobody can recall once it has left. */
  | 'crypto_withdrawal'
  | 'fx'
  | 'giftcard';

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
  crypto_withdrawal: ['crypto_withdrawal'],
  fx: ['fx_trade'],
  giftcard: ['giftcard_purchase'],
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
  crypto_withdrawal: 0x7845_7403,
  fx: 0x7845_7404,
  giftcard: 0x7845_7405,
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
  /**
   * Who is being paid, for the velocity rules. Absent for a purchase, which
   * has no recipient customer — a bill goes to a provider float.
   *
   * Not read from the intent's metadata, deliberately. The velocity rules are
   * computed from POSTINGS for the same reason `spentToday` is: metadata is a
   * blob our own code fills in, and a control that depends on a key some flow
   * remembered to set is a control that switches itself off silently. This is
   * the one value the caller must state, and the query verifies everything
   * else against the money that actually moved.
   */
  readonly recipientId?: string;
}

@Injectable()
export class SpendingLimitService {
  constructor(
    @Inject(SettingsService) private readonly settings: SettingsService,
    // Its own pool, used OUTSIDE the ledger's transaction. The tier lookup
    // happens with `precondition` being built, not while it runs — taking a
    // second connection inside the entry's transaction is the deadlock this
    // service's header records, and it must not be reintroduced by a lookup
    // that looks harmless.
    @Inject(DATABASE) private readonly pool: Pool,
  ) {}

  /**
   * Builds the precondition to hand to `LedgerService.post`.
   *
   * Returns `undefined` when there is nothing to enforce, so the caller passes
   * no precondition at all rather than one that does nothing — a hook that
   * always runs and sometimes decides not to is a hook somebody later adds a
   * side effect to.
   */
  /**
   * The daily AMOUNT ceiling for this check, or undefined when there is none.
   *
   * TWO DIFFERENT UNIT SYSTEMS MEET HERE, and keeping them apart is the whole
   * job. The fiat ceilings are published in KOBO, so they are statements about
   * naira and are skipped in any other currency — applying a kobo number to
   * USDT because both are integers is the kobo-plus-cents mistake.
   *
   * A crypto ceiling is stated PER ASSET in that asset's own minor units,
   * because there is no such thing as a currency-agnostic amount: 1,000,000 is
   * one USDT and one hundredth of a BTC. An asset with no configured row has
   * NO amount ceiling and is capped by the hourly count alone — deliberately,
   * because a limit nobody configured must not refuse every withdrawal, and
   * must not silently pretend to cap one either.
   */
  /**
   * The ceiling for this movement, which is the LOWER of two different claims.
   *
   * The TIER limit says what this customer may move, given what we know about
   * them. It is per currency and it exists for every tier and every currency
   * the ledger holds — `kyc_tier_coverage` and the invariant suite make sure of
   * that, because the alternative is a fallback and a fallback here means an
   * unverified account is silently unlimited in some currency.
   *
   * The FLOW limit says what anybody may move through this particular flow in a
   * day, whoever they are. It is what an operator narrows during an incident,
   * and it must keep working while they do — so a tier limit does not replace
   * it, it competes with it.
   *
   * The lower wins, which is the only combination that cannot surprise anyone:
   * raising a customer's tier can never let them past a flow limit somebody
   * tightened, and tightening a flow limit can never be undone by a tier.
   */
  async #amountLimitFor<C extends Currency>(check: LimitCheck<C>): Promise<bigint | undefined> {
    const tier = await this.#tierLimit(check.userId, check.amount.currency);
    const flow = await this.#flowLimit(check);

    if (tier === undefined) return flow;
    if (flow === undefined) return tier;
    return tier < flow ? tier : flow;
  }

  /**
   * What this customer's verification tier allows in this currency, per day.
   *
   * Read on every check rather than cached, and that is deliberate. The reason
   * to lower somebody's tier is usually that something is wrong with their
   * account, and a ceiling that keeps the old value for thirty seconds after an
   * operator dropped it is a ceiling that has not been dropped. It is one
   * indexed lookup on a primary key.
   *
   * A missing row returns undefined rather than zero. Zero is a REAL limit here
   * — it is how "this tier may not move this currency at all" is expressed —
   * so collapsing "no row" into it would turn a coverage gap into a customer
   * who cannot move their own money, and nobody would be able to tell the two
   * apart from the error.
   */
  async #tierLimit(userId: string, currency: Currency): Promise<bigint | undefined> {
    const result = await this.pool.query<{ daily_limit_minor: string }>(
      `SELECT l.daily_limit_minor
         FROM users u
         JOIN kyc_tier_limits l ON l.tier = u.kyc_tier AND l.currency = $2
        WHERE u.id = $1::bigint`,
      [userId, currency],
    );
    const found = result.rows[0]?.daily_limit_minor;
    return found === undefined ? undefined : BigInt(found);
  }

  /** What anybody may move through this flow in a day, whoever they are. */
  async #flowLimit<C extends Currency>(check: LimitCheck<C>): Promise<bigint | undefined> {
    if (check.scope === 'crypto_withdrawal') {
      return this.settings.cryptoDailyLimitMinor(check.amount.currency);
    }

    if (check.amount.currency !== LIMITED_CURRENCY) return undefined;

    switch (check.scope) {
      case 'transfer':
        return this.settings.transferDailyLimitKobo();
      case 'purchase':
        return this.settings.purchaseDailyLimitKobo();
      case 'fx':
        return this.settings.fxDailyLimitKobo();
      case 'giftcard':
        return this.settings.giftcardDailyLimitKobo();
    }
  }

  /**
   * How many of this kind of movement are allowed in a rolling hour.
   *
   * A COUNT, so it applies in every currency and every asset — which is what
   * makes it the control that covers crypto at all. Every scope has one; there
   * is no flow where "as many as you like per hour" is the right answer.
   */
  async #countHourlyFor(scope: LimitScope): Promise<number | undefined> {
    switch (scope) {
      case 'transfer':
        return this.settings.transferCountHourly();
      case 'crypto_withdrawal':
        return this.settings.cryptoWithdrawalCountHourly();
      case 'fx':
        return this.settings.fxCountHourly();
      case 'giftcard':
        return this.settings.giftcardCountHourly();
      // A purchase is capped by its daily total and by the provider's own
      // rate limits; a count here would refuse somebody topping up several
      // phones in a row, which is ordinary behaviour rather than a signal.
      case 'purchase':
        return undefined;
    }
  }

  async precondition<C extends Currency>(
    check: LimitCheck<C>,
  ): Promise<((client: PoolClient) => Promise<void>) | undefined> {
    /*
     * TWO RULES WITH DIFFERENT SCOPES, and the difference is the point.
     *
     * The AMOUNT ceiling is published in kobo, so it is a statement about naira
     * and about nothing else — applying it to USDT because both are integers is
     * the same mistake as adding kobo to cents. It is skipped outright in any
     * other currency.
     *
     * The VELOCITY rules are COUNTS. A count carries no units, so there is
     * nothing to mis-apply and no reason to exempt a currency: a drain
     * denominated in USDT is a drain.
     */
    // Read OUTSIDE the transaction, deliberately. These are cached settings
    // lookups that may themselves hit the database, and doing them while
    // holding the ledger's transaction open would lengthen every money
    // movement's transaction for values that change a few times a year.
    const amountLimit = await this.#amountLimitFor(check);

    const countHourly = await this.#countHourlyFor(check.scope);
    const velocity =
      countHourly === undefined
        ? undefined
        : {
            countHourly,
            // Only a transfer has a RECIPIENT to have never been paid before.
            // A conversion pays the customer's own other wallet, and a gift
            // card pays the customer themselves.
            newRecipientsDaily:
              check.scope === 'transfer'
                ? await this.settings.transferNewRecipientsDaily()
                : undefined,
          };

    // Nothing to enforce: the caller passes no precondition at all rather than
    // one that does nothing. A hook that always runs and sometimes decides not
    // to is a hook somebody later adds a side effect to.
    if (amountLimit === undefined && velocity === undefined) return undefined;

    return async (client: PoolClient): Promise<void> => {
      await client.query(`SELECT pg_advisory_xact_lock($1::int, $2::int)`, [
        SCOPE_LOCK_KEY[check.scope],
        // The lock space is 32-bit and user ids are BIGINT. A collision costs
        // two unrelated customers a little contention and nothing else — the
        // lock is not what makes the sum correct, only what makes it stable
        // while it is read.
        Number(BigInt(check.userId) % 2147483647n),
      ]);

      // A replay skips EVERY rule, not just the amount one. A customer whose
      // request timed out and retried has already had this transfer counted
      // against all of them; re-checking would refuse the retry of a transfer
      // that succeeded, and tell them so.
      if (await alreadyPosted(client, check.idempotencyKey)) return;

      if (amountLimit !== undefined) {
        const spent = await spentToday(client, check.userId, check.scope, check.amount.currency);
        if (spent + check.amount.amount > amountLimit) {
          // 422 and no figure, for the same reason `InsufficientFundsError`
          // carries none: "₦412,000 of your ₦5,000,000 left today" is a report
          // on the customer's activity, and a stolen session must not be able
          // to farm one out of an error body.
          throw new UnprocessableEntityException({ error: 'daily_limit_exceeded' });
        }
      }

      if (velocity !== undefined) {
        const sentThisHour = await movementsInLastHour(client, check.userId, check.scope);
        if (sentThisHour + 1 > velocity.countHourly) {
          throw new UnprocessableEntityException({ error: 'too_many_transfers' });
        }

        if (check.recipientId !== undefined && velocity.newRecipientsDaily !== undefined) {
          const recipients = await recipientHistory(client, check.userId, check.recipientId);
          // Somebody already paid is not a new recipient however many times
          // they are paid again, so the ceiling only bites on strangers.
          if (
            !recipients.alreadyPaid &&
            recipients.newToday + 1 > velocity.newRecipientsDaily
          ) {
            throw new UnprocessableEntityException({ error: 'too_many_new_recipients' });
          }
        }
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
 * THE CURRENCY IS A PARAMETER, not the naira constant. It was `LIMITED_CURRENCY`
 * while every ceiling was published in kobo, and that was invisible until a
 * crypto ceiling arrived: a USDT limit compared against a sum of NGN postings
 * is always zero, so the ceiling could never be reached and a USDT withdrawal
 * of any size passed. The caller states which currency it is limiting and this
 * sums that one.
 *
 * "Today" is a Lagos day. The customers are Nigerian and their day ends at
 * midnight where they are — a UTC boundary would reset the limit at 1am local,
 * which is both surprising to them and an hour a fraudster would learn.
 */
async function spentToday(
  client: PoolClient,
  userId: string,
  scope: LimitScope,
  currency: string,
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
    [userId, currency, COUNTED[scope]],
  );
  return BigInt(result.rows[0]?.spent ?? '0');
}

/**
 * How many movements of this KIND the customer has made in the last hour, in
 * any currency.
 *
 * Counted from the SENDER'S OWN DEBIT LEG, so a transfer counts once however
 * many postings the entry carries — a fee leg would otherwise make every
 * charged transfer count twice, and the ceiling would halve itself the day a
 * fee was configured.
 */
async function movementsInLastHour(
  client: PoolClient,
  userId: string,
  scope: LimitScope,
): Promise<number> {
  const result = await client.query<{ sent: string }>(
    `SELECT count(*)::text AS sent
       FROM postings p
       JOIN accounts a        ON a.id = p.account_id
       JOIN journal_entries e ON e.id = p.journal_entry_id
      WHERE a.kind       = 'customer_wallet'
        AND a.owner_type = 'user'
        AND a.owner_id   = $1::bigint
        AND p.amount_minor < 0
        AND e.kind::text = ANY($2::text[])
        AND p.created_at > now() - INTERVAL '1 hour'`,
    [userId, COUNTED[scope]],
  );
  return Number(result.rows[0]?.sent ?? '0');
}

/**
 * Who this customer has paid before, and how many of them they met today.
 *
 * READ FROM POSTINGS, never from the entry's metadata. The metadata carries a
 * `recipient_id` our own code writes, which would make this far simpler — and
 * would mean a flow that forgot the key silently disabled the only control
 * that sees an account takeover. The postings are what actually moved, so a
 * recipient can only be missing here if they were never paid.
 *
 * A recipient is "new today" when the FIRST time this customer ever paid them
 * falls inside the current Lagos day. That is a stronger question than "did
 * they pay them today": somebody paid every month for a year is not a stranger
 * because this month's rent happens to have gone out this morning.
 *
 * "Today" is a Lagos day, the same as the amount ceiling. A UTC boundary would
 * reset this at 1am local — surprising to a customer and an hour a fraudster
 * would learn.
 */
async function recipientHistory(
  client: PoolClient,
  userId: string,
  recipientId: string,
): Promise<{ readonly alreadyPaid: boolean; readonly newToday: number }> {
  const result = await client.query<{ new_today: string; already_paid: boolean | null }>(
    `WITH paid AS (
       SELECT credit_account.owner_id       AS recipient_id,
              MIN(credit.created_at)        AS first_paid_at
         FROM journal_entries e
         JOIN postings debit           ON debit.journal_entry_id = e.id
                                      AND debit.amount_minor < 0
         JOIN accounts debit_account   ON debit_account.id         = debit.account_id
                                      AND debit_account.kind       = 'customer_wallet'
                                      AND debit_account.owner_type = 'user'
                                      AND debit_account.owner_id   = $1::bigint
         JOIN postings credit          ON credit.journal_entry_id = e.id
                                      AND credit.amount_minor > 0
         JOIN accounts credit_account  ON credit_account.id         = credit.account_id
                                      AND credit_account.kind       = 'customer_wallet'
                                      AND credit_account.owner_type = 'user'
        WHERE e.kind = 'wallet_transfer'
        GROUP BY credit_account.owner_id
     )
     SELECT count(*) FILTER (
              WHERE first_paid_at >= (date_trunc('day', now() AT TIME ZONE 'Africa/Lagos')
                                        AT TIME ZONE 'Africa/Lagos')
            )::text                                     AS new_today,
            bool_or(recipient_id = $2::bigint)          AS already_paid
       FROM paid`,
    [userId, recipientId],
  );

  const row = result.rows[0];
  return {
    // NULL when this customer has never sent a transfer at all, which is not
    // the same as false and must not be read as one by accident.
    alreadyPaid: row?.already_paid === true,
    newToday: Number(row?.new_today ?? '0'),
  };
}
