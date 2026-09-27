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
import { ReconciliationService } from '../purchases/reconciliation.service.js';
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
  /** What the customer calls themselves — a greeting, not the verified name. */
  readonly name: string | null;
  readonly currency: string;
  readonly amount_minor: string;
  readonly status: string;
  readonly created_at: string;
  readonly hours_held: number;
  readonly destination: string;
}

export interface RecoverySummary {
  /** Rows held, of both kinds. */
  readonly stuck: number;
  /** Per currency, in minor units. */
  readonly held: readonly { readonly currency: string; readonly amount_minor: string }[];
  readonly recovered_7d: readonly { readonly currency: string; readonly amount_minor: string }[];
}

/**
 * What pressing the button did. Only `reversed` gave money back, and only
 * because the provider said the payout or purchase failed.
 */
export interface RecoveryOutcome {
  readonly outcome: 'reversed' | 'delivered' | 'held';
  readonly detail: string;
  readonly record?: RecoveryRecord;
}

/** A payout refunded to the customer that the provider says was ALSO paid. */
export interface RefundAuditRow {
  readonly subject_uuid: string;
  readonly reference: string;
  readonly email: string | null;
  readonly currency: string;
  readonly amount_minor: string;
  readonly destination: string;
  readonly created_at: string;
  readonly provider: string;
}

