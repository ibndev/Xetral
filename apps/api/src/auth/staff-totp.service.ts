import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import type { Pool } from 'pg';
import {
  generateTotpSecret,
  open,
  otpauthUrl,
  seal,
  verifyTotp,
} from '@xetral/identity';
import { API_CONFIG, CLOCK, DATABASE } from '../tokens.js';
import type { ApiConfig, } from '../config.js';
import type { Clock } from '../tokens.js';

/**
 * The second factor on the operations surface.
 *
 * WHAT THIS PROTECTS. A customer's password protects one balance; a staff
 * password protects every balance. The admin surface approves gift card
 * payouts, attributes suspense deposits to a named person, changes the
 * transfer fee for everybody at once, freezes accounts and grants roles —
 * including its own. That is why the second factor landed here first.
 */

const TOTP_REQUIRED = { error: 'totp_required' } as const;
const TOTP_INVALID = { error: 'invalid_totp' } as const;
const TOTP_LOCKED = { error: 'totp_locked' } as const;
const TOTP_NOT_ENROLLED = { error: 'totp_not_enrolled' } as const;
const TOTP_ALREADY_ENROLLED = { error: 'totp_already_enrolled' } as const;

/**
 * Five failures, then fifteen minutes.
 *
 * Six digits is a million possibilities, which sounds like a lot and is a
 * weekend at any useful request rate. The lockout is what turns the code into
 * a real factor rather than a speed bump; the numbers match the transaction
 * PIN's deliberately, so an operator who hits one recognises the other.
 */
const MAX_ATTEMPTS = 5;
const LOCKOUT_MINUTES = 15;

/**
 * How long one verified code keeps a session elevated.
 *
 * Ten minutes: long enough for an operator to work through a queue of
 * approvals without fighting their authenticator, short enough that a session
 * left open on an unattended laptop is not a standing authorisation to move
 * money. The transaction PIN is still demanded on every acting request inside
 * the window, so this shortens the second factor's reach and never the PIN's.
 */
const ELEVATION_MINUTES = 10;

export interface TotpEnrolment {
  /** Shown once, on screen, and never returned again. */
  readonly secret: string;
  /** What the QR code encodes. snake_case because every other response body
   *  in this API is, and one camelCase exception is how a client ends up
   *  reading `undefined` and rendering an empty QR code. */
  readonly otpauth_url: string;
}

interface TotpRow {
  secret_sealed: string;
  confirmed_at: Date | null;
  failed_attempts: number;
  locked_until: Date | null;
}

@Injectable()
export class StaffTotpService {
  readonly #logger = new Logger(StaffTotpService.name);

