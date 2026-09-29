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
  readonly outcome: 'reversed' | 'delivered' | 'held' | 'reviewed';
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

/**
 * ONE LIST, THREE STATES. The screen used to be three sections — held,
 * refunded-but-paid, already given back — and an operator had to read all
 * three to answer one question about one transfer.
 *
 *   stuck         held, and the provider has not answered yet; asked again
 *                 automatically on every sweep and every time this list loads
 *   needs_review  a person has to look: held and the provider CANNOT say, or
 *                 given back and the provider says it was ALSO paid
 *   resolved      closed in the last seven days, by the provider's answer or
 *                 by a person
 */
export type RecoveryState = 'stuck' | 'needs_review' | 'resolved';

export interface RecoveryItem {
  readonly kind: RecoveryKind;
  readonly subject_uuid: string;
  readonly name: string | null;
  readonly email: string | null;
  readonly currency: string;
  readonly amount_minor: string;
  readonly destination: string;
  readonly created_at: string;
  readonly state: RecoveryState;
  /** One line saying why it is in this state. */
  readonly note: string;
  readonly resolved_at: string | null;
}

export type RecoveryAction = 'mark_resolved' | 'refund' | 'send' | 'mark_delivered' | 'mark_reviewed';

export interface RecoveryDetail {
  readonly kind: RecoveryKind;
  readonly subject_uuid: string;
  readonly reference: string;
  readonly status: string;
  readonly provider: string | null;
  readonly destination: string;
  readonly currency: string;
  readonly amount_minor: string;
  readonly created_at: string;
  readonly failure_reason: string | null;
  /** Asked of the provider on THIS request. */
  readonly provider_status: {
    readonly verdict: 'delivered' | 'failed' | 'not_found' | 'pending' | 'unknown';
    readonly detail: string;
  };
  /** What the screen may offer, first one being the default. */
  readonly actions: readonly RecoveryAction[];
  readonly history: readonly { readonly at: string; readonly what: string; readonly who: string | null; readonly reason: string | null }[];
}

/** How the history names a double payment a person has closed. */
const REVIEWED = 'Reviewed — paid twice';

