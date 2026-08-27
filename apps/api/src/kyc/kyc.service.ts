import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { Pool } from 'pg';
import { blindIndex, seal } from '@xetral/identity';
import type { BlindIndexKey, Keyring } from '@xetral/identity';
import { API_CONFIG, DATABASE } from '../tokens.js';
import type { ApiConfig } from '../config.js';
import { AuditService } from '../admin/audit.service.js';
import type { KycBody } from './dto.js';

/**
 * Knowing who a customer is.
 *
 * THE GAP THIS CLOSES. `provider_customers` has gated cards, NGN funding and
 * crypto addresses since Phase 5, and nothing wrote to it — so every real
 * customer was permanently refused with `kyc_required` and the platform could
 * not take a single deposit. This is the path that fills it.
 *
 * Approval is what registers the customer with the provider, and that ordering
 * is deliberate: `provider_customers` is a record that a human checked
 * somebody's identity documents, not a row created as a side effect of
 * somebody tapping "add money".
 */

export interface KycView {
  readonly id: string;
  readonly status: string;
  readonly full_name: string;
  readonly bvn_last4: string;
  readonly rejection_reason: string | null;
  readonly created_at: string;
}

interface KycRow {
  id: string;
  uuid: string;
  user_id: string;
  status: string;
  full_name: string;
  bvn_last4: string;
  rejection_reason: string | null;
  created_at: string;
}

/** Nigeria's regulatory minimum for an account holder. */
const MINIMUM_AGE_YEARS = 18;

@Injectable()
export class KycService {
  readonly #logger = new Logger(KycService.name);

