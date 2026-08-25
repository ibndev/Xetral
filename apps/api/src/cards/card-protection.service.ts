import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { DATABASE } from '../tokens.js';
import { SettingsService } from '../settings/settings.service.js';

/**
 * The guards that run around a card spend.
 *
 * WHAT THIS CAN AND CANNOT DO — the whole design follows from it.
 *
 * A Bitnob authorization webhook is a NOTIFICATION. The card network approved
 * the charge before we heard about it, so nothing here blocks one. Every
 * method below therefore runs ALONGSIDE the journal entry, never instead of
 * it: the money moved, and a policy that refused to write that down would
 * leave the books claiming a customer has money they do not have. That is the
 * same rule the deposit path follows when it cannot attribute a deposit and
 * posts to `suspense` rather than dropping the event.
 *
 * What it does instead is stop the NEXT one. A merchant that double-posts
 * usually triple-posts; a subscription that failed once retries on a schedule;
 * someone testing a stolen PAN tries again in seconds. In all three the second
 * event is the first evidence and the third is the one still preventable, so
 * the response to the second is to freeze the card.
 *
 * Freezing is the right lever precisely because it is reversible and cheap for
 * the customer to undo — it takes their PIN and nothing else — while the
 * alternatives are not. Reversing the posting would invent a refund the
 * merchant has not agreed to. Doing nothing costs a real charge.
 */
@Injectable()
export class CardProtectionService {
  readonly #logger = new Logger(CardProtectionService.name);

  constructor(
    @Inject(DATABASE) private readonly pool: Pool,
    @Inject(SettingsService) private readonly settings: SettingsService,
  ) {}

  /**
   * Normalises a merchant descriptor for comparison.
   *
   * "AMZN Mktp US*2H4KL", "AMZN MKTP US*2H4KL" and "  amzn  mktp us*2h4kl "
   * are one merchant to a customer and must be one to the duplicate check.
   * Card descriptors are notoriously inconsistent in case and padding between
   * the authorization and the settlement for the very same charge.
   *
   * Returns undefined for an absent or blank descriptor, which the duplicate
   * check treats as "cannot decide" rather than as a match — see the SQL.
   */
  static merchantKey(label: string | undefined): string | undefined {
    if (label === undefined) return undefined;
    const key = label.trim().toLowerCase().replace(/\s+/g, ' ');
    return key === '' ? undefined : key;
  }

  /**
   * Records an authorization and returns what, if anything, was wrong with it.
   *
   * Called with the SAME client the ledger used, inside the entry's own
   * transaction. That is not a convenience: the row must be written if and
   * only if the posting was, or the duplicate check ends up counting charges
   * that were rolled back — and freezing a card over a charge that never
   * happened is the failure that would destroy trust in the whole mechanism.
   */
  async recordAuthorization(
    client: PoolClient,
    authorization: {
      readonly cardId: string;
      readonly providerTxnId: string;
      readonly merchantLabel: string | undefined;
      readonly amountMinor: bigint;
      readonly currency: string;
      readonly entryId: string;
      readonly occurredAt: Date;
    },
  ): Promise<CardVerdict> {
    const merchantKey = CardProtectionService.merchantKey(authorization.merchantLabel);

    const [duplicateWindow, dailyLimit, hourlyLimit] = await Promise.all([
      this.settings.integer('card_duplicate_window_seconds', 90),
      this.settings.bigint('card_daily_spend_limit_cents', 200_000n),
      this.settings.integer('card_hourly_authorization_limit', 25),
    ]);

    // Everything below is measured BEFORE this row is inserted, so a charge
    // never counts itself. Inserting first and then counting would make the
    // hourly cap fire one authorization early and the daily cap fire on the
    // charge that reached the limit rather than the one that passed it.
    const reasons: string[] = [];

    if (duplicateWindow > 0 && merchantKey !== undefined) {
      const dup = await client.query<{ hits: number }>(
        `SELECT card_duplicate_authorizations($1, $2, $3, $4, $5) AS hits`,
        [
          authorization.cardId,
          merchantKey,
          authorization.amountMinor.toString(),
          authorization.occurredAt,
          duplicateWindow,
        ],
      );
      if ((dup.rows[0]?.hits ?? 0) > 0) reasons.push('duplicate_charge');
    }

    if (hourlyLimit > 0) {
      const burst = await client.query<{ count: string }>(
        `SELECT count(*) AS count FROM card_authorizations
          WHERE card_id = $1 AND occurred_at > $2::timestamptz - interval '1 hour'`,
        [authorization.cardId, authorization.occurredAt],
      );
      if (Number(burst.rows[0]?.count ?? '0') >= hourlyLimit) reasons.push('velocity_exceeded');
    }

    if (dailyLimit > 0n) {
      // A Lagos day, not a UTC one — the same boundary the transfer limit
      // uses. A UTC midnight resets a Nigerian customer's card limit at 1am
      // local, which is both surprising to them and an hour a fraudster would
      // learn.
      const spent = await client.query<{ total: string | null }>(
        `SELECT COALESCE(sum(amount_minor), 0)::TEXT AS total
           FROM card_authorizations
          WHERE card_id = $1
            AND currency = $2
            AND (occurred_at AT TIME ZONE 'Africa/Lagos')::date
              = ($3::timestamptz AT TIME ZONE 'Africa/Lagos')::date`,
        [authorization.cardId, authorization.currency, authorization.occurredAt],
      );
      const already = BigInt(spent.rows[0]?.total ?? '0');
      if (already + authorization.amountMinor > dailyLimit) reasons.push('daily_limit_exceeded');
    }

    const flagged = reasons.length > 0 ? reasons.join(',') : null;

    await client.query(
      `INSERT INTO card_authorizations
         (card_id, provider_txn_id, merchant_key, merchant_label,
          amount_minor, currency, entry_id, flagged_reason, occurred_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       -- A webhook redelivery. The ledger already answered "replayed" for
       -- the posting; this keeps the protection table's count honest too,
       -- because a double-counted redelivery would freeze a card over one
       -- charge that only ever happened once.
       ON CONFLICT (card_id, provider_txn_id) DO NOTHING`,
      [
        authorization.cardId,
        authorization.providerTxnId,
        merchantKey ?? null,
        authorization.merchantLabel ?? null,
        authorization.amountMinor.toString(),
        authorization.currency,
        authorization.entryId,
        flagged,
        authorization.occurredAt,
      ],
    );

    return { flagged: reasons };
  }

