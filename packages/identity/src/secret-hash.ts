import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

/**
 * The one scrypt path, shared by transaction PINs and login passwords.
 *
 * Both are low-entropy human secrets verified against a stored hash, and the
 * mechanics — salt, KDF, versioned envelope, constant-time compare — are
 * identical. What differs is POLICY (a PIN is six digits; a password is not),
 * and policy lives with each caller.
 *
 * The reason to share this rather than write it twice: two copies drift. The
 * copy that is read less often is the one that keeps a weaker parameter, and
 * nobody notices because both still verify correctly.
 *
 * Format: `v1:scrypt:<N>:<r>:<p>:<salt>:<hash>`, salt and hash base64url.
 * The `v1:` prefix satisfies the CHECK constraints on
 * `transaction_pins.pin_hash` and `user_credentials.password_hash`, so a hash
 * written without one cannot reach a row.
 */

export interface ScryptParams {
  readonly n: number;
  readonly r: number;
  readonly p: number;
}

/**
 * N=2^15 with r=8 needs 128*N*r = 32 MiB per hash. Memory cost is what makes
 * GPU and ASIC guessing expensive; raw iteration count does not.
 */
export const DEFAULT_SCRYPT_PARAMS: ScryptParams = { n: 32768, r: 8, p: 1 };

const KEY_LENGTH = 32;
const SALT_BYTES = 16;

/** Node's default maxmem is exactly 32 MiB, which the parameters above sit on
 *  the boundary of. Without this, scrypt throws rather than running. */
const SCRYPT_MAXMEM = 64 * 1024 * 1024;

/**
 * Ceilings for parameters read back out of a stored envelope. The value is
 * ours, but an absurd N in a tampered row would hang the process allocating
 * memory, and "ours" is worth one comparison rather than a stalled worker.
 */
const MAX_ACCEPTED_N = DEFAULT_SCRYPT_PARAMS.n;
const MAX_ACCEPTED_R = DEFAULT_SCRYPT_PARAMS.r * 4;
const MAX_ACCEPTED_P = DEFAULT_SCRYPT_PARAMS.p * 4;

function derive(secret: string, salt: Buffer, params: ScryptParams): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      secret,
      salt,
      KEY_LENGTH,
      { N: params.n, r: params.r, p: params.p, maxmem: SCRYPT_MAXMEM },
      (err, key) => {
        if (err) reject(err);
        else resolve(key);
      },
    );
  });
}

export async function hashSecret(
  secret: string,
  params: ScryptParams = DEFAULT_SCRYPT_PARAMS,
): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const key = await derive(secret, salt, params);
  return [
    'v1',
    'scrypt',
    params.n,
    params.r,
    params.p,
    salt.toString('base64url'),
    key.toString('base64url'),
  ].join(':');
}

/**
 * Verifies against the parameters recorded IN the stored value, not against
 * today's constants. Reading current parameters instead would silently lock
 * out every secret hashed before the last change.
 *
 * Returns false rather than throwing on a malformed envelope. This runs on the
 * login and transaction paths, where a crash is an outage and `false` is a
 * declined attempt plus an alert.
 */
export async function verifySecret(secret: string, stored: string): Promise<boolean> {
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
  if (n <= 0 || r <= 0 || p <= 0) return false;
  if (n > MAX_ACCEPTED_N || r > MAX_ACCEPTED_R || p > MAX_ACCEPTED_P) return false;

  const expected = Buffer.from(hashRaw, 'base64url');
  const actual = await derive(secret, Buffer.from(saltRaw, 'base64url'), { n, r, p });

  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/**
 * True when a stored secret should be re-hashed with today's parameters. Call
 * it after a SUCCESSFUL verification, which is the only moment the plaintext
 * is available to re-hash with.
 */
export function needsRehashSecret(
  stored: string,
  params: ScryptParams = DEFAULT_SCRYPT_PARAMS,
): boolean {
  const parts = stored.split(':');
  if (parts.length !== 7) return true;
  const [version, algorithm, nRaw, rRaw, pRaw] = parts;
  return (
    version !== 'v1' ||
    algorithm !== 'scrypt' ||
    Number(nRaw) !== params.n ||
    Number(rRaw) !== params.r ||
    Number(pRaw) !== params.p
  );
}

/**
 * A hash of a value nobody will ever present, for the login path to compare
 * against when the account does not exist.
 *
 * Skipping the comparison when no user is found makes "unknown account" return
 * measurably faster than "wrong password", which turns the login endpoint into
 * an account-enumeration oracle. Verifying against this instead keeps both
 * paths doing the same work.
 *
 * Computed lazily and memoised rather than at module load: it costs a full
 * scrypt derivation, and paying that during import would slow every process
 * start including ones that never serve a login.
 */
let dummyHash: Promise<string> | undefined;

export function dummySecretHash(): Promise<string> {
  dummyHash ??= hashSecret(randomBytes(32).toString('base64url'));
  return dummyHash;
}