export interface RefundAudit {
  /** Refunded payouts looked at. */
  readonly checked: number;
  /** Of those, how many no provider could answer for. */
  readonly unconfirmed: number;
  readonly paid_twice: readonly RefundAuditRow[];
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
    @Inject(ReconciliationService) private readonly reconciliation: ReconciliationService,
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
        `SELECT m.kind::text AS kind, m.subject_uuid, m.user_id::text AS user_id, m.email,
                u.full_name AS name,
                m.currency, m.amount_minor::text AS amount_minor, m.status, m.created_at,
                round(m.hours_held::numeric, 1)::float8 AS hours_held, m.destination
           FROM money_awaiting_recovery m
           LEFT JOIN users u ON u.id = m.user_id
          ORDER BY m.created_at
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

/**
   * The three figures over the console, counted by the database.
   *
   * Money is summed PER CURRENCY and never across: kobo and cedis are both
   * integers and their sum is nothing. Largest first, so the tile leads with
   * the figure that matters most.
   */
  async summary(): Promise<RecoverySummary> {
    try {
      const [held, recovered] = await Promise.all([
        this.pool.query<{ currency: string; amount_minor: string; n: string }>(
          `SELECT currency, sum(amount_minor)::text AS amount_minor, count(*)::text AS n
             FROM money_awaiting_recovery
            GROUP BY currency
            ORDER BY sum(amount_minor) DESC`,
        ),
        this.pool.query<{ currency: string; amount_minor: string }>(
          `SELECT currency, sum(amount_minor)::text AS amount_minor
             FROM recovery_actions
            WHERE created_at > now() - interval '7 days'
            GROUP BY currency
            ORDER BY sum(amount_minor) DESC`,
        ),
      ]);
      return {
        stuck: held.rows.reduce((total, row) => total + Number(row.n), 0),
        held: held.rows.map(({ currency, amount_minor }) => ({ currency, amount_minor })),
        recovered_7d: recovered.rows,
      };
    } catch (error) {
      this.#logger.error(
        `could not total the recovery console: ${describe(error)}. ` +
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
   * RESOLVE ONE HELD ROW — BY ASKING, NEVER BY GUESSING.
   *
   * THIS BUTTON USED TO GIVE THE MONEY BACK ON A REASON ALONE. A payout held
   * because its send timed out, answered 5xx or answered in a shape we could
   * not read has very often ARRIVED — and reversing it credits the customer a
   * second time for money already in the beneficiary's account. That is the
   * business paying twice with every ledger entry balanced, and it is exactly
   * what the owner found: their own payout, delivered to their own bank,
   * listed here as money to hand back.
   *
   * NOW THE PROVIDER IS ASKED FIRST, through the same `confirmWithRail` the
   * sweep and both rails' events use:
   *   - delivered → settled to the float; NOTHING is given back.
   *   - failed, or the sending rail has no transfer with our reference →
   *     the flow's own reversal, recorded here with the person and reason.
   *   - anything else → nothing moves, and the screen says the provider could
   *     not confirm it. A person who has SEEN the transfer on the provider's
   *     dashboard records it with `markDelivered` — the safe direction.
   *
   * There is deliberately no way from this screen to give money back while
   * the provider cannot say what happened. The customer's money waits; the
   * business does not pay twice on a guess.
   */
  async recover(
    kind: RecoveryKind,
    subjectUuid: string,
    actorUuid: string,
    reason: string,
    ip?: string,
  ): Promise<RecoveryOutcome> {
    const actorId = await this.#userId(actorUuid);
    const row = await this.#held(kind, subjectUuid);

    let entryId: string;
    if (kind === 'bank_payout') {
      const payout = await this.#payout(subjectUuid);
      const verdict = await this.payouts.resolveWithRail(payout);
      if (verdict.kind === 'arrived') {
        await this.audit.record({
          actorId: actorUuid,
          action: 'recovery.delivered',
          subjectType: 'user',
          subjectId: subjectUuid,
          detail: { kind, amount_minor: row.amount_minor, currency: row.currency, by: 'provider' },
          reason,
          ...(ip === undefined ? {} : { ip }),
        });
        return {
          outcome: 'delivered',
          detail:
            'The provider says this payout was delivered, so it has been marked as sent. ' +
            'Nothing was given back.',
        };
      }
      if (verdict.kind === 'unknown') {
        this.#logger.warn(`recovery of payout ${subjectUuid} held: ${verdict.why}`);
        return {
          outcome: 'held',
          detail:
            'The provider could not confirm what happened to this payout, so nothing was ' +
            'given back. Check it on the provider’s dashboard: if it arrived, mark it ' +
            'delivered with their transfer id; if it failed, ask again once they can answer.',
        };
      }
      entryId = await this.#reversalEntryFor(`bank-payout-reverse:${payout.reference}`);
    } else {
      let result: 'settled' | 'reversed' | 'pending';
      try {
        result = await this.reconciliation.resolveOne(subjectUuid);
      } catch (error) {
        this.#logger.warn(`recovery of purchase ${subjectUuid} held: ${describe(error)}`);
        result = 'pending';
      }
      if (result === 'settled') {
        return {
          outcome: 'delivered',
          detail: 'The provider says this purchase was delivered, so it has been settled. Nothing was given back.',
        };
      }
      if (result === 'pending') {
        return {
          outcome: 'held',
          detail:
            'The provider has not said this purchase failed, so nothing was given back. ' +
            'It stays held until they answer.',
        };
      }
      const purchase = await this.pool.query<{ reference: string }>(
        `SELECT reference FROM purchases WHERE uuid = $1::uuid`,
        [subjectUuid],
      );
      entryId = await this.#reversalEntryFor(`purchase-reverse:${purchase.rows[0]?.reference ?? ''}`);
    }

    /*
     * THE RECORD, AFTER THE REVERSAL. `post()` owns its own transaction, so a
     * crash between the two leaves a reversal with no recovery row; the
     * ledger's idempotency key means a retry cannot double-reverse, and the
     * audit log still describes it. A posting written here instead would
     * break rule 1.
     */
    const written = await this.pool.query<RecoveryRecord>(
      `INSERT INTO recovery_actions
         (kind, subject_uuid, user_id, amount_minor, currency,
          reversal_entry_id, actioned_by, reason)
       VALUES ($1::recovery_kind, $2::uuid, $3::bigint, $4::bigint, $5, $6::bigint,
               $7::bigint, $8)
       ON CONFLICT DO NOTHING
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
        `(${kind} ${subjectUuid}) by ${actorUuid}, the provider having said it failed: ${reason}`,
    );

    const record = written.rows[0];
    return {
      outcome: 'reversed',
      detail: 'The provider says this failed, so the money is back in the customer’s wallet.',
      ...(record === undefined ? {} : { record: { ...record, email: row.email, actioned_by: actorUuid } }),
    };
  }

  /**
   * A PERSON RECORDS THAT A HELD PAYOUT ARRIVED, with the provider's own
   * transfer id — for the payout no rail will describe. Settles the hold to
   * the float, which moves nothing to the customer: the one direction a
   * person may decide on their own.
   */
  async markDelivered(
    subjectUuid: string,
    actorUuid: string,
    providerPayoutId: string,
    reason: string,
    ip?: string,
  ): Promise<RecoveryOutcome> {
    const row = await this.#held('bank_payout', subjectUuid);
    const payout = await this.#payout(subjectUuid);
    await this.payouts.markDelivered(payout, providerPayoutId);
    await this.audit.record({
      actorId: actorUuid,
      action: 'recovery.delivered',
      subjectType: 'user',
      subjectId: subjectUuid,
      detail: {
        kind: 'bank_payout',
        amount_minor: row.amount_minor,
        currency: row.currency,
        by: 'staff',
        provider_payout_id: providerPayoutId,
      },
      reason,
      ...(ip === undefined ? {} : { ip }),
    });
    return {
      outcome: 'delivered',
      detail: 'Recorded as delivered and settled. Nothing was given back.',
    };
  }

  /**
   * THE AUDIT: EVERY PAYOUT WE GAVE BACK, ASKED AGAIN.
   *
   * Before the provider was asked first, two paths could refund a payout that
   * had arrived — this screen's own button, and the sweep reading a refused
   * status question as "no such payout". Neither left a trace in the ledger,
   * because a reversal of a real transfer balances exactly like a reversal of
   * a failed one. So this reads the provider's own answer for each refunded
   * payout, most recent first, and lists any the provider says was PAID:
   * money the business has paid out twice.
   *
   * IT CHANGES NOTHING. Getting that money back is a conversation with a
   * customer, not a posting a screen should make on its own.
   */
  async auditRefunded(limit = 100): Promise<RefundAudit> {
    const rows = await this.pool.query<PayoutRow & { email: string | null }>(
      `SELECT p.*, u.email
         FROM bank_payouts p
         JOIN users u ON u.id = p.user_id
        WHERE p.status = 'failed'
        ORDER BY p.created_at DESC
        LIMIT $1`,
      [Math.min(Math.max(limit, 1), 200)],
    );
    const paidTwice: RefundAuditRow[] = [];
    let unconfirmed = 0;
    for (const row of rows.rows) {
      let verdict;
      try {
        verdict = await this.payouts.confirmWithRail(row);
      } catch (error) {
        this.#logger.warn(`audit could not ask about payout ${row.reference}: ${describe(error)}`);
        unconfirmed += 1;
        continue;
      }
      if (verdict.kind === 'arrived') {
        paidTwice.push({
          subject_uuid: row.uuid,
          reference: row.reference,
          email: row.email,
          currency: row.currency,
          amount_minor: String(BigInt(row.amount_minor) + BigInt(row.fee_minor)),
          destination: `${row.bank_name} ${row.account_number}`,
          created_at: new Date(row.created_at).toISOString(),
          provider: row.provider,
        });
      } else if (verdict.kind === 'unknown') {
        unconfirmed += 1;
      }
    }
    if (paidTwice.length > 0) {
      this.#logger.error(
        `REFUND AUDIT: ${paidTwice.length} payout(s) were given back although the provider ` +
          `says they were paid: ${paidTwice.map((r) => `${r.reference} ${r.amount_minor} ${r.currency}`).join(', ')}`,
      );
    }
    return { checked: rows.rows.length, unconfirmed, paid_twice: paidTwice };
  }

  async #held(kind: RecoveryKind, subjectUuid: string): Promise<HeldMoney> {
    const held = await this.pool.query<HeldMoney>(
      `SELECT kind::text AS kind, subject_uuid, user_id::text AS user_id, email,
              currency, amount_minor::text AS amount_minor, status, created_at,
              hours_held, destination
         FROM money_awaiting_recovery
        WHERE kind = $1::recovery_kind AND subject_uuid = $2::uuid`,
      [kind, subjectUuid],
    );
    const row = held.rows[0];
    // ALREADY RESOLVED, ALREADY SETTLED, OR NEVER HELD — one answer, so a
    // second press cannot post a second anything.
    if (row === undefined) throw new NotFoundException({ error: 'not_recoverable' });
    return row;
  }

  /**
   * THE WHOLE ROW, the way `PayoutService` reads it — not a column list. A
   * shorter copy named sixteen columns and left out `settle_entry_id`, which
   * `fail()` reads to decide which reversal is true; absent, a merely-held
   * payout was reversed as though it had been sent.
   */
  async #payout(subjectUuid: string): Promise<PayoutRow> {
    const rows = await this.pool.query<PayoutRow>(
      `SELECT * FROM bank_payouts WHERE uuid = $1::uuid`,
      [subjectUuid],
    );
    const row = rows.rows[0];
    if (row === undefined) throw new NotFoundException({ error: 'not_recoverable' });
    return row;
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
