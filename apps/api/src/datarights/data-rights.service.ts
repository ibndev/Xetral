import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { Pool } from 'pg';
import { DATABASE } from '../tokens.js';

/**
 * A customer's right to a copy of their data, and to have it erased.
 *
 * THE EXPORT NAMES EVERY COLUMN, and that is the single most important thing
 * in this file. A generic exporter walking a table list is a data-exfiltration
 * primitive: add a table holding a sealed BVN or a token hash and it ships in
 * the next export, and nothing fails. Every query below is written out, so a
 * new table reaches a customer's export only when somebody decides it should.
 *
 * NOTHING SECRET IS IN IT. No password hash, no PIN hash, no sealed BVN, no
 * refresh token, no card number — an export is a bearer document the moment it
 * is downloaded, and the point of hashing a PIN is undone by mailing it back.
 * `data-rights.e2e.test.ts` scans a real export for each of those and fails.
 *
 * ERASURE IS A REQUEST, NOT AN ACTION, because two laws pull opposite ways:
 * AML requires five years of records after a relationship ends and the NDPA
 * forbids keeping personal data longer than needed. Granting it fully would
 * delete the financial record a regulator can demand; refusing it fully treats
 * a legal right as an inconvenience. So what can lawfully go, goes — and what
 * must be kept is named, with why.
 */
@Injectable()
export class DataRightsService {
  readonly #logger = new Logger(DataRightsService.name);

  constructor(@Inject(DATABASE) private readonly pool: Pool) {}

  /**
   * Everything held about this customer that is theirs to see.
   *
   * Assembled in one go rather than paginated: a copy of your data is a
   * document, and a customer who has to page through forty requests to
   * assemble one has not been given it.
   */
  async export(userId: string): Promise<Record<string, unknown>> {
    const [profile, kyc, consents, balances, transactions, cards, devices, signIns, disputes] =
      await Promise.all([
        this.pool.query(
          `SELECT uuid, email, status::text AS status, kyc_tier, created_at
             FROM users WHERE id = $1::bigint`,
          [userId],
        ),
        // The STATUS of identity verification, never its contents. The BVN is
        // sealed and its whole point is that it cannot be read back out; a
        // "your data" export that decrypted it would be the one place it ever
        // came out in the clear. `bvn_last4` is what the customer already
        // typed and already sees.
        this.pool.query(
          `SELECT uuid, status::text AS status, full_name, bvn_last4,
                  rejection_reason, created_at
             FROM kyc_submissions WHERE user_id = $1::bigint ORDER BY id`,
          [userId],
        ),
        this.pool.query(
          `SELECT kind, granted, version, occurred_at, source
             FROM customer_consents WHERE user_id = $1::bigint ORDER BY kind`,
          [userId],
        ),
        this.pool.query(
          `SELECT a.kind::text AS account, a.currency,
                  COALESCE(b.balance_minor, 0)::text AS balance_minor
             FROM accounts a
             LEFT JOIN account_balances b ON b.account_id = a.id
            WHERE a.owner_id = $1::bigint
            ORDER BY a.currency, a.kind`,
          [userId],
        ),
        // Their own leg only, the same rule `history` follows: a transfer is
        // two postings and the other side belongs to somebody else.
        this.pool.query(
          `SELECT e.uuid AS entry_uuid, e.kind::text AS kind, e.description,
                  p.amount_minor::text AS amount_minor, p.currency, e.occurred_at
             FROM postings p
             JOIN accounts a        ON a.id = p.account_id
             JOIN journal_entries e ON e.id = p.journal_entry_id
            WHERE a.owner_id = $1::bigint
            ORDER BY p.id`,
          [userId],
        ),
        // `last4` and nothing else. 003 has no column that could hold a card
        // number, which is what makes that structural rather than a rule
        // somebody keeps — and this query is where it would have been undone.
        this.pool.query(
          `SELECT uuid, last4, status::text AS status, currency, created_at
             FROM cards WHERE user_id = $1::bigint ORDER BY id`,
          [userId],
        ),
        this.pool.query(
          `SELECT uuid, platform, display_name, status::text AS status,
                  first_seen_at, last_seen_at
             FROM devices WHERE user_id = $1::bigint ORDER BY id`,
          [userId],
        ),
        // The addresses are the customer's own, so this is theirs to have.
        // `identifier_hash` is not: it is a hash of whatever was typed, which
        // for a failed attempt is somebody else's guess at an email address.
        this.pool.query(
          `SELECT outcome::text AS outcome, host(ip) AS ip, country, platform, created_at
             FROM sign_in_events WHERE user_id = $1::bigint
            ORDER BY created_at DESC LIMIT 500`,
          [userId],
        ),
        this.pool.query(
          `SELECT uuid, status::text AS status, reason::text AS reason, detail,
                  raised_at, due_at, resolved_at
             FROM disputes WHERE user_id = $1::bigint ORDER BY id`,
          [userId],
        ),
      ]);

    if (profile.rows[0] === undefined) throw new NotFoundException({ error: 'user_not_found' });

    return {
      generated_at: new Date().toISOString(),
      profile: profile.rows[0],
      identity_verification: kyc.rows,
      consents: consents.rows,
      balances: balances.rows,
      transactions: transactions.rows,
      cards: cards.rows,
      devices: devices.rows,
      sign_ins: signIns.rows,
      disputes: disputes.rows,
      /* What is NOT here, said out loud. An export that silently omits things
         is indistinguishable from one that is complete, and a customer
         checking whether we hold their BVN deserves an answer rather than an
         absence. */
      not_included: [
        'Your password and transaction PIN are stored as one-way hashes and cannot be read by anyone, including us.',
        'Your BVN is stored encrypted and is never decrypted for an export. The last four digits are shown above.',
        'Card numbers are never stored. They are fetched from our card provider when you ask to see one, and not kept.',
      ],
    };
  }

