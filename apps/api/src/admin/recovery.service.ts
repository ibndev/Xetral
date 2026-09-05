import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { Pool } from 'pg';
import { DATABASE } from '../tokens.js';
import { PayoutService, type PayoutRow } from '../payouts/payout.service.js';
import { PurchaseOutcome, type ReservedPurchase } from '../purchases/purchase-outcome.js';
import { AuditService } from './audit.service.js';

/**
 * GETTING A CUSTOMER'S MONEY BACK, WITH A PERSON'S NAME ON IT.
 *
 * WHAT THIS IS FOR. Money can end up held rather than delivered: a bank payout
 * the provider never answered for, a purchase whose outcome nobody ever
 * learned. The sweeps resolve most of that on their own and DELIBERATELY
 * refuse to resolve the rest — past the stale window both remaining answers
 * can be the wrong one, so a person decides. This is what that person presses.
 *
 * THE AMOUNT COMES FROM THE ROW, NEVER FROM A FORM, and that is the whole
 * safety argument. A screen that credited an arbitrary customer an arbitrary
 * amount would be a money-printing button on an operations surface, reachable
 * by anybody who got a session and a PIN. Every recovery here reverses ONE
 * held row and moves exactly what that row holds.
 *
 * SO THIS IS NOT THE PLACE TO WRITE OFF A LOSS. "We debited somebody and
 * should not have" is a real thing that happens and it already has an audited
 * path: 018's dispute flow, which posts to `expense_dispute_loss` — its own
 * expense account, deliberately not netted against revenue, so somebody has to
 * look at the number. Adding a second way to do that here would be a second
 * set of assumptions about the same decision, and the copy that drifts is the
 * one that only runs when money is already going wrong.
 *
 * IT REUSES THE FLOWS' OWN REVERSALS rather than writing postings. A second
 * copy of "how a payout is given back" would be a second set of assumptions
 * about the ledger — the rule `purchase-outcome.ts` states for its two callers
 * — and this one would run rarely, against money nobody is watching, which is
 * the worst possible place for a divergence.
 */

export type RecoveryKind = 'bank_payout' | 'purchase';

export interface HeldMoney {
  readonly kind: RecoveryKind;
  readonly subject_uuid: string;
  readonly user_id: string;
  readonly email: string | null;
  readonly currency: string;
  readonly amount_minor: string;
  readonly status: string;
  readonly created_at: string;
  readonly hours_held: number;
  readonly destination: string;
}

export interface RecoveryRecord {
  readonly uuid: string;
  readonly kind: string;
  readonly subject_uuid: string;
  readonly email: string | null;
  readonly amount_minor: string;
  readonly currency: string;
  readonly reason: string;
  readonly actioned_by: string | null;
  readonly created_at: string;
}

@Injectable()
export class RecoveryService {
  readonly #logger = new Logger(RecoveryService.name);

  constructor(
    @Inject(DATABASE) private readonly pool: Pool,
    @Inject(PayoutService) private readonly payouts: PayoutService,
    @Inject(PurchaseOutcome) private readonly purchases: PurchaseOutcome,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  /**
   * What is waiting for a person, oldest first.
   *
   * SWALLOWS A MISSING MIGRATION, for the reason the funding diagnostics
   * screen does. Nothing in this deployment applies migrations, so a release
   * can ship this code against a database that has not got 049 — and the
   * screen an operator opens BECAUSE a customer's money is stuck is the worst
   * possible place to answer 500. The console renders, says the schema is
   * behind, and names the file.
   */
  async waiting(): Promise<readonly HeldMoney[]> {
    try {
      const rows = await this.pool.query<HeldMoney>(
        `SELECT kind::text AS kind, subject_uuid, user_id::text AS user_id, email,
                currency, amount_minor::text AS amount_minor, status, created_at,
                round(hours_held::numeric, 1)::float8 AS hours_held, destination
           FROM money_awaiting_recovery
          ORDER BY created_at
          LIMIT 200`,
      );
      return rows.rows;
    } catch (error) {
      this.#logger.error(
        `THE DATABASE SCHEMA IS BEHIND THIS BUILD, and that is why the recovery ` +
          `console is empty: ${describe(error)}. Apply ` +
          `packages/ledger/sql/049_recovery.sql — it adds money_awaiting_recovery ` +
          `and recovery_actions. Nothing is wrong with the held money itself; ` +
          `this request never reached it.`,
      );
      throw new ServiceUnavailableException({ error: 'recovery_unavailable' });
    }
  }

