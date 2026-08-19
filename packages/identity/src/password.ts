import {
  DEFAULT_SCRYPT_PARAMS,
  hashSecret,
  needsRehashSecret,
  verifySecret,
} from './secret-hash.js';

/**
 * Login password policy and hashing.
 *
 * Separate from the transaction PIN in every sense: a different secret, a
 * different table, a different policy, and a different act. Signing in and
 * moving money are not the same thing, and a phone left unlocked on a table
 * should not be able to do the second because it did the first.
 */

/**
 * Length is the only requirement, and that is deliberate.
 *
 * Composition rules ("one uppercase, one symbol") are the classic mistake:
 * they push people toward `Password1!`, which is both harder to remember and
 * trivially guessed, while rejecting a long passphrase that is genuinely
 * strong. NIST dropped them for exactly this reason. Length is what buys
 * entropy.
 */
export const MIN_PASSWORD_LENGTH = 10;

/**
 * scrypt salts internally, so long inputs are not a correctness problem — but
 * an unbounded one is free CPU for an attacker on an unauthenticated endpoint.
 */
export const MAX_PASSWORD_LENGTH = 256;

/**
 * The passwords a credential-stuffing list opens with. This is a floor, not a
 * substitute for the real check: before taking deposits, a registration flow
 * should test candidates against a breached-password corpus (the Have I Been
 * Pwned range API does this without sending the password anywhere). Rejecting
 * twelve strings here removes the laziest guesses and nothing more.
 */
const BANNED_PASSWORDS = new Set([
  'password', 'password1', 'password123', '1234567890', 'qwertyuiop',
  'iloveyou1', 'welcome123', 'admin12345', 'letmein123', 'football12',
  'nigeria123', 'chelsea123',
]);

export class WeakPasswordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WeakPasswordError';
  }
}

export function assertPasswordPolicy(password: string): void {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new WeakPasswordError(
      `a password must be at least ${MIN_PASSWORD_LENGTH} characters`,
    );
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    throw new WeakPasswordError(`a password must be at most ${MAX_PASSWORD_LENGTH} characters`);
  }
  if (BANNED_PASSWORDS.has(password.toLowerCase())) {
    throw new WeakPasswordError('that password is among the most commonly guessed; choose another');
  }
}

export async function hashPassword(password: string): Promise<string> {
  assertPasswordPolicy(password);
  return hashSecret(password, DEFAULT_SCRYPT_PARAMS);
}

/**
 * Deliberately does NOT re-check policy. Policy tightens over time, and a
 * customer whose password predates a new rule must still be able to sign in —
 * otherwise raising the minimum length locks existing customers out of their
 * own money. Prompt them to change it once they are in.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  return verifySecret(password, stored);
}

export function passwordNeedsRehash(stored: string): boolean {
  return needsRehashSecret(stored, DEFAULT_SCRYPT_PARAMS);
}
