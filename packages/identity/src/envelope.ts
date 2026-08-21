import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Versioned encryption envelopes for data we must store but must not store in
 * the clear: BVNs, government ID numbers, provider account references.
 *
 * Not for PINs or passwords — those are hashed, never encrypted, because
 * encryption is reversible and nothing should ever be able to recover a
 * customer's PIN, including us.
 *
 * Format: `v1:<iv>:<tag>:<ciphertext>`, each part base64url.
 *
 * The version prefix is the whole reason this is a module rather than two calls
 * to `createCipheriv` at the point of use. A key WILL have to be rotated — a
 * departing engineer, a leaked backup, a scheduled policy — and rotation is
 * only possible if every stored value announces which key opened it. Retrofit
 * that onto a million rows of bare ciphertext and the answer is a migration
 * that has to guess.
 */

const IV_BYTES = 12; // 96 bits, the size GCM is defined for
const KEY_BYTES = 32; // AES-256
const TAG_BYTES = 16;

export interface EncryptionKey {
  /** Matches ^v[0-9]+$ and appears literally as the envelope's prefix. */
  readonly version: string;
  readonly key: Buffer;
}

export interface Keyring {
  /** Used for all new writes. */
  readonly current: EncryptionKey;
  /** Every key still able to open existing data, including `current`. */
  readonly accepted: readonly EncryptionKey[];
}

const VERSION_PATTERN = /^v[0-9]+$/;

export function assertValidKey(key: EncryptionKey): void {
  if (!VERSION_PATTERN.test(key.version)) {
    throw new Error(`key version must look like 'v1', got '${key.version}'`);
  }
  if (key.key.length !== KEY_BYTES) {
    throw new Error(`AES-256 needs a ${KEY_BYTES}-byte key, got ${key.key.length}`);
  }
}

/**
 * GCM, not CBC. CBC leaves the ciphertext malleable — an attacker who can write
 * to the database can flip bits in a stored BVN and the decryption still
 * succeeds, returning different plaintext. GCM's tag makes that a failure
 * instead of a silent corruption.
 *
 * The version string is passed as additional authenticated data, so the tag
 * covers it. Without that, an attacker could move a ciphertext from a v1
 * envelope to a v2 one; with it, that edit fails to authenticate.
 *
 * The IV is random per message and never reused. GCM's failure mode on IV reuse
 * is catastrophic rather than gradual — two messages under one IV leak their
 * XOR and can expose the authentication key — which is why it is generated here
 * and not accepted as an argument.
 */
export function seal(plaintext: string, keyring: Keyring): string {
  assertValidKey(keyring.current);

  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', keyring.current.key, iv);
  cipher.setAAD(Buffer.from(keyring.current.version, 'utf8'));

  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [
    keyring.current.version,
    iv.toString('base64url'),
    tag.toString('base64url'),
    ciphertext.toString('base64url'),
  ].join(':');
}

export class EnvelopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EnvelopeError';
  }
}

/**
 * Throws rather than returning null on any failure, and the errors deliberately
 * say nothing about the ciphertext.
 *
 * A tampered envelope is not a data-quality problem to be handled with a
 * fallback — it means someone wrote to a column they should not have, and the
 * correct behaviour is to stop, not to carry on with a best guess.
 */
export function open(envelope: string, keyring: Keyring): string {
  const parts = envelope.split(':');
  if (parts.length !== 4) {
    throw new EnvelopeError('malformed envelope');
  }

  const [version, ivRaw, tagRaw, ciphertextRaw] = parts;
  if (version === undefined || ivRaw === undefined) throw new EnvelopeError('malformed envelope');
  if (tagRaw === undefined || ciphertextRaw === undefined) {
    throw new EnvelopeError('malformed envelope');
  }

  const key = keyring.accepted.find((k) => k.version === version);
  if (key === undefined) {
    // Naming the version is safe and saves an incident: it is already in the
    // stored value, and the message points straight at a keyring that was
    // deployed without a retired key it still needs.
    throw new EnvelopeError(`no key for envelope version '${version}'`);
  }

  const iv = Buffer.from(ivRaw, 'base64url');
  const tag = Buffer.from(tagRaw, 'base64url');
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new EnvelopeError('malformed envelope');
  }

  const decipher = createDecipheriv('aes-256-gcm', key.key, iv);
  decipher.setAAD(Buffer.from(version, 'utf8'));
  decipher.setAuthTag(tag);

  try {
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertextRaw, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    // `final()` throws precisely when the tag does not match: wrong key, or
    // edited ciphertext. The distinction is not available to us and would not
    // change the response.
    throw new EnvelopeError('envelope failed authentication');
  }
}

/** True when a value was sealed under a key that is no longer `current`. */
export function needsReseal(envelope: string, keyring: Keyring): boolean {
  const version = envelope.split(':')[0];
  return version !== keyring.current.version;
}
