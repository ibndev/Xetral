import { createHash, createHmac, randomBytes, randomInt } from 'node:crypto';

/**
 * Refresh token minting and hashing.
 *
 * A refresh token is 32 bytes of CSPRNG output and nothing else. It carries no
 * structure, no user id, no expiry — everything about it is looked up by hash
 * in `refresh_tokens`. That is the opposite of the JWT-shaped instinct, and it
 * is deliberate: a token that says who it belongs to is a token an attacker can
 * study, and a token that carries its own expiry is one the server has to trust
 * a signature over rather than simply read a row.
 *
 * 32 bytes because the value has to survive being guessed by an adversary who
 * can try offline. 16 would be adequate today and is the kind of number that is
 * adequate right up until it is not.
 */
const REFRESH_TOKEN_BYTES = 32;

/**
 * 15 minutes. Access tokens cannot be revoked mid-life (see section 5 of
 * 002_identity.sql), so this number IS the window during which a stolen access
 * token still works. It is small for that reason and not for any other, and
 * raising it is a security decision, not a performance tweak.
 */
export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;

/** 30 days. Rotated on every use, so the value in flight is short-lived even
 *  though the family is long-lived. */
export const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;

export interface IssuedRefreshToken {
  /** Sent to the client. Never logged, never stored, never returned again. */
  readonly token: string;
  /** Stored. The only half that touches the database. */
  readonly hash: string;
}

/**
 * SHA-256, not a password hash, and the difference matters both ways.
 *
 * Argon2 or scrypt would be wrong here: they are slow BY DESIGN to make
 * guessing a low-entropy human secret expensive, and this value has 256 bits of
 * entropy — there is nothing to guess. All the slowness would buy is a CPU cost
 * on every single refresh request, which is a denial-of-service surface.
 *
 * The reason to hash at all is not guessing, it is disclosure: a database dump,
 * a replica, a leaked slow-query log. A stored SHA-256 cannot be presented as a
 * credential, so none of those become account takeover.
 *
 * Hex output rather than base64 so it matches the `^[0-9a-f]{64}$` CHECK on
 * `refresh_tokens.token_hash`, which is what stops a raw token from ever
 * reaching a row.
 */
export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function issueRefreshToken(): IssuedRefreshToken {
  // base64url: URL- and header-safe with no escaping step where a token could
  // be mangled into a different token that still looks valid.
  const token = randomBytes(REFRESH_TOKEN_BYTES).toString('base64url');
  return { token, hash: hashRefreshToken(token) };
}

/**
 * The outcomes of `rotate_refresh_token`, mirrored from the SQL enum.
 *
 * Kept as a union rather than collapsed into a boolean because the caller has
 * to treat them differently: 'reuse_detected' is a security event that should
 * page someone, while 'expired' is a Tuesday. To the CLIENT all four failures
 * are the same response — sign in again — and that symmetry is deliberate, so
 * a probe cannot learn whether a token it holds was ever real.
 */
export type RotationOutcome =
  | 'rotated'
  | 'reuse_detected'
  | 'unknown_token'
  | 'session_revoked'
  | 'expired';

/** True for the outcomes that mean "somebody may be holding a stolen token". */
export function isSecurityIncident(outcome: RotationOutcome): boolean {
  return outcome === 'reuse_detected';
}

/**
 * Password reset tokens, built exactly like refresh tokens.
 *
 * The same 32 CSPRNG bytes, the same base64url encoding, the same SHA-256 hex
 * hash — and named separately rather than reusing the refresh functions
 * directly, because the two are used in different tables with different
 * lifetimes and a future change to one must not silently change the other.
 *
 * The construction is right for the same reasons it is right there: 256 bits
 * of entropy means there is nothing to guess, so a slow password hash would
 * buy nothing and cost a CPU-bound denial-of-service surface on a PUBLIC
 * endpoint. Hashing is for disclosure — a dump, a replica, a leaked log —
 * where a stored SHA-256 cannot be presented as a credential.
 *
 * The hex output is what satisfies the `^[0-9a-f]{64}$` CHECK on
 * `password_reset_tokens.token_hash`, which is what stops a raw token ever
 * reaching a row.
 */
export interface IssuedResetToken {
  /** Goes into the email and nowhere else. Never logged, never stored. */
  readonly token: string;
  /** Stored. The only half that touches the database. */
  readonly hash: string;
}

export function hashPasswordResetToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function issuePasswordResetToken(): IssuedResetToken {
  const token = randomBytes(REFRESH_TOKEN_BYTES).toString('base64url');
  return { token, hash: hashPasswordResetToken(token) };
}

/**
 * A SIX-DIGIT RESET CODE, AND WHY IT IS HASHED WITH A KEY RATHER THAN PLAINLY.
 *
 * A reset used to be a LINK carrying 32 bytes of entropy, and a plain SHA-256
 * of that is safe to store: there is nothing to guess. A code a customer
 * retypes cannot be 32 bytes, and six digits is A MILLION POSSIBILITIES —
 * which somebody holding a database dump exhausts in under a second. An
 * unkeyed digest of a six-digit code IS the code.
 *
 * So it is an HMAC, keyed by a secret that is not in the database. A dump
 * alone then says nothing, and the only way to test a guess is to present it
 * to the API — where the attempt ceiling in 056 and the per-identifier rate
 * limit are what make a million guesses impossible rather than merely slow.
 *
 * THE USER ID IS PART OF WHAT IS SIGNED, so one customer's code cannot be
 * presented for another's account even if two are issued the same six digits,
 * which at a million values happens routinely. `token_hash` is globally
 * unique, and without the id two simultaneous resets could collide on the
 * constraint and refuse a customer for a reason that is about somebody else.
 *
 * THE KEY IS THE ACCESS TOKEN KEYRING'S CURRENT KEY, with its own domain
 * separator. That is a deliberate reuse rather than a new deployment variable
 * nobody sets: `KYC_BLIND_INDEX_KEY` is kept separate because rotating it
 * silently breaks a permanent index, and the opposite is true here — an
 * outstanding code lives for minutes, so a rotation costs at worst one
 * customer asking again.
 */
export interface IssuedResetCode {
  /** Goes into the email and nowhere else. Never logged, never stored. */
  readonly code: string;
  /** Stored. The only half that touches the database. */
  readonly hash: string;
}

export function hashPasswordResetCode(userId: string, code: string, key: Buffer): string {
  return createHmac('sha256', key)
    .update(`xetral:password-reset-code:${userId}:${code}`, 'utf8')
    .digest('hex');
}

export function issuePasswordResetCode(userId: string, key: Buffer): IssuedResetCode {
  /*
   * `randomInt`, not `Math.random`. This is a credential: a predictable one
   * lets somebody who knows when a reset was requested compute the code
   * without ever seeing the email. `.semgrep/xetral.yml` refuses `Math.random`
   * on this path, and is right to.
   *
   * Six digits WITH leading zeros preserved — `randomInt(0, 1e6)` padded — so
   * the space really is a million rather than the 900,000 a 100000..999999
   * range would give.
   */
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  return { code, hash: hashPasswordResetCode(userId, code, key) };
}

/** The outcomes of `consume_password_reset_token`, mirrored from the SQL enum.
 *
 *  To the CLIENT all three failures are one response, deliberately: telling
 *  somebody which way their token failed tells them whether it was ever real. */
export type PasswordResetOutcome =
  | 'consumed'
  | 'unknown_token'
  | 'already_used'
  | 'expired'
  /** 056. The code was wrong once too often and every live code for that
   *  customer has been burnt — the ceiling that makes six digits safe. */
  | 'too_many_attempts';
