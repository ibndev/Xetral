import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

/**
 * Transaction PIN hashing and policy.
 *
 * A 6-digit PIN has a million possibilities, which is nothing. Everything here
 * exists because that number cannot be raised — customers will not accept a
 * passphrase to send airtime — so the defence has to come from somewhere else:
 *
 *   1. A deliberately slow KDF, so offline guessing costs real time per guess.
 *   2. A lockout after five failures, so online guessing never gets far.
 *      That half lives in the database (`record_pin_failure`), because a
 *      counter in application memory resets when a pod restarts, and an
 *      attacker's retry loop outlives a pod.
 *   3. A policy that removes the guesses an attacker would make FIRST.
 *
 * Any one of the three alone is inadequate.
 */

/** Matches the lockout constants enforced by record_pin_failure() in SQL. */
export const MAX_PIN_ATTEMPTS = 5;
export const PIN_LOCKOUT_MINUTES = 15;

const PIN_LENGTH = 6;

/**
 * scrypt parameters. N=2^15 with r=8 needs 128*N*r = 32 MiB per hash, which is
 * the point: memory cost is what makes GPU and ASIC guessing expensive, where
 * raw iteration count does not.
 *
 * These live IN the stored envelope rather than only here, so raising them
 * later does not invalidate every existing PIN — an old hash is verified with
 * the parameters it was created with, and upgraded on the next successful
 * verification.
 */
const SCRYPT_N = 32768;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 32;
const SALT_BYTES = 16;

/** Node's default maxmem is exactly 32 MiB, which the parameters above sit on
 *  the boundary of. Without this, scrypt throws rather than running. */
const SCRYPT_MAXMEM = 64 * 1024 * 1024;

/**
 * The PINs an attacker tries in the first hundred guesses. Rejecting them
 * costs a customer one retry at signup; allowing them means the lockout in the
 * database is the ONLY thing standing between a stolen phone and the money,
 * and lockouts expire.
 */
const BANNED_PINS = new Set([
  '123456', '654321', '111111', '000000', '121212', '112233',
  '123123', '098765', '159753', '147258', '696969', '666666',
]);

export class WeakPinError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WeakPinError';
  }
}

/**
 * Throws on a PIN that should never be accepted at all.
 *
 * Note what is NOT here: any check against the customer's date of birth or
 * phone number. Those are worth rejecting, but doing it in this function would
 * mean passing personal data into the hashing module, and the moment a PIN
 * validator takes a date of birth it is one stack trace away from logging one.
 * That check belongs in the registration flow, where the data already is.
 */
export function assertPinPolicy(pin: string): void {
  if (!new RegExp(`^[0-9]{${PIN_LENGTH}}$`).test(pin)) {
    throw new WeakPinError(`a transaction PIN must be exactly ${PIN_LENGTH} digits`);
  }

  if (BANNED_PINS.has(pin)) {
    throw new WeakPinError('that PIN is among the most commonly guessed; choose another');
  }

  const digits = [...pin].map(Number);
  const first = digits[0];
  if (first === undefined) throw new WeakPinError('empty PIN');

  if (digits.every((d) => d === first)) {
    throw new WeakPinError('a PIN cannot be the same digit repeated');
  }

  // Runs in both directions: 123456 and 654321 are equally obvious.
  const isRun = (step: number): boolean =>
    digits.every((d, i) => i === 0 || d === (digits[i - 1] ?? NaN) + step);
  if (isRun(1) || isRun(-1)) {
    throw new WeakPinError('a PIN cannot be a run of consecutive digits');
  }
}

function derive(pin: string, salt: Buffer, n: number, r: number, p: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(pin, salt, KEY_LENGTH, { N: n, r, p, maxmem: SCRYPT_MAXMEM }, (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  });
}

/**
 * Produces `v1:scrypt:<N>:<r>:<p>:<salt>:<hash>`.
 *
 * The `v1:` prefix is required by the CHECK constraint on
 * `transaction_pins.pin_hash`, so a hash written without one cannot reach a
 * row. That is what makes rotating the scheme possible later: every stored
 * secret can be identified as belonging to the old one.
 */
export async function hashPin(pin: string): Promise<string> {
  assertPinPolicy(pin);
  const salt = randomBytes(SALT_BYTES);
  const key = await derive(pin, salt, SCRYPT_N, SCRYPT_R, SCRYPT_P);
  return [
    'v1', 'scrypt', SCRYPT_N, SCRYPT_R, SCRYPT_P,
    salt.toString('base64url'),
    key.toString('base64url'),
  ].join(':');
}

/**
 * Verifies against the parameters recorded IN the stored value, not against
 * the current constants. Reading today's parameters instead would silently
 * lock out every customer whose PIN was hashed before the last change.
 *
 * Deliberately does NOT call assertPinPolicy: policy tightens over time, and a
 * customer whose existing PIN would no longer be accepted at signup must still
 * be able to sign in — otherwise adding a banned PIN to the list locks people
 * out of their own money. Prompt them to change it after they are in.
 */
export async function verifyPin(pin: string, stored: string): Promise<boolean> {
  const parts = stored.split(':');
  if (parts.length !== 7) return false;

  const [version, algorithm, nRaw, rRaw, pRaw, saltRaw, hashRaw] = parts;
  if (version !== 'v1' || algorithm !== 'scrypt') return false;
  if (nRaw === undefined || rRaw === undefined || pRaw === undefined) return false;
  if (saltRaw === undefined || hashRaw === undefined) return false;

  const n = Number(nRaw);
  const r = Number(rRaw);
  const p = Number(pRaw);
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return false;

  // An absurd N in a tampered envelope would hang the process allocating
  // memory. The stored value is ours, but "ours" is an assumption worth one
  // comparison rather than a stalled worker.
  if (n > SCRYPT_N || r > SCRYPT_R * 4 || p > SCRYPT_P * 4) return false;

  const expected = Buffer.from(hashRaw, 'base64url');
  const actual = await derive(pin, Buffer.from(saltRaw, 'base64url'), n, r, p);

  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/**
 * True when a stored PIN should be re-hashed with today's parameters. Call it
 * after a SUCCESSFUL verification, which is the only moment the plaintext PIN
 * is available to re-hash with.
 */
export function needsRehash(stored: string): boolean {
  const parts = stored.split(':');
  if (parts.length !== 7) return true;
  const [version, algorithm, nRaw, rRaw, pRaw] = parts;
  return (
    version !== 'v1' ||
    algorithm !== 'scrypt' ||
    Number(nRaw) !== SCRYPT_N ||
    Number(rRaw) !== SCRYPT_R ||
    Number(pRaw) !== SCRYPT_P
  );
}