  /**
   * Records a decline and decides whether it should freeze the card.
   *
   * Runs on its OWN connection, not the ledger's — a decline moves no money,
   * so there is no entry and no transaction to join.
   */
  async recordDecline(decline: {
    readonly cardId: string;
    readonly providerTxnId: string | undefined;
    readonly merchantLabel: string | undefined;
    readonly amountMinor: bigint | undefined;
    readonly currency: string | undefined;
    readonly reason: CardDeclineReason;
    readonly providerReason: string | undefined;
    readonly occurredAt: Date;
  }): Promise<CardVerdict> {
    const inserted = await this.pool.query<{ id: string }>(
      `INSERT INTO card_declines
         (card_id, source, provider_txn_id, merchant_key, merchant_label,
          amount_minor, currency, reason, provider_reason, occurred_at)
       VALUES ($1, 'provider', $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (card_id, provider_txn_id) DO NOTHING
       RETURNING id`,
      [
        decline.cardId,
        decline.providerTxnId ?? null,
        CardProtectionService.merchantKey(decline.merchantLabel) ?? null,
        decline.merchantLabel ?? null,
        decline.amountMinor?.toString() ?? null,
        decline.currency ?? null,
        decline.reason,
        decline.providerReason ?? null,
        decline.occurredAt,
      ],
    );

    // A redelivery. It was already counted once and must not be counted again,
    // or a card freezes at half the threshold the operator configured.
    if (inserted.rowCount === 0) return { flagged: [] };

    const reasons: string[] = [];

    if (decline.reason === 'insufficient_funds') {
      if (await this.settings.boolean('card_freeze_on_insufficient_funds', true)) {
        reasons.push('insufficient_funds_decline');
      }
    }

    const burstThreshold = await this.settings.integer('card_decline_burst_threshold', 4);
    if (burstThreshold > 0) {
      const burst = await this.pool.query<{ count: string }>(
        `SELECT count(*) AS count FROM card_declines
          WHERE card_id = $1 AND occurred_at > $2::timestamptz - interval '1 hour'`,
        [decline.cardId, decline.occurredAt],
      );
      if (Number(burst.rows[0]?.count ?? '0') >= burstThreshold) reasons.push('decline_burst');
    }

    return { flagged: reasons };
  }

  /**
   * Freezes a card and records why, unless it is already frozen.
   *
   * Idempotent by design. Three duplicate charges in a minute produce three
   * verdicts, and a customer whose freeze notification arrived three times
   * would reasonably conclude something is badly wrong.
   *
   * Never throws into the caller. This runs after money has already been
   * recorded, on the webhook path; a failure to freeze is serious and must be
   * loud, but letting it turn a 200 into a 500 would make Bitnob retry a
   * webhook we have already correctly posted — and the retry would find the
   * ledger's idempotency key and change nothing, for ever.
   */
  async freeze(
    cardId: string,
    reason: string,
    detail: string,
    actor: 'automatic' | 'customer' | 'staff' = 'automatic',
  ): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // FOR UPDATE, so two webhooks arriving together cannot both read
      // 'active' and both write a freeze row.
      const card = await client.query<{ status: string }>(
        `SELECT status FROM cards WHERE id = $1 FOR UPDATE`,
        [cardId],
      );
      const status = card.rows[0]?.status;