  constructor(
    @Inject(DATABASE) private readonly pool: Pool,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  /** What the customer sees about their own verification. */
  async mine(userUuid: string): Promise<KycView | null> {
    const userId = await this.#userId(userUuid);
    const rows = await this.pool.query<KycRow>(
      `${SELECT_KYC} WHERE user_id = $1::bigint ORDER BY id DESC LIMIT 1`,
      [userId],
    );
    const row = rows.rows[0];
    return row === undefined ? null : toView(row);
  }

  async submit(userUuid: string, body: KycBody): Promise<KycView> {
    const userId = await this.#userId(userUuid);

    const dob = new Date(`${body.date_of_birth}T00:00:00Z`);
    if (Number.isNaN(dob.getTime())) {
      throw new BadRequestException({ error: 'invalid_request', fields: ['date_of_birth'] });
    }
    if (ageInYears(dob) < MINIMUM_AGE_YEARS) {
      // Refused here rather than at review, so an underage applicant is not
      // asked to hand over a BVN we would then be holding for no purpose.
      throw new BadRequestException({ error: 'below_minimum_age' });
    }

    const existing = await this.pool.query<{ status: string }>(
      `SELECT status FROM kyc_submissions
        WHERE user_id = $1::bigint AND status IN ('pending','approved')`,
      [userId],
    );
    const open = existing.rows[0];
    if (open !== undefined) {
      throw new ConflictException({
        error: open.status === 'approved' ? 'already_verified' : 'review_in_progress',
      });
    }

    const inserted = await this.pool.query<KycRow>(
      `INSERT INTO kyc_submissions
         (user_id, full_name, date_of_birth, phone, bvn_sealed, bvn_last4, address,
          bvn_fingerprint)
       VALUES ($1::bigint, $2, $3::date, $4, $5, $6, $7, $8)
       RETURNING id, uuid, user_id, status::text, full_name, bvn_last4,
                 rejection_reason, created_at`,
      [
        userId,
        body.full_name,
        body.date_of_birth,
        body.phone,
        // Sealed before it reaches a row. The CHECK on the column refuses a
        // plaintext BVN outright, so this cannot be forgotten.
        seal(body.bvn, this.#keyring()),
        body.bvn.slice(-4),
        body.address,
        // Deterministic and keyed, so two accounts on one BVN collide in the
        // unique index while nobody reading this table learns a BVN. The
        // sealed column cannot do this job: its IV is random, so one BVN
        // sealed twice is two different strings.
        blindIndex(body.bvn, this.#blindIndexKey()),
      ],
    );

    const row = inserted.rows[0];
    if (row === undefined) throw new Error('kyc insert returned no row');
    return toView(row);
  }

  /* ------------------------------ review ------------------------------- */

  async queue(limit: number): Promise<readonly Record<string, unknown>[]> {
    const rows = await this.pool.query(
      // `uuid AS id`, because every other view this service returns calls it
      // `id` and a reviewer's Approve button posts to `/kyc/<id>/review`. It
      // was bare `uuid`, so the id was undefined at the call site and the
      // request went to a path that matched no route — a queue that listed
      // submissions perfectly and could not review any of them.
      `SELECT k.uuid AS id, k.full_name, k.bvn_last4, k.phone, k.address,
              k.date_of_birth, k.created_at, u.email
         FROM kyc_submissions k JOIN users u ON u.id = k.user_id
        WHERE k.status = 'pending'
        ORDER BY k.created_at
        LIMIT $1`,
      [limit],
    );
    return rows.rows as Record<string, unknown>[];
  }

  /**
   * Approving is what creates the provider identity.
   *
   * Both writes are one transaction. A submission marked approved with no
   * `provider_customers` row would leave the customer verified on our side and
   * still refused by every provider-backed route — the exact failure this
   * whole path exists to remove, reintroduced by a crash between two
   * statements.
   */
  async approve(submissionUuid: string, reviewerUuid: string, ip?: string): Promise<KycView> {
    const reviewerId = await this.#userId(reviewerUuid);
    const row = await this.#byUuid(submissionUuid);

    if (row.status !== 'pending') {
      throw new ConflictException({ error: 'already_reviewed', status: row.status });
    }
    // Also a CHECK in the schema. Refused here too so the reviewer gets an
    // explanation rather than a constraint violation.
    if (row.user_id === reviewerId) {
      throw new ForbiddenException({ error: 'cannot_review_own_submission' });
    }

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      await client.query(
        `UPDATE kyc_submissions
            SET status = 'approved', reviewed_by = $2::bigint, reviewed_at = now()
          WHERE id = $1::bigint`,
        [row.id, reviewerId],
      );

      // The provider identity. ON CONFLICT because a resubmission after an
      // earlier approval must not fail on a row that is already correct.
      await client.query(
        `INSERT INTO provider_customers (user_id, provider, provider_customer_id)
         VALUES ($1::bigint, 'bitnob', $2)
         ON CONFLICT (user_id, provider) DO NOTHING`,
        [row.user_id, `xetral-${row.uuid}`],
      );

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      // ONE PERSON, ONE ACCOUNT. `kyc_one_approved_per_bvn` refuses a second
      // approved submission on the same BVN, and it is the database that
      // refuses rather than a check up here — a reviewer working a queue at
      // speed is exactly who a pre-check races. The collision is visible in
      // `kyc_bvn_collisions` before they click; this is what happens if they
      // did not look, or if two reviewers clicked at once.
      if (
        error !== null &&
        typeof error === 'object' &&
        (error as { constraint?: string }).constraint === 'kyc_one_approved_per_bvn'
      ) {
        throw new ConflictException({ error: 'bvn_already_verified' });
      }
      throw error;
    } finally {
      client.release();
    }

    await this.audit.record({
      actorId: reviewerUuid,
      action: 'kyc.approve',
      subjectType: 'kyc',
      subjectId: submissionUuid,
      // The BVN is deliberately absent. This table is append-only.
      detail: { user: row.user_id, bvn_last4: row.bvn_last4 },
      ...(ip === undefined ? {} : { ip }),
    });

    this.#logger.log(`kyc approved for user ${row.user_id} by ${reviewerUuid}`);
    return toView(await this.#byUuid(submissionUuid));
  }

  async reject(
    submissionUuid: string,
    reviewerUuid: string,
    reason: string,
    ip?: string,
  ): Promise<KycView> {
    const reviewerId = await this.#userId(reviewerUuid);
    const row = await this.#byUuid(submissionUuid);

    if (row.status !== 'pending') {
      throw new ConflictException({ error: 'already_reviewed', status: row.status });
    }
    if (row.user_id === reviewerId) {
      throw new ForbiddenException({ error: 'cannot_review_own_submission' });
    }

    await this.pool.query(
      `UPDATE kyc_submissions
          SET status = 'rejected', reviewed_by = $2::bigint, reviewed_at = now(),
              rejection_reason = $3
        WHERE id = $1::bigint`,
      [row.id, reviewerId, reason],
    );

    await this.audit.record({
      actorId: reviewerUuid,
      action: 'kyc.reject',
      subjectType: 'kyc',
      subjectId: submissionUuid,
      reason,
      ...(ip === undefined ? {} : { ip }),
    });

    return toView(await this.#byUuid(submissionUuid));
  }

  /* ------------------------------ helpers ------------------------------ */

  /**
   * REFUSES rather than skipping the fingerprint.
   *
   * The same shape as `#keyring()` above and for the same reason: a submission
   * written without one would slip past `kyc_one_approved_per_bvn`, and
   * nothing anywhere would fail. A control that switches itself off when a
   * configuration value is missing is worse than no control, because it is
   * trusted.
   */
  #blindIndexKey(): BlindIndexKey {
    const key = this.config.kycBlindIndexKey;
    if (key === undefined) {
      throw new ServiceUnavailableException({ error: 'encryption_not_configured' });
    }
    return key;
  }

  #keyring(): Keyring {
    const keyring = this.config.encryptionKeyring;
    if (keyring === undefined) {
      // Refusing beats storing a BVN in the clear.
      throw new ServiceUnavailableException({ error: 'encryption_not_configured' });
    }
    return keyring;
  }

  async #byUuid(uuid: string): Promise<KycRow> {
    const rows = await this.pool.query<KycRow>(`${SELECT_KYC} WHERE uuid = $1`, [uuid]);
    const row = rows.rows[0];
    if (row === undefined) throw new NotFoundException({ error: 'submission_not_found' });
    return row;
  }

  async #userId(uuid: string): Promise<string> {
    const rows = await this.pool.query<{ id: string }>(`SELECT id FROM users WHERE uuid = $1`, [
      uuid,
    ]);
    const row = rows.rows[0];
    if (row === undefined) throw new NotFoundException({ error: 'user_not_found' });
    return row.id;
  }
}

const SELECT_KYC = `
  SELECT id, uuid, user_id, status::text, full_name, bvn_last4,
         rejection_reason, created_at
    FROM kyc_submissions`;

function toView(row: KycRow): KycView {
  return {
    id: row.uuid,
    status: row.status,
    full_name: row.full_name,
    // The BVN itself is never returned, to the customer or to staff. Four
    // digits is enough to confirm which one is on file.
    bvn_last4: row.bvn_last4,
    rejection_reason: row.rejection_reason,
    created_at: row.created_at,
  };
}

function ageInYears(dob: Date): number {
  const now = new Date();
  let age = now.getUTCFullYear() - dob.getUTCFullYear();
  const monthDelta = now.getUTCMonth() - dob.getUTCMonth();
  if (monthDelta < 0 || (monthDelta === 0 && now.getUTCDate() < dob.getUTCDate())) age -= 1;
  return age;
}
