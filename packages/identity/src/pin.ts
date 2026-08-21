import {
  DEFAULT_SCRYPT_PARAMS,
  hashSecret,
  needsRehashSecret,
  verifySecret,
} from './secret-hash.js';

/**
 * Transaction PIN policy.
 *
 * A 6-digit PIN has a million possibilities, which is nothing. Everything here
 * exists because that number cannot be raised — customers will not accept a
 * passphrase to send airtime — so the defence has to come from somewhere else:
 *
 *   1. A deliberately slow KDF, so offline guessing costs real time per guess.
 *      That is `secret-hash.ts`, shared with passwords.
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

/** Produces `v1:scrypt:<N>:<r>:<p>:<salt>:<hash>`, which the CHECK constraint
 *  on `transaction_pins.pin_hash` requires. */
export async function hashPin(pin: string): Promise<string> {
  assertPinPolicy(pin);
  return hashSecret(pin, DEFAULT_SCRYPT_PARAMS);
}

/**
 * Deliberately does NOT call assertPinPolicy: policy tightens over time, and a
 * customer whose existing PIN would no longer be accepted at signup must still
 * be able to sign in — otherwise adding a banned PIN to the list locks people
 * out of their own money. Prompt them to change it after they are in.
 */
export async function verifyPin(pin: string, stored: string): Promise<boolean> {
  return verifySecret(pin, stored);
}

export function needsRehash(stored: string): boolean {
  return needsRehashSecret(stored, DEFAULT_SCRYPT_PARAMS);
}
