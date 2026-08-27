import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import pg from 'pg';
import type { Pool } from 'pg';
import { DATABASE } from '../tokens.js';

/**
 * One investigation about one customer.
 *
 * WHY A CASE AND NOT JUST SIGNALS. A signal is about one transaction. A
 * reviewer looking at a customer with five of them has one story and five
 * rows, and closing each separately produces a record claiming five unrelated
 * reviews happened. Closing a case resolves everything attached in one act,
 * which is both easier and truer.
 *
 * NOTHING HERE IS CUSTOMER-FACING, and that is a legal constraint rather than
 * a product choice. Tipping off is an offence: where a case ends in a report,
 * the customer must not learn that from a screen, an email, or a support agent
 * reading a note. There is no endpoint that returns a case to its subject and
 * no notification kind that could mention one — `028_risk_cases.test.sql`
 * fails the build if a template appears that could.
 */
export interface CaseView {
  readonly id: string;
  readonly user_uuid: string;
  readonly email: string | null;
  readonly user_status: string;
  readonly reason: string | null;
  readonly opened_at: string;
  readonly due_at: string;
  readonly overdue: boolean;
  /** TRUE when the monitoring sweep opened it by counting rather than a person
   *  by judging. A different starting point, so a reviewer is told which. */
  readonly opened_by_the_sweep: boolean;
  readonly opened_by_email: string | null;
  readonly signals: number;
  readonly notes: number;
}

export type CaseOutcome = 'no_action' | 'reported' | 'account_restricted';

@Injectable()
export class CaseService {
  constructor(@Inject(DATABASE) private readonly pool: Pool) {}

  /** The queue, soonest deadline first. */
  async queue(limit: number): Promise<readonly CaseView[]> {
    const result = await this.pool.query<{
      uuid: string;
      user_uuid: string;
      email: string | null;
      user_status: string;
      reason: string | null;
      opened_at: Date;
      due_at: Date;
      overdue: boolean;
      opened_by_the_sweep: boolean;
      opened_by_email: string | null;
      signals: string;
      notes: string;
    }>(`SELECT * FROM risk_cases_open LIMIT $1`, [limit]);

    return result.rows.map((row) => ({
      id: row.uuid,
      user_uuid: row.user_uuid,
      email: row.email,
      user_status: row.user_status,
      reason: row.reason,
      opened_at: row.opened_at.toISOString(),
      due_at: row.due_at.toISOString(),
      overdue: row.overdue,
      opened_by_the_sweep: row.opened_by_the_sweep,
      opened_by_email: row.opened_by_email,
      // Counts, not amounts: safe to narrow, unlike anything with a currency.
      signals: Number(row.signals),
      notes: Number(row.notes),
    }));
  }

  /** One case, with everything a reviewer needs to decide it. */
  async detail(caseUuid: string): Promise<Record<string, unknown>> {
    const found = await this.pool.query<{ id: string }>(
      `SELECT id FROM risk_cases WHERE uuid = $1::uuid`,
      [caseUuid],
    );
    const id = found.rows[0]?.id;
    if (id === undefined) throw new NotFoundException({ error: 'case_not_found' });

    const [summary, signals, notes] = await Promise.all([
      this.pool.query(
        `SELECT c.uuid AS id, u.uuid AS user_uuid, u.email,
                u.status::text AS user_status, c.reason, c.status::text AS status,
                c.opened_at, c.due_at, (c.due_at < now()) AS overdue,
                c.outcome::text AS outcome, c.summary, c.report_reference,
                c.closed_at, closer.email AS closed_by_email
           FROM risk_cases c
           JOIN users u ON u.id = c.user_id
           LEFT JOIN users closer ON closer.id = c.closed_by
          WHERE c.id = $1::bigint`,
        [id],
      ),
      this.pool.query(
        `SELECT s.uuid AS id, s.rule::text AS rule, s.detail, s.observed_at,
                s.resolved_at, s.resolution
           FROM risk_case_signals l
           JOIN risk_signals s ON s.id = l.signal_id
          WHERE l.case_id = $1::bigint
          ORDER BY s.observed_at`,
        [id],
      ),
      this.pool.query(
        `SELECT n.note, n.created_at, a.email AS author
           FROM risk_case_notes n
           JOIN users a ON a.id = n.author_id
          WHERE n.case_id = $1::bigint
          ORDER BY n.created_at`,
        [id],
      ),
    ]);

    return {
      ...(summary.rows[0] ?? {}),
      signals: signals.rows,
      notes: notes.rows,
    };
  }