  constructor(
    @Inject(DATABASE) private readonly pool: Pool,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Issue a secret, unconfirmed.
   *
   * ENROLMENT IS TWO STEPS, and the second one is not ceremony. A row that was
   * trusted the moment it was written would lock out an operator who scanned
   * nothing, mis-scanned, or scanned into an app on a phone they then wiped —
   * and they would discover it while trying to open the admin surface during
   * whatever made them need it.
   */
  async beginEnrolment(userUuid: string, account: string): Promise<TotpEnrolment> {
    const keyring = this.config.encryptionKeyring;
    if (keyring === undefined) {
      // Fail closed. Storing the secret in the clear to get past this would
      // put the one recoverable credential in the identity schema into a
      // column any SELECT can read.
      throw new ServiceUnavailableException({ error: 'encryption_not_configured' });
    }

    const existing = await this.pool.query<{ confirmed_at: Date | null }>(
      `SELECT t.confirmed_at FROM staff_totp t
         JOIN users u ON u.id = t.user_id
        WHERE u.uuid = $1`,
      [userUuid],
    );
    if (existing.rows[0]?.confirmed_at != null) {
      // Replacing a confirmed factor is an ADMIN action against the account,
      // not something the account holder does with the session they are
      // holding — which is exactly the session an attacker would have. The
      // database refuses it too; this is the readable half.
      throw new ForbiddenException(TOTP_ALREADY_ENROLLED);
    }

    const secret = generateTotpSecret();
    await this.pool.query(
      `INSERT INTO staff_totp (user_id, secret_sealed)
       SELECT id, $2 FROM users WHERE uuid = $1
       ON CONFLICT (user_id) DO UPDATE
         SET secret_sealed = EXCLUDED.secret_sealed,
             failed_attempts = 0,
             locked_until = NULL`,
      [userUuid, seal(secret, keyring)],
    );

    return { secret, otpauth_url: otpauthUrl({ secret, account }) };
  }

  /**
   * Prove the authenticator works, and turn the factor on.
   *
   * Confirming ELEVATES the session too. The operator has just demonstrated
   * possession of the factor — that is the entire content of this request —
   * so making them produce a second code to do the thing they enrolled in
   * order to do would mean waiting out the thirty-second step, because the
   * code they just used is now spent. The trust is identical to any other
   * elevation; only the request that established it differs.
   */
  async confirmEnrolment(userUuid: string, sessionUuid: string, code: string): Promise<void> {
    const row = await this.#row(userUuid);
    if (row === undefined) throw new BadRequestException(TOTP_NOT_ENROLLED);
    if (row.confirmed_at !== null) throw new ForbiddenException(TOTP_ALREADY_ENROLLED);

    await this.#check(userUuid, row, code);

    await this.pool.query(
      `UPDATE staff_totp SET confirmed_at = now(), last_used_at = now()
        WHERE user_id = (SELECT id FROM users WHERE uuid = $1)
          AND confirmed_at IS NULL`,
      [userUuid],
    );
    await this.pool.query(
      `UPDATE auth_sessions SET totp_verified_at = now()
        WHERE uuid = $1 AND revoked_at IS NULL`,
      [sessionUuid],
    );
    this.#logger.log(`second factor confirmed for user ${userUuid}`);
  }

  /** Whether this operator has a working second factor. */
  async isEnrolled(userUuid: string): Promise<boolean> {
    const row = await this.#row(userUuid);
    return row !== undefined && row.confirmed_at !== null;
  }

  /**
   * The guard's entry point: refuse unless this operator has a second factor.
   *
   * Separate from `assertCode` because it applies to READS as well. An
   * operator who has not enrolled cannot use the admin surface at all — which
   * is the only way "staff have a second factor" is a statement about the
   * system rather than about a policy document.
   */
  async assertEnrolled(userUuid: string): Promise<void> {
    if (!(await this.isEnrolled(userUuid))) {
      this.#logger.warn(`user ${userUuid} reached a staff route with no second factor`);
      throw new ForbiddenException(TOTP_NOT_ENROLLED);
    }
  }

  /**
   * The guard's other entry point: this session may act.
   *
   * Already elevated and inside the window — nothing to do. Otherwise a code
   * is required, verified, spent, and the session is elevated.
   *
   * REQUIRING A CODE ON EVERY ACTION WAS THE FIRST SHAPE OF THIS, and it was
   * unusable: codes are single-use and change every thirty seconds, so a
   * reviewer working a queue would be refused on their second approval. The
   * predictable outcome is a shared authenticator on somebody's desk, which is
   * worse than no second factor because it looks like control.
   */
  async assertElevated(
    userUuid: string,
    sessionUuid: string,
    presentedCode: string | undefined,
  ): Promise<void> {
    if (await this.#isElevated(sessionUuid)) return;

    if (presentedCode === undefined) throw new BadRequestException(TOTP_REQUIRED);

    const row = await this.#row(userUuid);
    if (row === undefined || row.confirmed_at === null) {
      throw new ForbiddenException(TOTP_NOT_ENROLLED);
    }
    await this.#check(userUuid, row, presentedCode);

    await this.pool.query(
      `UPDATE staff_totp SET last_used_at = now()
        WHERE user_id = (SELECT id FROM users WHERE uuid = $1)`,
      [userUuid],
    );
    // Elevation is recorded on the SESSION, so revoking the session revokes it
    // — an operator whose access is withdrawn mid-incident does not keep a
    // standing authorisation because they happened to have verified recently.
    await this.pool.query(
      `UPDATE auth_sessions SET totp_verified_at = now()
        WHERE uuid = $1 AND revoked_at IS NULL`,
      [sessionUuid],
    );
  }

  /**
   * Elevate this session, on its own, with a code.
   *
   * THE SURFACE WAS UNREACHABLE WITHOUT THIS, and the shape of the failure is
   * worth writing down because everything about it looked correct.
   * `confirmEnrolment` elevates the session it ran on, so the ten minutes
   * after enrolling worked perfectly — and nothing else in the system could
   * ever set `totp_verified_at` again. `assertElevated` is the only other
   * writer and it needs a code the caller supplied, but no client sent one:
   * `totp_code` appeared in exactly one request in the whole codebase, the
   * enrolment confirm. So every acting staff route answered `totp_required`
   * for ever, from eleven minutes after enrolment onwards.
   *
   * What an operator actually saw was worse than a plain refusal. The message
   * for `totp_required` reads "Enter the six-digit code from your
   * authenticator app" — and the only field on the provider-key form is the
   * transaction PIN, so the code went in there, the PIN check refused it, and
   * the answer was "that is not right". A correct code, a correct PIN, and a
   * dead end that blamed the operator.
   *
   * It is its own endpoint rather than a field on every action because the
   * elevation is a property of the SESSION. One prompt, one code, ten minutes
   * of work — which is the trade `assertElevated` already documents, and
   * threading an optional code through thirty admin methods would have been
   * thirty places to forget it.
   */
  async elevate(userUuid: string, sessionUuid: string, code: string): Promise<void> {
    const row = await this.#row(userUuid);
    if (row === undefined || row.confirmed_at === null) {
      throw new ForbiddenException(TOTP_NOT_ENROLLED);
    }
    // Verified and SPENT before anything is elevated. A code that fails here
    // must not leave a session elevated, and one that succeeds must not be
    // usable a second time — both are `#check`'s job, and it is called first
    // for that reason.
    await this.#check(userUuid, row, code);

    await this.pool.query(
      `UPDATE staff_totp SET last_used_at = now()
        WHERE user_id = (SELECT id FROM users WHERE uuid = $1)`,
      [userUuid],
    );
    // On the SESSION, so revoking the session revokes the elevation with it.
    await this.pool.query(
      `UPDATE auth_sessions SET totp_verified_at = now()
        WHERE uuid = $1 AND revoked_at IS NULL`,
      [sessionUuid],
    );
  }

  /** Verify a code and spend it, without elevating anything. Used by
   *  enrolment confirmation, which has no session to elevate yet. */
  async assertCode(userUuid: string, code: string): Promise<void> {
    const row = await this.#row(userUuid);
    if (row === undefined || row.confirmed_at === null) {
      throw new ForbiddenException(TOTP_NOT_ENROLLED);
    }
    await this.#check(userUuid, row, code);
    await this.pool.query(
      `UPDATE staff_totp SET last_used_at = now()
        WHERE user_id = (SELECT id FROM users WHERE uuid = $1)`,
      [userUuid],
    );
  }

  /**
   * The window is evaluated by the DATABASE clock, not by ours.
   *
   * `now() - totp_verified_at < interval` rather than reading the timestamp
   * and comparing it here: an instance with a skewed clock must not be able to
   * extend its own elevation window, which is the same reasoning that put the
   * gift card hold period on the database clock.
   */
  async #isElevated(sessionUuid: string): Promise<boolean> {
    const result = await this.pool.query<{ elevated: boolean }>(
      `SELECT (totp_verified_at IS NOT NULL
               AND totp_verified_at > now() - make_interval(mins => $2::int)) AS elevated
         FROM auth_sessions
        WHERE uuid = $1 AND revoked_at IS NULL`,
      [sessionUuid, ELEVATION_MINUTES],
    );
    return result.rows[0]?.elevated === true;
  }

  /**
   * The verification itself: lockout, then the code, then the replay guard.
   *
   * THE REPLAY GUARD IS THE HALF THAT IS EASY TO LEAVE OUT. A code is valid
   * for ninety seconds, which is ample time to read six digits off somebody's
   * screen during a call or a screen share. Verifying and stopping there
   * leaves the code usable for the rest of that window by everybody else who
   * saw it. Recording the counter value and refusing a repeat is what makes it
   * one-time in fact and not just in name — and it is a UNIQUE constraint
   * rather than a SELECT-then-INSERT because the check is a race.
   */
  async #check(userUuid: string, row: TotpRow, code: string): Promise<void> {
    const nowMs = this.clock.nowMs();

    if (row.locked_until !== null && row.locked_until.getTime() > nowMs) {
      throw new ForbiddenException(TOTP_LOCKED);
    }

    const result = verifyTotp(
      open(row.secret_sealed, this.#keyring()),
      code,
      Math.floor(nowMs / 1000),
    );

    if (!result.valid || result.timeStep === undefined) {
      await this.#recordFailure(userUuid, row);
      throw new UnauthorizedException(TOTP_INVALID);
    }

    try {
      await this.pool.query(
        `INSERT INTO staff_totp_used_steps (user_id, time_step)
         SELECT id, $2 FROM users WHERE uuid = $1`,
        [userUuid, result.timeStep],
      );
    } catch (error) {
      // A duplicate key means this exact code has already been spent. It is
      // NOT counted as a failed attempt: the operator typed a correct code,
      // and locking them out for the six digits their authenticator is
      // currently showing would make the surface unusable for anybody who
      // clicks twice.
      if (isUniqueViolation(error)) {
        this.#logger.warn(`user ${userUuid} presented an already-spent one-time code`);
        throw new UnauthorizedException(TOTP_INVALID);
      }
      throw error;
    }

    if (row.failed_attempts > 0) {
      await this.pool.query(
        `UPDATE staff_totp SET failed_attempts = 0, locked_until = NULL
          WHERE user_id = (SELECT id FROM users WHERE uuid = $1)`,
        [userUuid],
      );
    }
  }

  async #recordFailure(userUuid: string, row: TotpRow): Promise<void> {
    const attempts = row.failed_attempts + 1;
    const lock = attempts >= MAX_ATTEMPTS;

    await this.pool.query(
      `UPDATE staff_totp
          SET failed_attempts = $2,
              locked_until = CASE WHEN $3 THEN now() + make_interval(mins => $4::int) ELSE NULL END
        WHERE user_id = (SELECT id FROM users WHERE uuid = $1)`,
      [userUuid, lock ? 0 : attempts, lock, LOCKOUT_MINUTES],
    );

    if (lock) {
      this.#logger.error(
        `second factor for user ${userUuid} locked for ${LOCKOUT_MINUTES} minutes after ` +
          `${MAX_ATTEMPTS} failed codes`,
      );
    }
  }

  #keyring() {
    const keyring = this.config.encryptionKeyring;
    if (keyring === undefined) {
      throw new ServiceUnavailableException({ error: 'encryption_not_configured' });
    }
    return keyring;
  }

  async #row(userUuid: string): Promise<TotpRow | undefined> {
    const result = await this.pool.query<TotpRow>(
      `SELECT t.secret_sealed, t.confirmed_at, t.failed_attempts, t.locked_until
         FROM staff_totp t
         JOIN users u ON u.id = t.user_id
        WHERE u.uuid = $1`,
      [userUuid],
    );
    return result.rows[0];
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === '23505'
  );
}

/**
 * Reads the one-time code out of the request body.
 *
 * The body rather than a header, for the same two reasons the transaction PIN
 * travels there: it lands with the instruction it authorises, and
 * `redactPayload` scrubs it from anything that logs a body.
 */
export function optionalTotpFrom(body: unknown): string | undefined {
  const value =
    typeof body === 'object' && body !== null && 'totp_code' in body
      ? (body as { totp_code?: unknown }).totp_code
      : undefined;

  // Absent is not an error HERE, because an already-elevated session does not
  // need one. `assertElevated` is what decides whether it was required, and it
  // is the only place that can know.
  return typeof value === 'string' && value !== '' ? value : undefined;
}
