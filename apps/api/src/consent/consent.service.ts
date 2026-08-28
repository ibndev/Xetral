import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { DATABASE } from '../tokens.js';

/**
 * What a customer agreed to, and when.
 *
 * THE PROOF IS THE PRODUCT. A consent that cannot be demonstrated later is
 * not consent, so nothing here updates a row: granting appends, withdrawing
 * appends, and the current position is a view over the history. The table is
 * evidence, which is a different thing from state.
 *
 * The kinds are not equivalent and are deliberately not treated as though
 * they were. Agreeing to the terms is how an account exists; agreeing to a
 * mailing list is separate, specific, and withdrawable in one call.
 */
export type ConsentKind = 'terms' | 'privacy' | 'marketing_email';

export interface ConsentView {
  readonly kind: string;
  readonly granted: boolean;
  readonly version: string;
  readonly occurred_at: string;
  /** Whether the version they agreed to is the one currently published. False
   *  means the document has been republished since — they agreed to different
   *  words, and asking again is the only honest way to have consent. */
  readonly covers_current: boolean;
}

export interface ConsentDocumentView {
  readonly kind: string;
  readonly version: string;
  readonly summary: string;
  /** Whether this customer has a live grant covering it. */
  readonly agreed: boolean;
}

/** Where the answer came from, and on what. Nullable throughout: a request we
 *  cannot place must not be refused, because an absent address is a weaker
 *  record and no record at all is none. */
export interface ConsentContext {
  readonly ip?: string | undefined;
  readonly userAgent?: string | undefined;
}

@Injectable()
export class ConsentService {
  readonly #logger = new Logger(ConsentService.name);

  constructor(@Inject(DATABASE) private readonly pool: Pool) {}

  /**
   * Records agreement to every document that opening an account requires.
   *
   * ON THE REGISTRATION'S OWN TRANSACTION, so an account cannot exist without
   * the record and the record cannot exist without the account. Written apart,
   * a crash in the gap leaves a customer whose consent we cannot show — and
   * that is exactly the customer somebody will ask about.
   *
   * MARKETING IS NOT IN THIS LIST, and cannot be: the source is
   * `registration`, which a CHECK refuses to pair with a marketing consent.
   * Bundling a mailing list into "create account" is not consent to the
   * mailing list, whatever the button said.
   */
  async recordRegistration(
    client: PoolClient,
    userId: string,
    context: ConsentContext,
  ): Promise<void> {
    await client.query(
      `INSERT INTO consent_records
         (user_id, document_id, kind, granted, source, ip, user_agent)
       SELECT $1::bigint, d.id, d.kind, TRUE, 'registration', $2::inet, $3
         FROM consent_documents d
        WHERE d.retired_at IS NULL AND d.kind <> 'marketing_email'`,
      [userId, context.ip ?? null, context.userAgent ?? null],
    );
  }

  /** What this customer has answered, and what is currently published. */
  async forUser(userId: string): Promise<{
    readonly consents: readonly ConsentView[];
    readonly documents: readonly ConsentDocumentView[];
  }> {
    const [current, documents] = await Promise.all([
      this.pool.query<{
        kind: string;
        granted: boolean;
        version: string;
        occurred_at: Date;
        covers_current: boolean;
      }>(
        `SELECT kind, granted, version, occurred_at, covers_current
           FROM customer_consents WHERE user_id = $1::bigint ORDER BY kind`,
        [userId],
      ),
      this.pool.query<{ kind: string; version: string; summary: string; agreed: boolean }>(
        `SELECT d.kind::TEXT AS kind, d.version, d.summary,
                EXISTS (
                  SELECT 1 FROM consent_records r
                   WHERE r.user_id = $1::bigint AND r.document_id = d.id AND r.granted
                     AND r.id = (SELECT max(r2.id) FROM consent_records r2
                                  WHERE r2.user_id = r.user_id AND r2.kind = r.kind)
                ) AS agreed
           FROM consent_documents d
          WHERE d.retired_at IS NULL
          ORDER BY d.kind`,
        [userId],
      ),
    ]);

    return {
      consents: current.rows.map((row) => ({
        kind: row.kind,
        granted: row.granted,
        version: row.version,
        occurred_at: row.occurred_at.toISOString(),
        covers_current: row.covers_current,
      })),
      documents: documents.rows,
    };
  }

