import { Inject, Injectable, Logger, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import {
  WeakPasswordError,
  assertPasswordPolicy,
  hashPassword,
  hashPasswordResetCode,
  issuePasswordResetCode,
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
const TOO_MANY_ATTEMPTS = { error: 'reset_code_attempts' } as const;

/**
 * HOW MANY WRONG CODES BEFORE EVERY LIVE ONE IS BURNT.
 *
 * Five, which is the number the transaction PIN already uses — the same
 * judgement about how many times a real person mistypes six digits, and one a
 * customer has met before. Against a million values it leaves an attacker a
 * one-in-two-hundred-thousand chance per issued code, and asking for another
 * costs them the per-identifier rate limit on `/forgot`.
 *
 * A CONSTANT RATHER THAN A SETTING, deliberately. A `platform_settings` row is
 * for an operational decision somebody takes under pressure — a fee, a kill
 * switch — and the pressure here always points one way: a customer is locked
 * out and on the phone. This is the number that makes a short code safe at
 * all, and it should take a release to change.
 */
const MAX_CODE_ATTEMPTS = 5;

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

    /*
     * A CODE IS MINTED BEFORE THE LOOKUP AND UNCONDITIONALLY, against a
     * placeholder id. Doing this work only when an account exists is the
     * timing difference the whole design is trying to avoid — and it is
     * exactly the version somebody writes when tidying up. It is re-minted
     * against the real id below, because the id is part of what is signed.
     */
    let issued = issuePasswordResetCode('0', this.config.accessTokenKeyring.current.secret);

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

      issued = issuePasswordResetCode(user.id, this.config.accessTokenKeyring.current.secret);

      await client.query(
        `INSERT INTO password_reset_tokens (user_id, token_hash, requested_ip, expires_at)
         VALUES ($1::bigint, $2, $3, now() + make_interval(mins => $4::int))`,
        [user.id, issued.hash, ipAddress ?? null, this.config.passwordResetTtlMinutes],
      );

      await this.notifications.enqueue(client, {
        userId: user.id,
        recipient: user.email,
        // Keyed on the CODE'S HASH, not on the user or the minute. Two
        // requests seconds apart are two different codes and both must be
        // sent — the customer may only ever see one of the emails. Keying on
        // the user would silently drop the second.
        idempotencyKey: `password_reset:${issued.hash}`,
        request: {
          kind: 'password_reset',
          code: issued.code,
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
   * TAKES THE IDENTIFIER AS WELL AS THE CODE, and that pair is what makes six
   * digits safe. A code on its own would be a guess against every account at
   * once — a million tries lands somewhere — where a code beside one
   * identifier is a guess against one account, under a ceiling.
   *
   * The password policy is checked BEFORE the code is spent. A customer whose
   * new password is too short should get another go with the code they are
   * holding, rather than having it consumed by a request that changed nothing.
   */
  async reset(identifier: string, code: string, newPassword: string): Promise<void> {
    try {
      assertPasswordPolicy(newPassword);
    } catch (error) {
      if (error instanceof WeakPasswordError) {
        throw new UnauthorizedException({ ...WEAK_PASSWORD, message: error.message });
      }
      throw error;
    }

    const passwordHash = await hashPassword(newPassword);

    const client = await this.pool.connect();
    let user: ResetTargetRow | undefined;
    try {
      user = await this.#findTarget(client, identifier);
    } finally {
      client.release();
    }

    if (user === undefined) {
      // THE SAME REFUSAL AS A WRONG CODE. Answering differently for an address
      // with no account would turn this endpoint into the account-enumeration
      // oracle that `/forgot` goes to such lengths not to be.
      this.#logger.warn('password reset presented for an address with no account');
      throw new UnauthorizedException(INVALID_GRANT);
    }

    /*
     * NON-DIGITS STRIPPED BEFORE HASHING. A code arrives out of an email with
     * a space in the middle, or carrying whatever a mail client wrapped the
     * line in. Refusing that is refusing a customer for their mail client's
     * formatting, on the flow they reach when they have nothing else left.
     */
    const digits = code.replace(/[^0-9]/g, '');

    // Everything else — spending the code, counting the guess, killing the
    // sibling codes, setting the credential, revoking every session — happens
    // inside `consume_password_reset_code`, in one transaction. See the header
    // of 056_reset_codes.sql for why that is not service code.
    const result = await this.pool.query<{
      out_outcome: PasswordResetOutcome;
      out_user_id: string | null;
    }>(`SELECT out_outcome, out_user_id FROM consume_password_reset_code($1::bigint, $2, $3, $4)`, [
      user.id,
      hashPasswordResetCode(user.id, digits, this.config.accessTokenKeyring.current.secret),
      passwordHash,
      MAX_CODE_ATTEMPTS,
    ]);

    const row = result.rows[0];
    if (row?.out_outcome === 'too_many_attempts') {
      /*
       * SAID OUT LOUD, unlike the other three refusals.
       *
       * "Expired" and "never existed" must stay indistinguishable, because
       * telling somebody which way their guess failed tells them whether it
       * was ever real. This one tells an attacker only what they already know
       * — they have been guessing — and tells the REAL customer the one thing
       * that gets them out of the loop: ask for a new code, because retyping
       * this one will never work again.
       */
      this.#logger.warn('password reset refused: the attempt ceiling was reached');
      throw new UnauthorizedException(TOO_MANY_ATTEMPTS);
    }

    if (row === undefined || row.out_outcome !== 'consumed') {
      // ONE response for the rest. Distinguishing "expired" from "never
      // existed" would tell a prober which of their guesses was a real code,
      // which is the only information they were missing.
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
   *
   * IT NO LONGER ASKS FOR `APP_BASE_URL`, and that is the point of the whole
   * change. A link needs an address; a CODE does not. This condition refusing
   * on an unset deployment value is what put "Password resets are unavailable
   * right now. Contact support." in front of customers — on the one flow whose
   * entire premise is that they have nothing left to contact support with.
   */
  get available(): boolean {
    return this.notifications.deliverable;
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