  /**
   * Opens one, and pulls in the customer's unattached open signals.
   *
   * A reviewer opening a case has already decided this customer is worth
   * looking at, so leaving their other signals loose in the queue would mean
   * somebody else picks one up and starts a second investigation nobody can
   * see — which is what the one-open-case-per-customer index refuses anyway.
   */
  async open(
    userUuid: string,
    reviewerUuid: string,
    reason: string,
  ): Promise<{ readonly id: string }> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const created = await client.query<{ id: string; uuid: string }>(
        `INSERT INTO risk_cases (user_id, reason, opened_by, due_at)
         SELECT u.id, $3, r.id, now()
           FROM users u, users r
          WHERE u.uuid = $1::uuid AND r.uuid = $2::uuid
         RETURNING id, uuid`,
        [userUuid, reviewerUuid, reason],
      );
      const row = created.rows[0];
      if (row === undefined) throw new NotFoundException({ error: 'user_not_found' });

      await client.query(
        `INSERT INTO risk_case_signals (case_id, signal_id, attached_by)
         SELECT $1::bigint, s.id, r.id
           FROM risk_signals s
           JOIN risk_cases c ON c.id = $1::bigint
           CROSS JOIN users r
           LEFT JOIN risk_case_signals l ON l.signal_id = s.id
          WHERE s.user_id = c.user_id AND s.resolved_at IS NULL
            AND l.signal_id IS NULL AND r.uuid = $2::uuid`,
        [row.id, reviewerUuid],
      );

      await client.query('COMMIT');
      return { id: row.uuid };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw translate(error);
    } finally {
      client.release();
    }
  }

  /** Adds a note. Refused on a closed case, by trigger as well as here. */
  async addNote(caseUuid: string, authorUuid: string, note: string): Promise<void> {
    try {
      const inserted = await this.pool.query(
        `INSERT INTO risk_case_notes (case_id, author_id, note)
         SELECT c.id, a.id, $3
           FROM risk_cases c, users a
          WHERE c.uuid = $1::uuid AND a.uuid = $2::uuid`,
        [caseUuid, authorUuid, note],
      );
      if (inserted.rowCount === 0) throw new NotFoundException({ error: 'case_not_found' });
    } catch (error) {
      throw translate(error);
    }
  }

  /**
   * Closes it, which resolves every signal attached.
   *
   * The resolution written onto each signal is the case's summary, by trigger
   * — so a reader of the signals sees the same true statement about all of
   * them rather than several separately typed ones.
   */
  async close(
    caseUuid: string,
    reviewerUuid: string,
    decision: {
      readonly outcome: CaseOutcome;
      readonly summary: string;
      readonly report_reference?: string | undefined;
    },
  ): Promise<{ readonly id: string; readonly closed_at: string }> {
    try {
      const result = await this.pool.query<{ uuid: string; closed_at: Date }>(
        `UPDATE risk_cases c
            SET status = 'closed', closed_at = now(), closed_by = r.id,
                outcome = $3::risk_case_outcome, summary = $4,
                report_reference = $5
           FROM users r
          WHERE r.uuid = $2::uuid AND c.uuid = $1::uuid AND c.status = 'open'
        RETURNING c.uuid, c.closed_at`,
        [
          caseUuid,
          reviewerUuid,
          decision.outcome,
          decision.summary,
          decision.report_reference ?? null,
        ],
      );
      const row = result.rows[0];
      if (row === undefined) {
        // One answer for "no such case" and "already closed", the same way the
        // dispute endpoints answer: a reviewer racing a colleague learns it is
        // handled, and nobody learns which case ids exist.
        throw new NotFoundException({ error: 'case_not_found' });
      }
      return { id: row.uuid, closed_at: row.closed_at.toISOString() };
    } catch (error) {
      throw translate(error);
    }
  }
}

/**
 * Turns the database's refusals into codes a reviewer can act on.
 *
 * The rules live in triggers and CHECKs, so this is the only place they become
 * words. An unrecognised failure is rethrown rather than flattened: a 500 that
 * gets recorded beats a 422 telling a reviewer their input was wrong when in
 * fact we are broken.
 */
function translate(error: unknown): unknown {
  if (!(error instanceof pg.DatabaseError)) return error;

  if (error.constraint === 'risk_cases_one_open_per_user') {
    return new ConflictException({ error: 'case_already_open' });
  }
  if (error.constraint === 'reported_cases_carry_a_reference') {
    return new UnprocessableEntityException({ error: 'report_reference_required' });
  }
  const message = error.message;
  if (message.includes('case is closed') || message.includes('opens a new case')) {
    return new ConflictException({ error: 'case_closed' });
  }
  if (message.includes('different customer')) {
    return new UnprocessableEntityException({ error: 'signal_not_this_customer' });
  }
  return error;
}