  /**
   * Grants or withdraws, against whatever is currently published.
   *
   * WITHDRAWING IS THE SAME CALL AS GRANTING, with no transaction PIN and no
   * confirmation step. That is a requirement, not a convenience: consent that
   * is harder to withdraw than to give is not freely given. It is also why
   * this route does not sit behind the PIN — a customer who cannot remember
   * their PIN must still be able to stop the email.
   *
   * The terms and the privacy notice are refused a withdrawal here, by CHECK,
   * and the refusal is honest rather than obstructive: withdrawing them means
   * closing the account, which moves money and has its own path.
   */
  async record(
    userId: string,
    kind: ConsentKind,
    granted: boolean,
    context: ConsentContext,
  ): Promise<ConsentView> {
    if (!granted && kind !== 'marketing_email') {
      throw new BadRequestException({ error: 'consent_not_withdrawable' });
    }

    const document = await this.pool.query<{ id: string }>(
      `SELECT id FROM consent_documents
        WHERE kind = $1::consent_kind AND retired_at IS NULL`,
      [kind],
    );
    const documentId = document.rows[0]?.id;
    if (documentId === undefined) {
      // Nothing published to agree TO. Refusing is the only honest answer:
      // recording agreement to a document that does not exist would be
      // evidence of nothing.
      throw new BadRequestException({ error: 'consent_document_missing' });
    }

    const inserted = await this.pool.query<{
      granted: boolean;
      version: string;
      occurred_at: Date;
    }>(
      `INSERT INTO consent_records
         (user_id, document_id, kind, granted, source, ip, user_agent)
       VALUES ($1::bigint, $2::bigint, $3::consent_kind, $4, 'settings', $5::inet, $6)
       RETURNING granted, occurred_at,
                 (SELECT version FROM consent_documents WHERE id = $2::bigint) AS version`,
      [userId, documentId, kind, granted, context.ip ?? null, context.userAgent ?? null],
    );

    const row = inserted.rows[0];
    if (row === undefined) throw new Error('consent insert returned no row');

    this.#logger.log(`consent ${granted ? 'granted' : 'withdrawn'}: ${kind} for user ${userId}`);
    return {
      kind,
      granted: row.granted,
      version: row.version,
      occurred_at: row.occurred_at.toISOString(),
      covers_current: true,
    };
  }

  /** `claims.sub` is a UUID, never the numeric id — the mistake that once
   *  made the entire staff surface answer 500. */
  async userIdOf(uuid: string): Promise<string> {
    const rows = await this.pool.query<{ id: string }>(`SELECT id FROM users WHERE uuid = $1`, [
      uuid,
    ]);
    const row = rows.rows[0];
    if (row === undefined) throw new NotFoundException({ error: 'user_not_found' });
    return row.id;
  }

  /**
   * Who has not agreed to the words currently in force.
   *
   * Fills up the moment a notice is republished, which is the point: a change
   * nobody was asked about is a change nobody agreed to, and the only other
   * evidence of that is an absence nobody thinks to query.
   */
  async outstanding(limit: number): Promise<readonly Record<string, unknown>[]> {
    const rows = await this.pool.query(
      `SELECT uuid, email, kind, version, published_at
         FROM consent_outstanding ORDER BY published_at DESC, uuid LIMIT $1`,
      [limit],
    );
    return rows.rows as Record<string, unknown>[];
  }

  /** How many, per document. The number an operator watches after publishing
   *  a new version, and the one that says whether anybody is being asked. */
  async outstandingSummary(): Promise<readonly Record<string, unknown>[]> {
    const rows = await this.pool.query(
      `SELECT kind, version, count(*)::text AS customers
         FROM consent_outstanding GROUP BY kind, version ORDER BY kind`,
    );
    return rows.rows as Record<string, unknown>[];
  }
}
