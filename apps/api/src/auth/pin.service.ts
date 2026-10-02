import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Pool } from 'pg';
import {
  MAX_PIN_ATTEMPTS,
  PIN_LOCKOUT_MINUTES,
  WeakPinError,
  hashPin,
  needsRehash,
  verifyPin,
} from '@xetral/identity';
import { DATABASE } from '../tokens.js';

/**
 * Transaction-PIN verification.
 *
 * The PIN is a second factor for MOVING money, separate from the credentials
 * that prove who you are. A phone left unlocked on a table has already passed
 * the first; it must not thereby pass the second.
 *
 * The lockout is NOT implemented here. `record_pin_failure` and
 * `assert_pin_unlocked` are database functions, because a counter in
 * application memory resets when a pod restarts and an attacker's retry loop
 * outlives a pod. This service verifies a hash and lets the database keep score.
 */

export class PinNotSetError extends HttpException {
  constructor() {
    super({ error: 'pin_not_set' }, HttpStatus.CONFLICT);
  }
}

/** 423 Locked, not 401. The client needs to tell the customer to wait rather
 *  than to try again, and those are different screens. */
export class PinLockedError extends HttpException {
  constructor(lockedUntil: string | null) {
    super(
      { error: 'pin_locked', ...(lockedUntil === null ? {} : { locked_until: lockedUntil }) },
      HttpStatus.LOCKED,
    );
  }
}

interface PinRow {
  user_id: string;
  pin_hash: string;
  failed_attempts: number;
  locked_until: Date | null;
}

@Injectable()
export class PinService {
  constructor(@Inject(DATABASE) private readonly pool: Pool) {}

  /**
   * Throws unless the PIN is correct. Returns nothing on success — there is no
   * "grant" to hand back, deliberately: a PIN token would be a bearer
   * credential for spending money, and the whole point of the PIN is that it is
   * presented per action rather than held.
   */
  async assertValid(userUuid: string, pin: string): Promise<void> {
    /*
     * THE ATTEMPT IS COUNTED BEFORE THE GUESS IS CHECKED.
     *
     * It was counted after: read the row, ask whether it was locked, spend
     * scrypt's ~100ms verifying, THEN record the failure. Every request in a
     * parallel burst passed the "locked?" question before the first failure
     * landed, so a stolen session firing a hundred guesses at once had a
     * hundred guesses checked — the five-attempt lockout bounded only the
     * guesses that arrived one after another. `record_pin_failure` counting
     * atomically did not help: the counter was right, it was simply asked too
     * late.
     *
     * So each request first CLAIMS an attempt in one UPDATE, which only
     * succeeds while the PIN is unlocked, and the fifth claim sets the lock.
     * At most five guesses are ever in flight or behind us per lockout, however
     * they arrive. A correct guess then clears the count, exactly as success
     * always did; a process dying between the two leaves one counted failure,
     * which is the safe direction. Still one statement each, so the database
     * keeps score — the rule this service has always followed.
     */
    const claimed = await this.pool.query<{ user_id: string; pin_hash: string; failed_attempts: number }>(
      `UPDATE transaction_pins p
          SET failed_attempts = p.failed_attempts + 1,
              locked_until = CASE
                WHEN p.failed_attempts + 1 >= $2 THEN now() + ($3 || ' minutes')::interval
                ELSE p.locked_until
              END,
              updated_at = now()
         FROM users u
        WHERE u.id = p.user_id AND u.uuid = $1
          AND (p.locked_until IS NULL OR p.locked_until <= now())
        RETURNING p.user_id::text AS user_id, p.pin_hash, p.failed_attempts`,
      [userUuid, MAX_PIN_ATTEMPTS, PIN_LOCKOUT_MINUTES],
    );

    const row = claimed.rows[0];
    if (row === undefined) {
      const found = await this.pool.query<Pick<PinRow, 'locked_until'>>(
        `SELECT p.locked_until
           FROM transaction_pins p
           JOIN users u ON u.id = p.user_id
          WHERE u.uuid = $1`,
        [userUuid],
      );
      const existing = found.rows[0];
      if (existing === undefined) throw new PinNotSetError();
      throw new PinLockedError(existing.locked_until?.toISOString() ?? null);
    }

    if (await verifyPin(pin, row.pin_hash)) {
      /* Clears the count, and the lock a fifth claim may have set: the fifth
         guess being the right one is the customer's last try succeeding. No
         further claim can have started once that lock was set. */
      await this.pool.query(
        `UPDATE transaction_pins
            SET failed_attempts = 0, locked_until = NULL,
                last_verified_at = now(), updated_at = now()
          WHERE user_id = $1::bigint`,
        [row.user_id],
      );

      if (needsRehash(row.pin_hash)) {
        await this.pool.query(
          `UPDATE transaction_pins SET pin_hash = $2, updated_at = now() WHERE user_id = $1::bigint`,
          [row.user_id, await hashPin(pin)],
        );
      }
      return;
    }

    // The attempt is already counted. `failed_attempts` here is the count
    // INCLUDING this one.
    if (row.failed_attempts >= MAX_PIN_ATTEMPTS) {
      const locked = await this.pool.query<{ locked_until: Date | null }>(
        `SELECT locked_until FROM transaction_pins WHERE user_id = $1::bigint`,
        [row.user_id],
      );
      throw new PinLockedError(locked.rows[0]?.locked_until?.toISOString() ?? null);
    }

    throw new UnauthorizedException({
      error: 'invalid_pin',
      attempts_remaining: Math.max(0, MAX_PIN_ATTEMPTS - row.failed_attempts),
    });
  }

