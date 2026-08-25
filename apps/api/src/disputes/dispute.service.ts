import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { PoolClient } from 'pg';
import pg from 'pg';
import type { Pool } from 'pg';
import { LedgerService, posting } from '@xetral/ledger';
import { fromMajor, toMajor } from '@xetral/shared';
import type { Currency, Money } from '@xetral/shared';
import { DATABASE, LEDGER } from '../tokens.js';
import { NotificationService } from '../notifications/notification.service.js';
import { AuditService } from '../admin/audit.service.js';

/**
 * A customer's claim that an entry is wrong, and what we do about it.
 *
 * WHAT RAISING ONE DOES TO THE MONEY: nothing. A claim is an assertion about a
 * fact, not a fact, and the assertion may be wrong or dishonest. Crediting on
 * the strength of one would make "dispute everything" a free withdrawal, and
 * reversing that credit later would take money from a customer who by then had
 * spent it. The gift card flow draws the same line: a submission is an offer,
 * and nothing is posted until a person has approved it.
 *
 * WHAT UPHOLDING ONE DOES: appends a refund. The disputed entry is never
 * touched — it is append-only, and it stays a true statement about what
 * happened whatever we later decide about who should bear it. The money comes
 * from `expense_dispute_loss`, ours, because there is no clawback: see the
 * header of `018_disputes.sql` for why reaching into the recipient's wallet is
 * not something we may do.
 */
export interface DisputeView {
  readonly id: string;
  readonly entry_id: string;
  readonly reason: string;
  readonly detail: string;
  readonly status: string;
  readonly raised_at: string;
  readonly due_at: string;
  readonly resolved_at: string | null;
  readonly resolution: string | null;
}

export interface QueuedDispute extends DisputeView {
  readonly email: string | null;
  readonly overdue: boolean;
  readonly entry_kind: string;
}

interface DisputeRow {
  uuid: string;
  entry_uuid: string;
  reason: string;
  detail: string;
  status: string;
  raised_at: Date;
  due_at: Date;
  resolved_at: Date | null;
  resolution: string | null;
}

