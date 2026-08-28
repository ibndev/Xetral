import { Inject, Injectable, Logger, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import {
  WeakPasswordError,
  assertPasswordPolicy,
  hashPassword,
  hashPasswordResetToken,
  issuePasswordResetToken,
} from '@xetral/identity';
import type { PasswordResetOutcome } from '@xetral/identity';
import { API_CONFIG, DATABASE } from '../tokens.js';
import type { ApiConfig } from '../config.js';
import { NotificationService } from '../notifications/notification.service.js';

/**
 * Forgetting a password, and getting back in.
 *
 * THE PROPERTY THIS SERVICE EXISTS TO PRESERVE: a caller must not be able to
 * learn whether an email address has a Xetral account. That is not a
 * theoretical concern — an endpoint that answers differently for a known and
 * an unknown address turns any address list into a customer list, and a
 * customer list for a Nigerian fintech is worth money to exactly the people
 * who send phishing SMS.
 *
 * Keeping that property costs three specific things, and each of them looks
 * like a bug to somebody reading the code quickly:
 *
 *  1. `POST /forgot` answers 204 for every syntactically valid address, real
 *     or not.
 *  2. It does the SAME WORK either way — a token is minted and hashed even
 *     when there is nobody to send it to — so the two paths do not differ in
 *     the time they take.
 *  3. It logs the failure to find an account, and returns nothing about it.
 */

const INVALID_GRANT = { error: 'invalid_grant' } as const;
const WEAK_PASSWORD = { error: 'weak_password' } as const;
const RESET_UNAVAILABLE = { error: 'password_reset_unavailable' } as const;

interface ResetTargetRow {
  id: string;
  email: string | null;
  status: string;
}

@Injectable()
export class PasswordResetService {
  readonly #logger = new Logger(PasswordResetService.name);

  constructor(
    @Inject(DATABASE) private readonly pool: Pool,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(NotificationService) private readonly notifications: NotificationService,
  ) {}

  /**
   * Start a reset. Always succeeds, from the caller's point of view.
   *
   * The token row and the outbox row are written in ONE transaction. That is
   * what makes "we told you to check your email" true: a commit means both
   * exist, and a rollback means neither does. Writing the token first and
   * enqueueing after would leave a live credential for an email that was never
   * sent — the worst of both, since it can still be found in a database dump.
   */
  async request(identifier: string, ipAddress: string | undefined): Promise<void> {
    if (!this.available) {
      // Refused up front rather than silently accepted. Answering 204 with no
      // way to send anything would be the one case where the enumeration-safe
      // response becomes an outright lie to every customer, including the ones
      // who do have an account.
      throw new ServiceUnavailableException(RESET_UNAVAILABLE);
    }

    // Minted BEFORE the lookup and unconditionally. Doing this work only when
    // an account exists is the timing difference the whole design is trying to
    // avoid — and it is the version somebody writes when tidying up.
    const issued = issuePasswordResetToken();

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const user = await this.#findTarget(client, identifier);

      if (user === undefined || user.email === null || user.status === 'closed') {
        await client.query('ROLLBACK');
        // Logged, never returned. An operator investigating a spike needs to
        // see this; the caller must not.
        this.#logger.warn(`password reset requested for an address with no live account`);
        return;
      }

      await client.query(
        `INSERT INTO password_reset_tokens (user_id, token_hash, requested_ip, expires_at)
         VALUES ($1::bigint, $2, $3, now() + make_interval(mins => $4::int))`,
        [user.id, issued.hash, ipAddress ?? null, this.config.passwordResetTtlMinutes],
      );

      await this.notifications.enqueue(client, {
        userId: user.id,
        recipient: user.email,
        // Keyed on the TOKEN HASH, not on the user or the minute. Two requests
        // seconds apart are two different reset links and both must be sent —
        // the customer may only ever see one of the emails. Keying on the user
        // would silently drop the second.
        idempotencyKey: `password_reset:${issued.hash}`,
        request: {
          kind: 'password_reset',
          resetUrl: this.#resetUrl(issued.token),
          expiresInMinutes: this.config.passwordResetTtlMinutes,
        },
      });

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Finish a reset.
   *
   * The password policy is checked BEFORE the token is spent. A customer whose
   * new password is too short should get another go with the link they are
   * holding, rather than having it consumed by a request that changed nothing.
   */
  async reset(token: string, newPassword: string): Promise<void> {
    try {
      assertPasswordPolicy(newPassword);
    } catch (error) {
      if (error instanceof WeakPasswordError) {
        throw new UnauthorizedException({ ...WEAK_PASSWORD, message: error.message });
      }
      throw error;
    }

    const passwordHash = await hashPassword(newPassword);

    // Everything else — spending the token, killing the sibling tokens,
    // setting the credential, revoking every session — happens inside
    // `consume_password_reset_token`, in one transaction. See the header of
    // 013_password_reset.sql for why that is not service code.
    const result = await this.pool.query<{
      out_outcome: PasswordResetOutcome;
      out_user_id: string | null;
    }>(`SELECT out_outcome, out_user_id FROM consume_password_reset_token($1, $2)`, [
      hashPasswordResetToken(token),
      passwordHash,
    ]);

    const row = result.rows[0];
    if (row === undefined || row.out_outcome !== 'consumed') {
      // ONE response for all three failures. Distinguishing "expired" from
      // "never existed" would tell a prober which of their guesses was a real
      // token, which is the only information they were missing.
      this.#logger.warn(`password reset refused: ${row?.out_outcome ?? 'no result'}`);
      throw new UnauthorizedException(INVALID_GRANT);
    }

    const userId = row.out_user_id;
    if (userId === null) return;

    // Best effort, and detached: the reset has already committed and must not
    // be undone because a confirmation email could not be queued.
    await this.#confirm(userId);
  }

  /** Tell the customer their password changed — the alert that matters if it
   *  was not them who changed it. */
  async #confirm(userId: string): Promise<void> {
    const target = await this.pool.query<{ email: string | null }>(
      `SELECT email FROM users WHERE id = $1::bigint`,
      [userId],
    );
    const email = target.rows[0]?.email;
    if (email === null || email === undefined) return;

    await this.notifications.enqueueDetached({
      userId,
      recipient: email,
      // The clock is part of the key, to the minute. A second reset an hour
      // later is a second confirmation; a duplicated request within the same
      // minute is not.
      idempotencyKey: `password_changed:${userId}:${new Date().toISOString().slice(0, 16)}`,
      request: { kind: 'password_changed', at: lagosTime() },
    });
  }

  /**
   * `deliverable`, not `available`.
   *
   * Enqueueing works with a keyring alone, so the weaker check let this
   * endpoint answer 204 on a deployment with no email provider — telling a
   * locked-out customer to check an inbox nothing was ever going to arrive in.
   * Found by booting the built bundle and calling it, which is the fifth time
   * that has been the thing that found something here.
   */
  get available(): boolean {
    return this.notifications.deliverable && this.config.appBaseUrl !== undefined;
  }

  #resetUrl(token: string): string {
    // The origin comes from configuration and NEVER from a request header. A
    // `Host` or `X-Forwarded-Host` an attacker controls would turn our own
    // reset email into a credential harvester carrying our branding — the
    // classic host-header poisoning attack, and this flow is its textbook
    // target.
    const base = this.config.appBaseUrl ?? '';
    return `${base}/reset-password?token=${encodeURIComponent(token)}`;
  }

  async #findTarget(client: PoolClient, identifier: string): Promise<ResetTargetRow | undefined> {
    const result = await client.query<ResetTargetRow>(
      `SELECT id, email, status FROM users
        WHERE lower(email) = lower($1) OR phone = $1
        LIMIT 1`,
      [identifier],
    );
    return result.rows[0];
  }
}

/** Lagos, because that is the clock the customer reading the email is on. A
 *  UTC timestamp in a security alert makes a Nigerian customer do arithmetic
 *  to decide whether the sign-in was theirs. */
function lagosTime(): string {
  return new Intl.DateTimeFormat('en-NG', {
    timeZone: 'Africa/Lagos',
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date());
}

export { lagosTime };