  async set(userUuid: string, pin: string, currentPin: string | undefined): Promise<void> {
    const user = await this.pool.query<{ id: string; has_pin: boolean }>(
      `SELECT u.id, (p.user_id IS NOT NULL) AS has_pin
         FROM users u
         LEFT JOIN transaction_pins p ON p.user_id = u.id
        WHERE u.uuid = $1`,
      [userUuid],
    );
    const row = user.rows[0];
    if (row === undefined) throw new UnauthorizedException({ error: 'invalid_token' });

    if (row.has_pin) {
      if (currentPin === undefined) {
        throw new UnauthorizedException({ error: 'current_pin_required' });
      }
      await this.assertValid(userUuid, currentPin);
    }

    /*
     * The PIN policy is enforced in @xetral/identity and its refusal has to be
     * TRANSLATED here, exactly as `register()` translates WeakPasswordError.
     *
     * It was not, and the consequence was worse than the password case: the
     * zod schema only checks `min(1).max(32)`, so every real violation — five
     * digits, seven digits, 111111, 123456 — reached this line and escaped as
     * an unhandled error. A customer setting their first PIN got a bare 500,
     * on the one step they must complete before they can move any money at
     * all, with nothing on screen telling them what was wrong with it.
     *
     * Found by typing a wrong-length PIN by hand, not by a test: every suite
     * used a valid PIN, so nothing ever reached the failing branch.
     */
    let hash: string;
    try {
      hash = await hashPin(pin);
    } catch (error) {
      if (error instanceof WeakPinError) {
        // The detail IS safe to return and is the whole point: "must be
        // exactly 6 digits" is what lets someone fix it. It describes the
        // rule, never the value.
        throw new BadRequestException({ error: 'weak_pin', detail: error.message });
      }
      throw error;
    }

    await this.pool.query(
      `INSERT INTO transaction_pins (user_id, pin_hash)
       VALUES ($1::bigint, $2)
       ON CONFLICT (user_id) DO UPDATE
         SET pin_hash = EXCLUDED.pin_hash,
             failed_attempts = 0,
             locked_until = NULL,
             updated_at = now()`,
      [row.id, hash],
    );
  }
}
