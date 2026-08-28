import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';
import { DATABASE } from '../tokens.js';

/**
 * What staff did, recorded before they are told it worked.
 *
 * A fintech is asked "who moved this, and when" by regulators, by disputing
 * customers, and by itself after an incident. An action nobody recorded is an
 * action that did not happen as far as any of them are concerned.
 *
 * The table is append-only by trigger, so this service cannot rewrite history
 * even if it wanted to — which is the point of putting the rule there rather
 * than here.
 */

export type AdminAction =
  | 'user.freeze'
  | 'user.unfreeze'
  | 'user.close'
  /* A verification tier raised or lowered. A reason is required in both
     directions: raising decides how much money may leave in a day, and
     lowering takes something away from a customer. */
  | 'user.tier'
  /* A card frozen by staff. A reason is required: the customer will ring back
     to ask why their card stopped working. */
  | 'card.freeze'
  | 'kyc.approve'
  | 'kyc.reject'
  | 'deposit.attribute'
  | 'deposit.return'
  | 'setting.change'
  | 'staff.grant'
  | 'staff.revoke'
  | 'giftcard.approve'
  | 'giftcard.reject'
  | 'giftcard.clawback'
  /* A dispute resolved. Recorded whichever way it went: an upheld one moved
     money, and a rejected one is a decision a customer may come back about. */
  | 'dispute.accept'
  | 'dispute.reject'
  /* A provider credential replaced. Recorded with the four-character HINT and
     never the value: this table is append-only, so a secret written into it
     could never be removed — which is exactly why credentials do not go
     through `setting.change`, whose detail IS the new value. */
  | 'credential.change'
  /* A monitoring signal reviewed and closed. Its `reason` is the reviewer's
     own words, and it is the part of an AML programme a regulator inspects. */
  | 'risk.resolve'
  /* A compliance case opened and closed. Closing carries the summary as its
     reason, which is the same text every signal the case covered gets. */
  | 'risk.case_open'
  | 'risk.case_close'
  /* A customer's data erased on request. THE ONE ACTION HERE THAT CANNOT BE
     UNDONE BY APPENDING, so it is in the schema's destructive list and its
     reason is the outcome itself — what went, and what had to stay. */
  | 'data.erase'
  | 'data.resolve';

export interface AuditEntry {
  /** The actor's UUID, as it appears in an access token. Resolved to the
   *  numeric id inside the INSERT, so no caller has to carry both. */
  readonly actorId: string;
  readonly action: AdminAction;
  readonly subjectType:
    | 'user'
    | 'deposit'
    | 'setting'
    | 'giftcard'
    | 'kyc'
    | 'staff'
    | 'provider_credential'
    | 'risk_signal'
    | 'risk_case'
    | 'card'
    | 'dispute'
    | 'data_request';
  readonly subjectId: string;
  readonly detail?: Record<string, unknown>;
  readonly reason?: string;
  readonly ip?: string;
}

@Injectable()
export class AuditService {
  constructor(@Inject(DATABASE) private readonly pool: Pool) {}

  async record(entry: AuditEntry): Promise<void> {
    // The actor arrives as a UUID (that is what an access token carries) and
    // the column is the numeric id. Resolving it in the INSERT rather than in
    // a separate round trip also means an unknown actor writes no row at all,
    // instead of writing one attributed to nobody.
    await this.pool.query(
      `INSERT INTO admin_audit_log
         (actor_id, action, subject_type, subject_id, detail, reason, ip_address)
       SELECT u.id, $2, $3, $4, $5::jsonb, $6, $7::inet
         FROM users u WHERE u.uuid = $1::uuid`,
      [
        entry.actorId,
        entry.action,
        entry.subjectType,
        entry.subjectId,
        // NEVER secrets. The redaction rule that applies to logs applies here
        // with more force: this table is append-only and cannot be scrubbed.
        JSON.stringify(entry.detail ?? {}),
        entry.reason ?? null,
        entry.ip ?? null,
      ],
    );
  }

  async list(options: {
    readonly limit: number;
    readonly before?: string;
    readonly subjectType?: string;
    readonly subjectId?: string;
  }): Promise<readonly Record<string, unknown>[]> {
    const clauses: string[] = [];
    const params: unknown[] = [];

    if (options.before !== undefined) {
      params.push(options.before);
      clauses.push(`l.id < $${params.length}::bigint`);
    }
    if (options.subjectType !== undefined) {
      params.push(options.subjectType);
      clauses.push(`l.subject_type = $${params.length}`);
    }
    if (options.subjectId !== undefined) {
      params.push(options.subjectId);
      clauses.push(`l.subject_id = $${params.length}`);
    }
    params.push(options.limit);

    const rows = await this.pool.query(
      `SELECT l.id::text, l.uuid, l.action, l.subject_type, l.subject_id,
              l.detail, l.reason, l.created_at, u.email AS actor
         FROM admin_audit_log l
         JOIN users u ON u.id = l.actor_id
        ${clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''}
        ORDER BY l.id DESC
        LIMIT $${params.length}`,
      params,
    );
    return rows.rows as Record<string, unknown>[];
  }
}