  /**
   * Asks for a copy, or for erasure.
   *
   * The record exists so "we responded within the statutory window" is a claim
   * somebody can check. The deadline comes from the database's clock and
   * cannot be supplied — the rule 018 applies to a dispute and 028 to a
   * reporting window.
   */
  async request(userId: string, kind: 'export' | 'erasure'): Promise<Record<string, unknown>> {
    try {
      const inserted = await this.pool.query(
        `INSERT INTO data_requests (user_id, kind, deadline_at)
         VALUES ($1::bigint, $2::data_request_kind, now())
         RETURNING uuid, kind::text AS kind, status::text AS status,
                   requested_at, deadline_at`,
        [userId, kind],
      );
      const row = inserted.rows[0] as Record<string, unknown>;
      this.#logger.log(`data ${kind} requested by user ${userId}`);
      return row;
    } catch (error) {
      if (isUniqueViolation(error)) {
        // Not an error to hide: a customer who asked twice should be told
        // their first request is still open, with its deadline, rather than
        // left wondering whether either arrived.
        throw new ConflictException({ error: 'request_already_open' });
      }
      throw error;
    }
  }

  async requestsFor(userId: string): Promise<readonly Record<string, unknown>[]> {
    const rows = await this.pool.query(
      `SELECT uuid, kind::text AS kind, status::text AS status,
              requested_at, deadline_at, completed_at, outcome
         FROM data_requests WHERE user_id = $1::bigint ORDER BY id DESC`,
      [userId],
    );
    return rows.rows as Record<string, unknown>[];
  }

  /** The queue, worst first. A statutory window is one of the few deadlines
   *  here whose consequence is regulatory rather than an unhappy customer. */
  async due(): Promise<readonly Record<string, unknown>[]> {
    const rows = await this.pool.query(`SELECT * FROM data_requests_due LIMIT 200`);
    return rows.rows as Record<string, unknown>[];
  }

  /** What can lawfully be erased, and what cannot, with the reason. Read from
   *  `retention_decisions` — the same table the deletion sweep reads — so the
   *  promise made to a customer and the job that keeps it cannot describe
   *  different systems. */
  async scope(): Promise<readonly Record<string, unknown>[]> {
    const rows = await this.pool.query(
      `SELECT table_name, scope, rationale FROM erasure_scope WHERE scope <> 'follows_parent'`,
    );
    return rows.rows as Record<string, unknown>[];
  }

