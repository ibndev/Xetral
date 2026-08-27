import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * A deterministic, irreversible fingerprint of a secret value, so two rows
 * holding the same secret can be recognised as the same without either being
 * readable.
 *
 * WHY THIS EXISTS. A BVN is sealed with an AES-GCM envelope, and that envelope
 * is deliberately non-deterministic: the IV is random per message, so sealing
 * one BVN twice produces two different ciphertexts. That is exactly right for
 * confidentiality and it makes the sealed column useless for the question
 * "has this BVN already been used to open an account?" — which in Nigeria is
 * the single strongest multi-account signal there is, because a BVN is one
 * person by definition.
 *
 * WHY NOT A PLAIN HASH. A BVN is eleven digits. SHA-256 over the whole space
 * is a few hours on one machine, so an unkeyed digest of a BVN is a BVN. The
 * HMAC key is what turns "the attacker who reads this table learns everybody's
 * BVN" into "the attacker who reads this table learns which rows match".
 *
 * WHY THE VERSION PREFIX, given that a blind index cannot have two live keys.
 * Precisely because it cannot: rotating the key means every fingerprint must be
 * recomputed, and until that finishes the table holds two populations that
 * cannot see each other. The prefix makes that state VISIBLE — a view reports
 * more than one version in use — rather than presenting as a uniqueness rule
 * that has quietly stopped catching anything.
 */
export interface BlindIndexKey {
  /** Matches ^v[0-9]+$ and appears literally as the fingerprint's prefix. */
  readonly version: string;
  readonly key: Buffer;
}

const VERSION_PATTERN = /^v[0-9]+$/;
const MIN_KEY_BYTES = 32;

export function assertValidBlindIndexKey(key: BlindIndexKey): void {
  if (!VERSION_PATTERN.test(key.version)) {
    throw new Error(`blind index key version must look like 'v1', got '${key.version}'`);
  }
  if (key.key.length < MIN_KEY_BYTES) {
    throw new Error(
      `a blind index key must be at least ${MIN_KEY_BYTES} bytes, got ${key.key.length}`,
    );
  }
}

/**
 * `v1:<64 hex characters>`, which is the shape the CHECK on the column
 * enforces — so a fingerprint computed some other way cannot reach a row.
 *
 * The value is normalised first. A BVN typed with a space in it is the same
 * BVN, and a fingerprint that disagreed would let one person hold two accounts
 * by pressing the space bar.
 */
export function blindIndex(value: string, key: BlindIndexKey): string {
  assertValidBlindIndexKey(key);
  const normalised = value.replace(/\s+/g, '');
  if (normalised === '') {
    throw new Error('refusing to fingerprint an empty value');
  }
  const digest = createHmac('sha256', key.key)
    // The version is part of the message as well as the prefix, so a
    // fingerprint cannot be relabelled from one version to another by editing
    // the string.
    .update(`${key.version}:${normalised}`, 'utf8')
    .digest('hex');
  return `${key.version}:${digest}`;
}

/** Constant-time comparison, for the one caller that compares two
 *  fingerprints in application code rather than in an index. */
export function blindIndexEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