@Injectable()
export class DisputeService {
  constructor(
    @Inject(DATABASE) private readonly pool: Pool,
    @Inject(LEDGER) private readonly ledger: LedgerService,
    @Inject(NotificationService) private readonly notifications: NotificationService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  /**
   * Raise a dispute.
   *
   * Almost every rule here is enforced by the database rather than checked
   * first: that the entry belongs to this customer, that it is inside the
   * window, that there is not already a live claim against it. That is not
   * laziness — a pre-check is a second, weaker copy of the rule plus a race,
   * which is the same reason the wallet never pre-checks a balance. What this
   * method does is TRANSLATE the refusals into something a customer can read.
   */
  async raise(
    userUuid: string,
    input: { readonly entry_id: string; readonly reason: string; readonly detail: string },
  ): Promise<DisputeView> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const inserted = await client.query<DisputeRow>(
        `INSERT INTO disputes (user_id, entry_id, reason, detail, due_at)
         SELECT u.id, e.id, $3::dispute_reason, $4, now()
           FROM users u, journal_entries e
          WHERE u.uuid = $1::uuid AND e.uuid = $2::uuid
         RETURNING uuid, $2::text AS entry_uuid, reason::text AS reason, detail,
                   status::text AS status, raised_at, due_at, resolved_at, resolution`,
        [userUuid, input.entry_id, input.reason, input.detail],
      );

      const row = inserted.rows[0];
      if (row === undefined) {
        // No row matched, so either the entry does not exist or the customer
        // does not. ONE answer for both: distinguishing them would tell a
        // caller which entry UUIDs are real, which is the enumeration this
        // endpoint must not become.
        throw new NotFoundException({ error: 'entry_not_found' });
      }

      // The customer's copy of the promise. Enqueued on THIS transaction, so
      // an acknowledgement cannot exist for a dispute that was rolled back and
      // a dispute cannot be recorded without one being owed.
      await this.#notify(client, userUuid, 'raised', row);

      await client.query('COMMIT');
      return view(row);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw translate(error);
    } finally {
      client.release();
    }
  }

  async listMine(userUuid: string): Promise<readonly DisputeView[]> {
    const result = await this.pool.query<DisputeRow>(
      `SELECT d.uuid, e.uuid AS entry_uuid, d.reason::text AS reason, d.detail,
              d.status::text AS status, d.raised_at, d.due_at, d.resolved_at, d.resolution
         FROM disputes d
         JOIN users u           ON u.id = d.user_id
         JOIN journal_entries e ON e.id = d.entry_id
        WHERE u.uuid = $1::uuid
        ORDER BY d.raised_at DESC
        LIMIT 100`,
      [userUuid],
    );
    return result.rows.map(view);
  }

  /** The customer changing their mind. Posts nothing, and is final like every
   *  other outcome — a withdrawn claim can be raised again as a NEW one. */
  async withdraw(userUuid: string, disputeUuid: string, resolution: string): Promise<DisputeView> {
    const result = await this.pool.query<DisputeRow>(
      `UPDATE disputes d
          SET status = 'withdrawn', resolved_at = now(), resolution = $3,
              -- The customer resolved it, so the customer is the resolver.
              resolved_by = u.id
         FROM users u, journal_entries e
        WHERE u.id = d.user_id AND e.id = d.entry_id
          AND u.uuid = $1::uuid AND d.uuid = $2::uuid AND d.status = 'open'
       RETURNING d.uuid, e.uuid AS entry_uuid, d.reason::text AS reason, d.detail,
                 d.status::text AS status, d.raised_at, d.due_at, d.resolved_at, d.resolution`,
      [userUuid, disputeUuid, resolution],
    );

    const row = result.rows[0];
    if (row === undefined) throw new NotFoundException({ error: 'dispute_not_found' });
    return view(row);
  }

  /** What staff work through, oldest deadline first. */
  async queue(): Promise<readonly QueuedDispute[]> {
    const result = await this.pool.query<
      DisputeRow & { email: string | null; overdue: boolean; entry_kind: string }
    >(
      `SELECT uuid, entry_uuid, reason::text AS reason, detail,
              'open' AS status, raised_at, due_at,
              NULL::timestamptz AS resolved_at, NULL::text AS resolution,
              email, overdue, entry_kind
         FROM disputes_open
        LIMIT 200`,
    );
    return result.rows.map((row) => ({
      ...view(row),
      email: row.email,
      overdue: row.overdue,
      entry_kind: row.entry_kind,
    }));
  }

  /**
   * A reviewer's decision.
   *
   * THE ORDER IS: post the refund, then record the outcome, and both inside
   * one transaction. Recording first and posting after would leave a dispute
   * marked paid with no money behind it if the process died in between — and
   * the CHECK requiring a refund on an accepted row exists precisely because
   * that state must be unreachable.
   */
  async resolve(
    reviewerUuid: string,
    disputeUuid: string,
    decision:
      | {
          readonly outcome: 'accepted';
          readonly resolution: string;
          readonly refund_amount: string;
          readonly idempotency_key: string;
        }
      | { readonly outcome: 'rejected'; readonly resolution: string },
    ip?: string,
  ): Promise<DisputeView> {
    const found = await this.pool.query<{
      id: string;
      user_id: string;
      user_uuid: string;
      currency: string;
    }>(
      `SELECT d.id, d.user_id, u.uuid AS user_uuid,
              -- The currency of the customer's OWN leg in the disputed entry.
              -- Refunding in any other would be a currency conversion nobody
              -- quoted, and on an FX trade the entry carries two.
              (SELECT a.currency
                 FROM postings p JOIN accounts a ON a.id = p.account_id
                WHERE p.journal_entry_id = d.entry_id
                  AND a.owner_type = 'user' AND a.owner_id = d.user_id
                LIMIT 1) AS currency
         FROM disputes d JOIN users u ON u.id = d.user_id
        WHERE d.uuid = $1::uuid AND d.status = 'open'`,
      [disputeUuid],
    );

    const dispute = found.rows[0];
    if (dispute === undefined) throw new NotFoundException({ error: 'dispute_not_found' });

    let refundEntryId: string | null = null;

    if (decision.outcome === 'accepted') {
      const currency = dispute.currency as Currency;
      let refund: Money<Currency>;
      try {
        refund = fromMajor(decision.refund_amount, currency);
      } catch {
        throw new UnprocessableEntityException({ error: 'invalid_amount' });
      }
      if (refund.amount <= 0n) {
        throw new UnprocessableEntityException({ error: 'invalid_amount' });
      }

      const posted = await this.ledger.post({
        // The reviewer's key, namespaced. A click that timed out and was made
        // again refunds once — the ledger answers `replayed: true` and the
        // UPDATE below then finds the dispute already resolved.
        idempotencyKey: `dispute-refund:${decision.idempotency_key}`,
        kind: 'dispute_refund',
        occurredAt: new Date(),
        description: 'dispute upheld',
        metadata: { dispute: disputeUuid, reviewer: reviewerUuid },
        postings: [
          posting(
            { kind: 'customer_wallet', ownerId: dispute.user_id, currency },
            refund,
          ),
          // OURS. There is no clawback from the recipient — see 018's header.
          // Posting the loss to an expense account rather than netting it
          // against revenue is what makes it a number somebody has to look at,
          // and a fraud rate nobody can see is a fraud rate nobody manages.
          posting({ kind: 'expense_dispute_loss', currency }, negate(refund)),
        ],
      });
      refundEntryId = posted.entryId;
    }

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const updated = await client.query<DisputeRow>(
        `UPDATE disputes d
            SET status = $3::dispute_status, resolved_at = now(),
                resolution = $4, resolved_by = r.id,
                refund_entry_id = $5::bigint
           FROM users r, journal_entries e
          WHERE r.uuid = $2::uuid AND e.id = d.entry_id
            AND d.uuid = $1::uuid AND d.status = 'open'
        RETURNING d.uuid, e.uuid AS entry_uuid, d.reason::text AS reason, d.detail,
                  d.status::text AS status, d.raised_at, d.due_at,
                  d.resolved_at, d.resolution`,
        [disputeUuid, reviewerUuid, decision.outcome, decision.resolution, refundEntryId],
      );

      const row = updated.rows[0];
      if (row === undefined) throw new ConflictException({ error: 'dispute_not_open' });

      await this.#notify(client, dispute.user_uuid, decision.outcome, row);
      await client.query('COMMIT');

      await this.audit.record({
        actorId: reviewerUuid,
        action: decision.outcome === 'accepted' ? 'dispute.accept' : 'dispute.reject',
        subjectType: 'dispute',
        subjectId: disputeUuid,
        detail: { outcome: decision.outcome },
        // Required by CHECK on a destructive action, and required here for a
        // better reason: an outcome nobody explained is one nobody can review.
        reason: decision.resolution,
        ...(ip === undefined ? {} : { ip }),
      });

      return view(row);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw translate(error);
    } finally {
      client.release();
    }
  }

  /**
   * Tells the customer where their claim stands.
   *
   * Best-effort on the caller's transaction, so a provider outage or a missing
   * keyring cannot take down the dispute itself. A SAVEPOINT rather than a
   * try/catch, because any error inside a Postgres transaction poisons it.
   */
  async #notify(
    client: PoolClient,
    userUuid: string,
    state: 'raised' | 'accepted' | 'rejected',
    row: DisputeRow,
  ): Promise<void> {
    const found = await client.query<{ id: string; email: string | null }>(
      `SELECT id, email FROM users WHERE uuid = $1::uuid`,
      [userUuid],
    );
    const user = found.rows[0];
    if (user === undefined || user.email === null) return;

    await this.notifications.enqueueBestEffort(client, {
      userId: user.id,
      recipient: user.email,
      // The dispute plus its state, so the acknowledgement and the outcome are
      // two messages and a redelivery of either is one.
      idempotencyKey: `dispute:${row.uuid}:${state}`,
      request: {
        kind: 'dispute_update',
        state,
        reference: row.uuid,
        dueAt: row.due_at.toISOString(),
      },
    });
  }
}