  /**
   * Carries out an erasure a reviewer has decided on.
   *
   * A HUMAN DECIDES, and there is deliberately no automatic path: the balance
   * and open-case checks below are refusals rather than a workflow, and
   * somebody has to read what is being asked before data is destroyed. This is
   * the one action in the system that cannot be undone by appending.
   */
  async completeErasure(
    requestUuid: string,
    reviewerUuid: string,
  ): Promise<Record<string, unknown>> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const found = await client.query<{ id: string; user_id: string; kind: string }>(
        `SELECT id, user_id, kind::text AS kind FROM data_requests
          WHERE uuid = $1 AND status = 'open' FOR UPDATE`,
        [requestUuid],
      );
      const row = found.rows[0];
      if (row === undefined) throw new NotFoundException({ error: 'request_not_found' });
      if (row.kind !== 'erasure') {
        throw new BadRequestException({ error: 'not_an_erasure_request' });
      }

      let erased: string;
      try {
        const result = await client.query<{ erase_customer_personal_data: string }>(
          `SELECT erase_customer_personal_data($1::bigint)`,
          [row.user_id],
        );
        erased = result.rows[0]?.erase_customer_personal_data ?? '';
      } catch (error) {
        if (isRestrictViolation(error)) {
          // The database's message is deliberately the same whether the block
          // is a balance or an open investigation, and it is passed through
          // unchanged. Distinguishing them here would reintroduce, one layer
          // up, exactly the tipping-off the schema avoided.
          throw new UnprocessableEntityException({ error: 'erasure_blocked' });
        }
        throw error;
      }

      const retained = await client.query<{ table_name: string; rationale: string }>(
        `SELECT table_name, rationale FROM erasure_scope WHERE scope = 'retained'
          ORDER BY table_name`,
      );

      /* The outcome a customer receives, and the only part of this a regulator
         can inspect. It names what went AND what stayed — an answer that only
         listed the deletions would read as a complete erasure, which this
         deliberately is not. */
      const outcome =
        `Erased: ${erased}. ` +
        `Retained under anti-money-laundering law and our published retention ` +
        `policy: your transaction records and identity verification. These are ` +
        `deleted automatically when their retention period ends. ` +
        `(${retained.rowCount ?? 0} categories retained.)`;

      const updated = await client.query(
        `UPDATE data_requests
            SET status = 'completed', completed_at = now(), handled_by = $2::bigint,
                outcome = $3
          WHERE id = $1::bigint
          RETURNING uuid, status::text AS status, completed_at, outcome`,
        // `claims.sub` is a UUID, never the numeric id — the mistake that once
        // made the entire staff surface answer 500.
        [row.id, await this.userIdOf(reviewerUuid), outcome],
      );

      await client.query('COMMIT');
      this.#logger.log(`erasure completed for request ${requestUuid}`);
      return updated.rows[0] as Record<string, unknown>;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /** Closes a request that was answered some other way — an export sent, or a
   *  refusal with its reason. The reason is required by CHECK, because a queue
   *  cleared with one-word outcomes is indistinguishable from one nobody
   *  worked. */
  async resolve(
    requestUuid: string,
    reviewerUuid: string,
    status: 'completed' | 'refused',
    outcome: string,
  ): Promise<Record<string, unknown>> {
    const updated = await this.pool.query(
      `UPDATE data_requests
          SET status = $3::data_request_status, completed_at = now(),
              handled_by = $2::bigint, outcome = $4
        WHERE uuid = $1 AND status = 'open'
        RETURNING uuid, status::text AS status, completed_at, outcome`,
      [requestUuid, await this.userIdOf(reviewerUuid), status, outcome],
    );
    const row = updated.rows[0];
    if (row === undefined) throw new NotFoundException({ error: 'request_not_found' });
    return row as Record<string, unknown>;
  }

  async userIdOf(uuid: string): Promise<string> {
    const rows = await this.pool.query<{ id: string }>(`SELECT id FROM users WHERE uuid = $1`, [
      uuid,
    ]);
    const row = rows.rows[0];
    if (row === undefined) throw new NotFoundException({ error: 'user_not_found' });
    return row.id;
  }
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505';
}

function isRestrictViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23001';
}
