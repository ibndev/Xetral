import { HttpException, HttpStatus, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Pool } from 'pg';
import {
  MAX_PIN_ATTEMPTS,
  PIN_LOCKOUT_MINUTES,
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
    const found = await this.pool.query<PinRow>(
      `SELECT p.user_id, p.pin_hash, p.failed_attempts, p.locked_until
         FROM transaction_pins p
         JOIN users u ON u.id = p.user_id
        WHERE u.uuid = $1`,
      [userUuid],
    );

    const row = found.rows[0];
    if (row === undefined) throw new PinNotSetError();

    // Checked in the database, before any comparison, so a locked account
    // cannot be probed at all -- not even to learn whether a guess was right.
    try {
      await this.pool.query(`SELECT assert_pin_unlocked($1::bigint)`, [row.user_id]);
    } catch {
      throw new PinLockedError(row.locked_until?.toISOString() ?? null);
    }

    if (await verifyPin(pin, row.pin_hash)) {
      // Re-checks the lock and resets the counter. A correct PIN arriving
      // during a lockout must not silently lift it.
      await this.pool.query(`SELECT record_pin_success($1::bigint)`, [row.user_id]);

      // The only moment the plaintext is available to re-hash with.
      if (needsRehash(row.pin_hash)) {
        await this.pool.query(
          `UPDATE transaction_pins SET pin_hash = $2, updated_at = now() WHERE user_id = $1::bigint`,
          [row.user_id, await hashPin(pin)],
        );
      }
      return;
    }

    const failure = await this.pool.query<{ record_pin_failure: Date | null }>(
      `SELECT record_pin_failure($1::bigint, $2, ($3 || ' minutes')::interval)`,
      [row.user_id, MAX_PIN_ATTEMPTS, PIN_LOCKOUT_MINUTES],
    );

    const lockedUntil = failure.rows[0]?.record_pin_failure ?? null;
    if (lockedUntil !== null) throw new PinLockedError(lockedUntil.toISOString());

    // Attempts remaining is safe to return and useful to a customer who
    // mistyped: the counter only resets on a SUCCESS, so an attacker who stops
    // short of the lockout gains nothing by knowing where it is.
    throw new UnauthorizedException({
      error: 'invalid_pin',
      attempts_remaining: Math.max(0, MAX_PIN_ATTEMPTS - (row.failed_attempts + 1)),
    });
  }

  /** Sets a PIN, or changes one. Changing requires the current PIN — otherwise
   *  a stolen session could replace the very factor that is meant to stop it. */
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

    const hash = await hashPin(pin);
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