/** Held this long before a person is shown it: the webhook and the sweep own it until then. */
const REVIEW_AFTER_HOURS = 0.5;
/** How long this list will wait on providers before drawing what it has. */
const LIST_BUDGET_MS = 6_000;

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
   * THE ONE LIST.
   *
   * IT ASKS FIRST. Every held payout and purchase old enough to show is put
   * to its provider before the list is drawn, and a definite answer closes it
   * — delivered is settled, failed is given back — so a transfer the provider
   * has confirmed is never on this screen. That is the webhook's job and the
   * sweep's; doing it here as well means a missed event or a worker that is
   * not running cannot put a delivered payout in front of somebody with a
   * refund button. Bounded in time: what the providers have not answered by
   * then is drawn as stuck and asked again next time.
   */
  async list(): Promise<{ items: readonly RecoveryItem[]; summary: RecoverySummary }> {
    const due = (await this.waiting()).filter((row) => row.hours_held >= REVIEW_AFTER_HOURS).slice(0, 25);
    const unanswerable = new Set<string>();
    const asking = Promise.all(
      due.map(async (row) => {
        try {
          if (row.kind === 'bank_payout') {
            const verdict = await this.payouts.resolveWithRail(await this.#payout(row.subject_uuid));
            if (verdict.kind === 'unknown' && !verdict.retryable) unanswerable.add(row.subject_uuid);
          } else {
            await this.reconciliation.resolveOne(row.subject_uuid);
          }
        } catch (error) {
          this.#logger.warn(`recovery list could not ask about ${row.kind} ${row.subject_uuid}: ${describe(error)}`);
        }
      }),
    );
    /*
     * AND A PAYOUT SENT A DAY AGO WITH NO FINAL WORD. Not held — the money
     * left — so it is not a row here; but it is what `bank_payouts_stuck`
     * counts, and a missed webhook leaves it there for ever. Asked on the
     * same terms: arrived completes it, failed gives it back, and silence
     * changes nothing.
     */
    const unfinished = this.pool
      .query<PayoutRow>(
        `SELECT * FROM bank_payouts
          WHERE status = 'sent' AND created_at < now() - interval '24 hours'
          ORDER BY created_at LIMIT 10`,
      )
      .then((rows) =>
        Promise.all(
          rows.rows.map((row) =>
            this.payouts.resolveWithRail(row).catch((error: unknown) => {
              this.#logger.warn(`recovery list could not ask about sent payout ${row.uuid}: ${describe(error)}`);
            }),
          ),
        ),
      )
      .catch(() => undefined);
    const auditing = this.auditRefunded(25).catch(() => undefined);
    const [, audit] = await Promise.all([
      withinBudget(asking),
      withinBudget(auditing),
      withinBudget(unfinished),
    ]);

    const held = (await this.waiting()).filter((row) => row.hours_held >= REVIEW_AFTER_HOURS);
    const items: RecoveryItem[] = held.map((row) => ({
      kind: row.kind,
      subject_uuid: row.subject_uuid,
      name: row.name,
      email: row.email,
      currency: row.currency,
      amount_minor: row.amount_minor,
      destination: row.destination,
      created_at: new Date(row.created_at).toISOString(),
      state: unanswerable.has(row.subject_uuid) ? 'needs_review' : 'stuck',
      note: unanswerable.has(row.subject_uuid)
        ? 'The provider cannot say what happened. Check their dashboard.'
        : 'Waiting for the provider to confirm.',
      resolved_at: null,
    }));
    /*
     * A DOUBLE PAYMENT A PERSON HAS REVIEWED LEAVES THE QUEUE. The finding
     * stays true — the provider still says it was paid — but what it asks of
     * an operator is a conversation with the customer, and once somebody has
     * had it and written down the outcome, listing it for ever makes the
     * queue a record of the past rather than a list of work.
     */
    const reviewed = await this.#reviewedSubjects((audit?.paid_twice ?? []).map((p) => p.subject_uuid));
    for (const paid of audit?.paid_twice ?? []) {
      if (reviewed.has(paid.subject_uuid)) continue;
      items.push({
        kind: 'bank_payout',
        subject_uuid: paid.subject_uuid,
        name: null,
        email: paid.email,
        currency: paid.currency,
        amount_minor: paid.amount_minor,
        destination: paid.destination,
        created_at: paid.created_at,
        state: 'needs_review',
        note: 'Given back to the customer, but the provider says it was ALSO paid.',
        resolved_at: null,
      });
    }
    /*
     * ONE ROW PER TRANSACTION. A payout given back and then found paid was
     * drawn twice — "Resolved" for the refund and "Needs review" for the
     * finding — so the same reference read as closed and open at once. The
     * open state wins: a resolved row for something still open is hidden.
     */
    const open = new Set(items.map((item) => item.subject_uuid));
    items.push(...(await this.#resolvedRecently()).filter((item) => !open.has(item.subject_uuid)));
    return { items, summary: await this.summary() };
  }

  /** Of these payouts, the ones a person has recorded as reviewed. */
  async #reviewedSubjects(subjects: readonly string[]): Promise<Set<string>> {
    if (subjects.length === 0) return new Set();
    const rows = await this.pool.query<{ subject_id: string }>(
      `SELECT DISTINCT subject_id FROM admin_audit_log
        WHERE action = 'recovery.reviewed' AND subject_id = ANY($1::text[])`,
      [subjects],
    );
    return new Set(rows.rows.map((row) => row.subject_id));
  }

  /** Closed in the last seven days, by a person or by the provider's answer on this screen. */
  async #resolvedRecently(): Promise<RecoveryItem[]> {
    const rows = await this.pool.query<{
      kind: RecoveryKind; subject_uuid: string; name: string | null; email: string | null;
      currency: string; amount_minor: string; destination: string; created_at: Date;
      resolved_at: Date; how: string;
    }>(
      `SELECT r.kind::text AS kind, r.subject_uuid, u.full_name AS name, u.email, r.currency,
              r.amount_minor::text AS amount_minor,
              COALESCE(p.bank_name || ' ' || p.account_number, pu.service::text, '') AS destination,
              COALESCE(p.created_at, pu.created_at, r.created_at) AS created_at,
              r.created_at AS resolved_at, 'refunded' AS how
         FROM recovery_actions r
         JOIN users u ON u.id = r.user_id
         LEFT JOIN bank_payouts p ON r.kind = 'bank_payout' AND p.uuid = r.subject_uuid
         LEFT JOIN purchases pu ON r.kind = 'purchase' AND pu.uuid = r.subject_uuid
        WHERE r.created_at > now() - interval '7 days'
       UNION ALL
       SELECT 'bank_payout', p.uuid, u.full_name, u.email, p.currency, p.amount_minor::text,
              p.bank_name || ' ' || p.account_number, p.created_at, l.created_at, 'delivered'
         FROM admin_audit_log l
         JOIN bank_payouts p ON p.uuid::text = l.subject_id
         JOIN users u ON u.id = p.user_id
        WHERE l.action = 'recovery.delivered' AND l.created_at > now() - interval '7 days'
       UNION ALL
       SELECT 'bank_payout', p.uuid, u.full_name, u.email, p.currency,
              (p.amount_minor + p.fee_minor)::text,
              p.bank_name || ' ' || p.account_number, p.created_at, l.created_at, 'reviewed'
         FROM admin_audit_log l
         JOIN bank_payouts p ON p.uuid::text = l.subject_id
         JOIN users u ON u.id = p.user_id
        WHERE l.action = 'recovery.reviewed' AND l.created_at > now() - interval '7 days'
        ORDER BY resolved_at DESC
        LIMIT 50`,
    );
    // The latest closing per transaction: a refund later reviewed as a
    // double payment is one row saying so, not two.
    const seen = new Set<string>();
    const latest = rows.rows.filter((row) => {
      if (seen.has(row.subject_uuid)) return false;
      seen.add(row.subject_uuid);
      return true;
    });
    return latest.map((row) => ({
      kind: row.kind,
      subject_uuid: row.subject_uuid,
      name: row.name,
      email: row.email,
      currency: row.currency,
      amount_minor: row.amount_minor,
      destination: row.destination,
      created_at: new Date(row.created_at).toISOString(),
      state: 'resolved' as const,
      note:
        row.how === 'refunded'
          ? 'Refunded to the customer’s wallet.'
          : row.how === 'reviewed'
            ? 'Paid twice — reviewed and closed by a person.'
            : 'Confirmed delivered.',
      resolved_at: new Date(row.resolved_at).toISOString(),
    }));
  }

  /**
   * ONE TRANSACTION, OPENED: its detail, what the provider says NOW, what may
   * be pressed, and everything that has been done to it. Reads only.
   */
  async detail(kind: RecoveryKind, subjectUuid: string): Promise<RecoveryDetail> {
    const history = await this.#history(subjectUuid);
    if (kind === 'bank_payout') {
      const payout = await this.#payout(subjectUuid);
      const held = payout.status === 'reserved';
      let verdict: RecoveryDetail['provider_status'];
      let actions: RecoveryAction[] = [];
      try {
        const said = await this.payouts.confirmWithRail(payout);
        if (said.kind === 'arrived') {
          verdict = { verdict: 'delivered', detail: 'The provider says this was delivered.' };
          // Given back AND delivered: the double payment. Nothing here can
          // move that money back, but a person can record that they have
          // dealt with it, which is what takes it off the queue.
          const paidTwice = payout.status === 'failed' && !history.some((h) => h.what === REVIEWED);
          actions = held ? ['mark_resolved'] : paidTwice ? ['mark_reviewed'] : [];
        } else if (said.kind === 'failed') {
          verdict = { verdict: 'failed', detail: `The provider says this failed: ${said.reason}` };
          actions = held ? ['refund'] : [];
        } else if (said.kind === 'never_sent') {
          verdict = { verdict: 'not_found', detail: 'The provider has no transfer with this reference.' };
          actions = held ? ['refund', 'send'] : [];
        } else {
          verdict = { verdict: 'unknown', detail: `The provider cannot say: ${said.why}` };
          actions = held ? ['send', 'refund', 'mark_delivered'] : [];
        }
      } catch (error) {
        verdict = { verdict: 'unknown', detail: `The provider could not be asked: ${describe(error)}` };
        actions = held ? ['send', 'refund', 'mark_delivered'] : [];
      }
      return {
        kind,
        subject_uuid: payout.uuid,
        reference: payout.reference,
        status: payout.status,
        provider: payout.provider,
        destination: `${payout.bank_name} ${payout.account_number}`,
        currency: payout.currency,
        amount_minor: payout.amount_minor,
        created_at: new Date(payout.created_at).toISOString(),
        failure_reason: payout.failure_reason,
        provider_status: verdict,
        actions,
        history,
      };
    }
    const rows = await this.pool.query<{
      uuid: string; reference: string; status: string; service: string; target: string | null;
      currency: string; amount_minor: string; created_at: Date; failure_reason: string | null;
    }>(
      `SELECT uuid, reference, status::text AS status, service::text AS service,
              NULL::text AS target, currency, amount_minor::text AS amount_minor, created_at,
              NULL::text AS failure_reason
         FROM purchases WHERE uuid = $1::uuid`,
      [subjectUuid],
    );
    const purchase = rows.rows[0];
    if (purchase === undefined) throw new NotFoundException({ error: 'not_recoverable' });
    const held = purchase.status === 'reserved';
    const said = await this.reconciliation.peek(subjectUuid);
    const actions: RecoveryAction[] = !held
      ? []
      : said.status === 'delivered'
        ? ['mark_resolved']
        : said.status === 'failed'
          ? ['refund']
          : said.status === 'pending'
            ? []
            : ['refund'];
    return {
      kind,
      subject_uuid: purchase.uuid,
      reference: purchase.reference,
      status: purchase.status,
      provider: null,
      destination: purchase.service,
      currency: purchase.currency,
      amount_minor: purchase.amount_minor,
      created_at: new Date(purchase.created_at).toISOString(),
      failure_reason: purchase.failure_reason,
      provider_status: { verdict: said.status, detail: said.detail },
      actions,
      history,
    };
  }

  /** Everything a person did to this transaction, oldest first — the append-only record. */
  async #history(subjectUuid: string): Promise<RecoveryDetail['history']> {
    const rows = await this.pool.query<{
      at: Date;
      what: string;
      who: string | null;
      reason: string | null;
      sent: string | null;
    }>(
      `SELECT l.created_at AS at, l.action AS what, u.email AS who, l.reason,
              l.detail->>'sent' AS sent
         FROM admin_audit_log l
         LEFT JOIN users u ON u.id = l.actor_id
        WHERE l.subject_id = $1 AND l.action LIKE 'recovery.%'
        ORDER BY l.created_at`,
      [subjectUuid],
    );
    return rows.rows.map((row) => ({
      at: new Date(row.at).toISOString(),
      what:
        row.what === 'recovery.reverse'
          ? 'Refunded to the customer'
          : row.what === 'recovery.delivered'
            ? 'Marked delivered'
            : row.what === 'recovery.resend'
              ? // A RESEND THE PROVIDER REFUSED IS NOT A SEND. It read "Sent to
                // the recipient again" twice over a payout still held, which
                // is a history claiming something happened that did not.
                row.sent === 'false'
                ? 'Tried sending again — the provider did not accept it'
                : 'Sent to the recipient again'
              : row.what === 'recovery.reviewed'
                ? REVIEWED
                : row.what,
      who: row.who,
      reason: row.reason,
    }));
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
  /**
   * How many rows the list would show as open — for the sidebar badge, which
   * must say nothing when the list has nothing. Cheap: no provider is asked.
   */
  async openCount(): Promise<{ readonly open: number }> {
    const rows = await this.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM money_awaiting_recovery WHERE hours_held >= $1`,
      [REVIEW_AFTER_HOURS],
    );
    return { open: Number(rows.rows[0]?.n ?? 0) };
  }

  async summary(): Promise<RecoverySummary> {
    try {
      const [held, recovered] = await Promise.all([
        this.pool.query<{ currency: string; amount_minor: string; n: string }>(
          // ONLY WHAT THE LIST SHOWS. A payout sent a minute ago is in
          // flight, not stuck; counting it put a figure on this screen above
          // a list with nothing in it, and the figure never went away.
          `SELECT currency, sum(amount_minor)::text AS amount_minor, count(*)::text AS n
             FROM money_awaiting_recovery
            WHERE hours_held >= $1
            GROUP BY currency
            ORDER BY sum(amount_minor) DESC`,
          [REVIEW_AFTER_HOURS],
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

    return this.#recordReversal(kind, subjectUuid, row, actorUuid, actorId, entryId, reason, ip,
      'The provider says this failed, so the money is back in the customer’s wallet.');
  }

  async #recordReversal(
    kind: RecoveryKind,
    subjectUuid: string,
    row: HeldMoney,
    actorUuid: string,
    actorId: string,
    entryId: string,
    reason: string,
    ip: string | undefined,
    detail: string,
  ): Promise<RecoveryOutcome> {
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
        `(${kind} ${subjectUuid}) by ${actorUuid}: ${reason}`,
    );

    const record = written.rows[0];
    return {
      outcome: 'reversed',
      detail,
      ...(record === undefined ? {} : { record: { ...record, email: row.email, actioned_by: actorUuid } }),
    };
  }

  /**
   * REFUND A HELD ROW TO THE CUSTOMER'S WALLET ON A PERSON'S DECISION — for a
   * payout or purchase the provider says failed, or cannot say anything about.
   *
   * REFUSED WHEN THE PROVIDER SAYS IT WAS DELIVERED. That is paying the same
   * money twice, which is exactly what this screen once did to the owner's own
   * payout; the owner's standing decision is that it is blocked, not merely
   * warned about. The provider is asked on THIS request, never trusted from
   * whatever the screen showed a minute ago.
   */
  async refund(
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
      const verdict = await this.payouts.confirmWithRail(payout);
      if (verdict.kind === 'arrived') {
        throw new ConflictException({ error: 'refund_refused_delivered' });
      }
      await this.payouts.fail(payout, `refunded by staff: ${reason}`);
      entryId = await this.#reversalEntryFor(`bank-payout-reverse:${payout.reference}`);
    } else {
      const done = await this.reconciliation.refund(subjectUuid, reason);
      if (done === 'delivered') throw new ConflictException({ error: 'refund_refused_delivered' });
      const purchase = await this.pool.query<{ reference: string }>(
        `SELECT reference FROM purchases WHERE uuid = $1::uuid`,
        [subjectUuid],
      );
      entryId = await this.#reversalEntryFor(`purchase-reverse:${purchase.rows[0]?.reference ?? ''}`);
    }
    return this.#recordReversal(kind, subjectUuid, row, actorUuid, actorId, entryId, reason, ip,
      'Refunded to the customer’s Xetral wallet.');
  }

  /**
   * SEND A HELD PAYOUT TO ITS RECIPIENT AGAIN, under its own reference — see
   * `PayoutService.resend` for why that cannot pay twice. Asked first: a
   * payout the provider says ARRIVED is settled instead, and one it says
   * FAILED is refused here (the reference is spent; refund it instead).
   */
  async send(subjectUuid: string, actorUuid: string, reason: string, ip?: string): Promise<RecoveryOutcome> {
    const row = await this.#held('bank_payout', subjectUuid);
    const payout = await this.#payout(subjectUuid);
    const verdict = await this.payouts.confirmWithRail(payout);
    if (verdict.kind === 'arrived') {
      await this.payouts.applyReceipt(payout, verdict.receipt);
      await this.#noteDelivered(subjectUuid, row, actorUuid, reason, ip, 'provider');
      return { outcome: 'delivered', detail: 'The provider says this was already delivered. Nothing was sent again.' };
    }
    if (verdict.kind === 'failed') {
      return {
        outcome: 'held',
        detail: 'The provider says this transfer failed, so its reference cannot be used again. Refund it to the customer instead.',
      };
    }
    const result = await this.payouts.resend(payout);
    await this.audit.record({
      actorId: actorUuid,
      action: 'recovery.resend',
      subjectType: 'user',
      subjectId: subjectUuid,
      detail: { kind: 'bank_payout', amount_minor: row.amount_minor, currency: row.currency, sent: result.sent },
      reason,
      ...(ip === undefined ? {} : { ip }),
    });
    return { outcome: result.sent ? 'delivered' : 'held', detail: result.detail };
  }

  async #noteDelivered(
    subjectUuid: string,
    row: HeldMoney,
    actorUuid: string,
    reason: string,
    ip: string | undefined,
    by: 'provider' | 'staff',
    providerPayoutId?: string,
  ): Promise<void> {
    await this.audit.record({
      actorId: actorUuid,
      action: 'recovery.delivered',
      subjectType: 'user',
      subjectId: subjectUuid,
      detail: {
        kind: row.kind,
        amount_minor: row.amount_minor,
        currency: row.currency,
        by,
        ...(providerPayoutId === undefined ? {} : { provider_payout_id: providerPayoutId }),
      },
      reason,
      ...(ip === undefined ? {} : { ip }),
    });
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
   * A PERSON RECORDS THAT A DOUBLE PAYMENT HAS BEEN DEALT WITH.
   *
   * The payout was given back to the customer and the provider says it was
   * ALSO delivered. Nothing on this screen can recover that money — it is a
   * conversation with the customer — so this moves NOTHING. It writes the
   * outcome of that conversation into the append-only audit log, with the
   * person and the reason, and that record is what takes the row off
   * "Needs review". It is refused for anything that is not a payout already
   * given back, so it cannot be used to hide a payout still being held.
   */
  async markReviewed(subjectUuid: string, actorUuid: string, reason: string, ip?: string): Promise<RecoveryOutcome> {
    const payout = await this.#payout(subjectUuid);
    if (payout.status !== 'failed') throw new ConflictException({ error: 'not_recoverable' });
    await this.audit.record({
      actorId: actorUuid,
      action: 'recovery.reviewed',
      subjectType: 'user',
      subjectId: subjectUuid,
      detail: {
        kind: 'bank_payout',
        amount_minor: String(BigInt(payout.amount_minor) + BigInt(payout.fee_minor)),
        currency: payout.currency,
        reference: payout.reference,
      },
      reason,
      ...(ip === undefined ? {} : { ip }),
    });
    return {
      outcome: 'reviewed',
      detail: 'Recorded as reviewed. Nothing moved; the note is in the history.',
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
    // In parallel: this runs while an operator's screen is loading.
    await Promise.all(
      rows.rows.map(async (row) => {
        let verdict;
        try {
          verdict = await this.payouts.confirmWithRail(row);
        } catch (error) {
          this.#logger.warn(`audit could not ask about payout ${row.reference}: ${describe(error)}`);
          unconfirmed += 1;
          return;
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
      }),
    );
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

/** Resolves with the work's value, or undefined once the list's time budget is spent. */
async function withinBudget<T>(work: Promise<T>): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), LIST_BUDGET_MS);
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}