      if (status === undefined || status === 'terminated' || status === 'frozen') {
        await client.query('ROLLBACK');
        return false;
      }

      await client.query(`UPDATE cards SET status = 'frozen', updated_at = now() WHERE id = $1`, [
        cardId,
      ]);
      await client.query(
        `INSERT INTO card_freezes (card_id, actor, reason, detail) VALUES ($1, $2, $3, $4)`,
        [cardId, actor, reason, detail],
      );

      await client.query('COMMIT');
      this.#logger.warn(`froze card ${cardId}: ${reason} (${detail})`);
      return true;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      this.#logger.error(
        `FAILED to freeze card ${cardId} after ${reason}. The card is still live and the ` +
          `event that should have stopped it has already happened: ${String(error)}`,
      );
      return false;
    } finally {
      client.release();
    }
  }

  /**
   * Records a freeze that has ALREADY been applied to the card row.
   *
   * Separate from `freeze()` because the customer's own freeze goes through
   * the provider first and updates `cards.status` on the way back; calling
   * `freeze()` there would see the card already frozen and record nothing, so
   * a customer freeze would leave no trace and unfreezing could not tell them
   * whose it was.
   */
  async record(
    cardId: string,
    actor: 'customer' | 'staff' | 'automatic',
    reason: string,
    detail: string | null,
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO card_freezes (card_id, actor, reason, detail) VALUES ($1, $2, $3, $4)`,
      [cardId, actor, reason, detail],
    );
  }

  /** Marks the live automatic freeze on a card as lifted, if there is one. */
  async liftFreeze(cardId: string, liftedBy: string): Promise<void> {
    await this.pool.query(
      `UPDATE card_freezes SET lifted_at = now(), lifted_by = $2
        WHERE card_id = $1 AND lifted_at IS NULL`,
      [cardId, liftedBy],
    );
  }

  /**
   * Why a card is frozen, for the customer's screen.
   *
   * "Frozen" alone is not enough to write a sentence with: one case is "you
   * froze this, tap to unfreeze" and the other is "we stopped a charge that
   * looked wrong, here is what it was". Showing the first wording for the
   * second case tells a customer nothing happened when something did.
   */
  async liveFreeze(
    cardId: string,
  ): Promise<{ actor: string; reason: string; detail: string | null; at: Date } | undefined> {
    const row = await this.pool.query<{
      actor: string;
      reason: string;
      detail: string | null;
      created_at: Date;
    }>(
      `SELECT actor, reason, detail, created_at FROM card_freezes
        WHERE card_id = $1 AND lifted_at IS NULL
        ORDER BY created_at DESC LIMIT 1`,
      [cardId],
    );
    const found = row.rows[0];
    return found === undefined
      ? undefined
      : { actor: found.actor, reason: found.reason, detail: found.detail, at: found.created_at };
  }
}

/** What a guard found. Empty means nothing was wrong. */
export interface CardVerdict {
  readonly flagged: readonly string[];
}

/**
 * Our classification of a decline, which is what the code branches on.
 *
 * Deliberately separate from the provider's own wording, which is recorded
 * beside it. A provider rewording "Insufficient funds" to "Balance too low" in
 * a release note must not silently switch off the freeze that depends on it.
 */
export type CardDeclineReason =
  | 'insufficient_funds'
  | 'card_not_active'
  | 'limit_exceeded'
  | 'provider_declined';

/**
 * Maps a provider's decline text to our classification.
 *
 * Unrecognised text becomes `provider_declined` — a real decline that is
 * recorded and counts toward the burst threshold, but does not trigger the
 * insufficient-funds freeze. Guessing the other way would freeze cards on
 * declines we do not understand, which during a provider incident is every
 * card at once.
 */
export function classifyDecline(providerReason: string | undefined): CardDeclineReason {
  const text = (providerReason ?? '').toLowerCase();
  if (/insufficient|not enough|low balance|balance too low|nsf/.test(text)) {
    return 'insufficient_funds';
  }
  if (/frozen|blocked|inactive|terminated|suspended/.test(text)) return 'card_not_active';
  if (/limit|velocity|exceed/.test(text)) return 'limit_exceeded';
  return 'provider_declined';
}
