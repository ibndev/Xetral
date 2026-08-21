import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Short-lived access tokens.
 *
 * WHY THIS IS NOT A JWT
 * ---------------------
 * These tokens are issued by us, to our own mobile and web clients, and
 * verified by us. There is no third party who needs to negotiate an algorithm,
 * and that is the only problem JWT's header solves. What the header reliably
 * does provide is a decade of vulnerabilities: `alg: none`, RS256 keys
 * confused into HS256 secrets, and libraries that trust `kid` as a file path.
 * Every one of those is an attacker choosing the verification rules.
 *
 * Here the algorithm is HMAC-SHA256 and cannot be stated in the token. There is
 * nothing to negotiate, so there is nothing to confuse. The version prefix
 * selects a KEY, never an algorithm, and an unrecognised version fails closed.
 *
 * The token is `v1.<payload>.<signature>`, both parts base64url.
 *
 * If Xetral ever needs a third party to verify these, that is the moment to
 * reach for a real JWT library with a pinned algorithm — not to grow this file
 * a header field.
 */

const CURRENT_FORMAT = 'v1';

export interface AccessTokenKey {
  /** Matches ^v[0-9]+$. Bumping it is how a key is rotated. */
  readonly version: string;
  /** At least 32 bytes. Never logged, never in source, never in a commit. */
  readonly secret: Buffer;
}

export interface AccessTokenKeyring {
  /** The key new tokens are signed with. */
  readonly current: AccessTokenKey;
  /**
   * Every key still accepted at verification, including `current`.
   *
   * Rotation is two deploys, not one: add the new key here first so both are
   * accepted, switch `current` once every instance has the new key, then drop
   * the old one after the longest possible token lifetime has passed. Skipping
   * the first step signs tokens with a key half the fleet cannot verify, and
   * the symptom is intermittent 401s that look like a load-balancer fault.
   */
  readonly accepted: readonly AccessTokenKey[];
}

export interface AccessTokenClaims {
  /** User uuid. Never the bigint id — internal ids should not leave the API. */
  readonly sub: string;
  /** Session uuid, so a token can be tied back to the family that issued it. */
  readonly sid: string;
  /** Device uuid. Present so a token used from an unexpected device is visible. */
  readonly did: string;
  readonly iat: number;
  readonly exp: number;
}

export type AccessTokenFailure =
  | 'malformed'
  | 'unknown_key'
  | 'bad_signature'
  | 'expired';

export type AccessTokenVerification =
  | { readonly ok: true; readonly claims: AccessTokenClaims }
  | { readonly ok: false; readonly reason: AccessTokenFailure };

function sign(signingInput: string, key: AccessTokenKey): string {
  return createHmac('sha256', key.secret).update(signingInput, 'utf8').digest('base64url');
}

/**
 * `ttlSeconds` and `nowSeconds` are parameters rather than reads of the system
 * clock so that expiry is testable without waiting, and so a caller cannot
 * accidentally issue a token whose lifetime depends on which host signed it.
 */
export function signAccessToken(
  subject: { readonly sub: string; readonly sid: string; readonly did: string },
  keyring: AccessTokenKeyring,
  nowSeconds: number,
  ttlSeconds: number,
): string {
  if (!Number.isInteger(nowSeconds) || !Number.isInteger(ttlSeconds) || ttlSeconds <= 0) {
    throw new RangeError('nowSeconds must be an integer and ttlSeconds a positive integer');
  }

  const claims: AccessTokenClaims = {
    sub: subject.sub,
    sid: subject.sid,
    did: subject.did,
    iat: nowSeconds,
    exp: nowSeconds + ttlSeconds,
  };

  const payload = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
  const signingInput = `${CURRENT_FORMAT}.${keyring.current.version}.${payload}`;
  return `${signingInput}.${sign(signingInput, keyring.current)}`;
}

/**
 * Verification order is the whole point of this function.
 *
 * The signature is checked BEFORE the payload is decoded or parsed, so no
 * attacker-controlled bytes reach `JSON.parse` until they have been proven to
 * come from us. Reversing those two steps is the ordinary way this gets
 * written, and it hands an attacker a parser to work against.
 */
export function verifyAccessToken(
  token: string,
  keyring: AccessTokenKeyring,
  nowSeconds: number,
): AccessTokenVerification {
  const parts = token.split('.');
  if (parts.length !== 4) return { ok: false, reason: 'malformed' };

  const [format, version, payload, signature] = parts;
  if (format !== CURRENT_FORMAT || version === undefined || payload === undefined) {
    return { ok: false, reason: 'malformed' };
  }
  if (signature === undefined || signature.length === 0) {
    return { ok: false, reason: 'malformed' };
  }

  const key = keyring.accepted.find((k) => k.version === version);
  if (key === undefined) return { ok: false, reason: 'unknown_key' };

  const expected = sign(`${format}.${version}.${payload}`, key);

  // timingSafeEqual throws on a length mismatch, which would itself be a timing
  // signal and a crash on malformed input. Compare lengths first and treat a
  // difference as a plain failure.
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(signature, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: 'bad_signature' };
  }

  let claims: AccessTokenClaims;
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as AccessTokenClaims;
  } catch {
    // Signed by us and still unparseable means a bug on the issuing side, not
    // an attack. Either way the token is unusable.
    return { ok: false, reason: 'malformed' };
  }

  if (
    typeof claims.sub !== 'string' ||
    typeof claims.sid !== 'string' ||
    typeof claims.did !== 'string' ||
    typeof claims.exp !== 'number' ||
    typeof claims.iat !== 'number'
  ) {
    return { ok: false, reason: 'malformed' };
  }

  // Expiry is checked last so an expired token is still proven authentic first.
  // A caller that logs 'expired' can trust the session id in it; a caller that
  // logged an unverified expiry would be logging attacker-chosen text.
  if (claims.exp <= nowSeconds) return { ok: false, reason: 'expired' };

  return { ok: true, claims };
}