function view(row: DisputeRow): DisputeView {
  return {
    id: row.uuid,
    entry_id: row.entry_uuid,
    reason: row.reason,
    detail: row.detail,
    status: row.status,
    raised_at: row.raised_at.toISOString(),
    due_at: row.due_at.toISOString(),
    resolved_at: row.resolved_at?.toISOString() ?? null,
    resolution: row.resolution,
  };
}

function negate<C extends Currency>(amount: Money<C>): Money<C> {
  return { amount: -amount.amount, currency: amount.currency };
}

/**
 * Turns the database's refusals into codes a customer can act on.
 *
 * The rules live in triggers and constraints, so this is the only place they
 * become words. An unrecognised failure is rethrown rather than flattened into
 * a friendly message — a 500 that gets recorded is better than a 422 that
 * tells a customer their own claim was invalid when in fact we are broken.
 */
function translate(error: unknown): unknown {
  if (!(error instanceof pg.DatabaseError)) return error;

  if (error.constraint === 'disputes_one_live_per_entry') {
    return new ConflictException({ error: 'dispute_already_open' });
  }
  const message = error.message;
  if (message.includes('does not belong to user')) {
    // The same answer as "no such entry", deliberately. Telling a caller that
    // an entry exists but is not theirs is exactly the enumeration the
    // ownership trigger exists to prevent.
    return new NotFoundException({ error: 'entry_not_found' });
  }
  if (message.includes('dispute window')) {
    return new UnprocessableEntityException({ error: 'dispute_window_closed' });
  }
  return error;
}