  /**
   * What has already been given back, and who decided it.
   *
   * The screen shows this BESIDE the queue rather than on a page of its own,
   * because the question "has somebody already dealt with this?" is asked in
   * the same breath as "what is waiting?" — and an operator who cannot see the
   * answer presses the button again.
   */
  async recovered(limit = 50): Promise<readonly RecoveryRecord[]> {
    try {
      return await this.#recovered(limit);
    } catch (error) {
      // Same reasoning as `waiting()`: an operator opening this screen during
      // an incident must not be met with a 500 about a migration.
      this.#logger.error(
        `could not read the recovery log: ${describe(error)}. ` +
          `Apply packages/ledger/sql/049_recovery.sql to this database.`,
      );
      throw new ServiceUnavailableException({ error: 'recovery_unavailable' });
    }
  }

  async #recovered(limit: number): Promise<readonly RecoveryRecord[]> {
    const rows = await this.pool.query<RecoveryRecord>(
      `SELECT r.uuid, r.kind::text AS kind, r.subject_uuid, u.email,
              r.amount_minor::text AS amount_minor, r.currency, r.reason,
              a.email AS actioned_by, r.created_at
         FROM recovery_actions r
         JOIN users u ON u.id = r.user_id
         LEFT JOIN users a ON a.id = r.actioned_by
        ORDER BY r.created_at DESC
        LIMIT $1`,
      [limit],
    );
    return rows.rows;
  }

  /**
   * Give one held row back.
   *
   * `subjectUuid` names WHICH held row, and the amount is read from it. The
   * reason is required by the table, not merely by this method.
   */
  async recover(
    kind: RecoveryKind,
    subjectUuid: string,
    actorUuid: string,
    reason: string,
    ip?: string,
  ): Promise<RecoveryRecord> {
    const actorId = await this.#userId(actorUuid);

    const held = await this.pool.query<HeldMoney>(
      `SELECT kind::text AS kind, subject_uuid, user_id::text AS user_id, email,
              currency, amount_minor::text AS amount_minor, status, created_at,
              hours_held, destination
         FROM money_awaiting_recovery
        WHERE kind = $1::recovery_kind AND subject_uuid = $2::uuid`,
      [kind, subjectUuid],
    );
    const row = held.rows[0];
    if (row === undefined) {
      /*
       * ALREADY RECOVERED, ALREADY SETTLED, OR NEVER HELD — one answer.
       *
       * The view excludes anything with a recovery against it, so a second
       * press lands here rather than posting a second reversal. Distinguishing
       * the three would tell whoever pressed it what the other two states look
       * like, and none of them is a different action for them to take.
       */
      throw new NotFoundException({ error: 'not_recoverable' });
    }

    const entryId =
      kind === 'bank_payout'
        ? await this.#reversePayout(subjectUuid, reason)
        : await this.#reversePurchase(subjectUuid, reason);

    /*
     * THE RECORD, ON THE SAME TRANSACTION AS NOTHING.
     *
     * Written after the reversal rather than with it, and that is a real
     * limitation worth stating: `post()` owns its own transaction, so a crash
     * between the two leaves a reversal with no recovery row. The unique
     * constraint means the retry cannot double-reverse — the ledger's
     * idempotency key refuses the second posting — so the recoverable state is
     * "money returned, record missing", which the audit log still describes.
     * The alternative is a posting written by this service, which breaks
     * rule 1.
     */
    const written = await this.pool.query<RecoveryRecord>(
      `INSERT INTO recovery_actions
         (kind, subject_uuid, user_id, amount_minor, currency,
          reversal_entry_id, actioned_by, reason)
       VALUES ($1::recovery_kind, $2::uuid, $3::bigint, $4::bigint, $5, $6::bigint,
               $7::bigint, $8)
       RETURNING uuid, kind::text AS kind, subject_uuid, amount_minor::text AS amount_minor,
                 currency, reason, created_at`,
      [kind, subjectUuid, row.user_id, row.amount_minor, row.currency, entryId, actorId, reason],
    );

    await this.audit.record({
      actorId: actorUuid,
      action: 'recovery.reverse',
      subjectType: 'user',
      subjectId: subjectUuid,
      detail: { kind, amount_minor: row.amount_minor, currency: row.currency },
      reason,
      ...(ip === undefined ? {} : { ip }),
    });

    this.#logger.warn(
      `RECOVERED ${row.amount_minor} ${row.currency} for user ${row.user_id} ` +
        `(${kind} ${subjectUuid}) by ${actorUuid}: ${reason}`,
    );

    const record = written.rows[0];
    if (record === undefined) throw new Error('recovery insert returned no row');
    return { ...record, email: row.email, actioned_by: actorUuid };
  }

  /* ------------------------------------------------------------------ */

  async #reversePayout(subjectUuid: string, reason: string): Promise<string> {
    const rows = await this.pool.query<PayoutRow & { reserve_entry_id: string }>(
      `SELECT id::text, uuid, user_id::text, reference, status::text, country,
              bank_code, bank_name, account_number, account_name, narration,
              currency, amount_minor::text, fee_minor::text, tax_minor::text,
              provider_payout_id, failure_reason, reserve_entry_id::text, created_at
         FROM bank_payouts WHERE uuid = $1::uuid`,
      [subjectUuid],
    );
    const row = rows.rows[0];
    if (row === undefined) throw new NotFoundException({ error: 'not_recoverable' });

    // The flow's OWN reversal. It guards on `status IN ('reserved','sent')` and
    // posts under a derived idempotency key, so a repeat is a replay.
    await this.payouts.fail(row, `recovered by staff: ${reason}`);
    return this.#reversalEntryFor(`bank-payout-reverse:${row.reference}`);
  }

  async #reversePurchase(subjectUuid: string, reason: string): Promise<string> {
    const rows = await this.pool.query<ReservedPurchase & { uuid: string }>(
      `SELECT id::text, uuid, user_id::text, reference, service::text,
              amount_minor::text, currency, reserve_entry_id::text
         FROM purchases WHERE uuid = $1::uuid`,
      [subjectUuid],
    );
    const row = rows.rows[0];
    if (row === undefined) throw new NotFoundException({ error: 'not_recoverable' });

    await this.purchases.reverse(row, `recovered by staff: ${reason}`);
    return this.#reversalEntryFor(`purchase-reverse:${row.reference}`);
  }

  /**
   * The entry the reversal actually wrote.
   *
   * Read back by its idempotency key rather than returned by the reversal,
   * because both flows' `fail`/`reverse` return void and widening them for
   * this caller alone would change a money path to suit a reporting one. The
   * key is derived and unique, so this finds exactly the entry just posted —
   * including on a replay, where it finds the original.
   */
  async #reversalEntryFor(idempotencyKey: string): Promise<string> {
    const rows = await this.pool.query<{ id: string }>(
      `SELECT id::text FROM journal_entries WHERE idempotency_key = $1`,
      [idempotencyKey],
    );
    const id = rows.rows[0]?.id;
    if (id === undefined) {
      // Unreachable: the reversal above committed before this runs. Named
      // rather than left to a null constraint, which would arrive as a
      // violation with nothing explaining it.
      throw new ConflictException({ error: 'not_recoverable' });
    }
    return id;
  }

  async #userId(uuid: string): Promise<string> {
    const rows = await this.pool.query<{ id: string }>(
      `SELECT id::text FROM users WHERE uuid = $1`,
      [uuid],
    );
    const id = rows.rows[0]?.id;
    if (id === undefined) throw new NotFoundException({ error: 'user_not_found' });
    return id;
  }
}

/** An error's message, or its stringification. Used by the reads above, which
 *  must log what went wrong without letting it reach an operator as a stack
 *  trace on a screen they opened during an incident. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
