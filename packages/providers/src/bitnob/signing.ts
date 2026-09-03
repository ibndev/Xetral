import { createHmac, randomBytes } from 'node:crypto';

/**
 * How a request proves it came from us.
 *
 * VERIFIED against Bitnob's own documentation repository
 * (`bitnob/stealthdocs`: `api-reference/authentication/authentication.mdx`,
 * `docs/getting-started/quickstart.mdx`, `api-reference/payouts/usage-example.mdx`),
 * not inferred — every constant here is quoted from one of those pages.
 *
 * THIS FILE EXISTS BECAUSE EVERY BITNOB CALL WAS BEING REFUSED. The client
 * sent `authorization: Bearer <key>`, which is how their v1 API worked and
 * how their published Node SDK still reads. v2 does not accept it: it wants
 * four headers carrying an HMAC over the request, and a bearer token gets
 * `401 UNAUTHORIZED` with `"Invalid HMAC signature"`.
 *
 * That failure is indistinguishable, from inside the app, from a wrong key —
 * which is exactly what it looked like. Cards, crypto, FX quotes and naira
 * account numbers all reported "something went wrong" while the dashboard
 * said the credential was set. It was. It was the wrong SHAPE of credential,
 * sent the wrong way.
 *
 * Two credentials, and the asymmetry is the point:
 *
 *  - `CLIENT_ID` identifies the caller and travels in every request. Not
 *    secret.
 *  - `CLIENT_SECRET` signs, and is NEVER transmitted.
 *
 * So this is not a rename of the old API key. A deployment holding only a v1
 * key cannot sign at all, which is why `042` marks that slot as no longer in
 * use rather than quietly reusing its value under a new name.
 */

/** Four headers, spelled as their docs spell them. */
export interface SignedHeaders {
  readonly 'x-auth-client': string;
  readonly 'x-auth-timestamp': string;
  readonly 'x-auth-nonce': string;
  readonly 'x-auth-signature': string;
}

/**
 * The string the signature covers: `CLIENT_ID:TIMESTAMP:NONCE:PAYLOAD`.
 *
 * `payload` is the request body EXACTLY as it will be transmitted, and for a
 * GET it is the empty string.
 *
 * Exported separately so a test can assert the JOINING and not only the
 * digest. A digest test passes for a string assembled in the wrong order as
 * readily as for one assembled in the right one — it agrees with itself,
 * which is the failure Phase 3 records about a table of plausible constants
 * tested against the assumptions that produced it.
 */
export function stringToSign(
  clientId: string,
  timestamp: string,
  nonce: string,
  payload: string,
): string {
  return `${clientId}:${timestamp}:${nonce}:${payload}`;
}

/**
 * A timestamp in SECONDS.
 *
 * Their docs name milliseconds as one of the three things to check on a 401,
 * and it is the mistake JavaScript makes by default: `Date.now()` is
 * milliseconds, and a millisecond value is a plausible-looking integer that
 * signs cleanly and verifies nowhere. The timestamp is also what makes an old
 * request unreplayable, so a stale one is refused rather than tolerated.
 */
export function unixSeconds(now: () => number = Date.now): string {
  return Math.floor(now() / 1000).toString();
}

/**
 * Sixteen bytes from a CSPRNG, hex-encoded.
 *
 * `randomBytes`, never `Math.random`: a predictable nonce makes the
 * anti-replay guarantee decorative, and the local Semgrep rule refuses
 * `Math.random` on exactly this kind of path.
 */
export function nonce(): string {
  return randomBytes(16).toString('hex');
}

/**
 * Hex-encoded HMAC-SHA256, keyed by the client secret.
 *
 * SHA-256 here and SHA-512 in `webhooks.ts`. That is not an inconsistency to
 * tidy up: they are two schemes documented separately — this one signs what
 * we SEND, that one verifies what we RECEIVE. Making either follow the other
 * would break whichever was changed.
 */
export function sign(clientSecret: string, message: string): string {
  return createHmac('sha256', clientSecret).update(message, 'utf8').digest('hex');
}

/**
 * The four headers for one request.
 *
 * `payload` MUST be the exact body string the caller is about to transmit.
 * Their docs are explicit, and it is the trap worth naming: if the HTTP
 * client re-serialises the body — reordering keys, changing whitespace — the
 * signature covers a different string from the one that arrives, and the
 * request is refused with nothing to say why. `BitnobClient` therefore
 * serialises ONCE and passes that same string to both this function and
 * `fetch`. The Airalo adapter follows the same discipline for its own
 * signature, for the same reason.
 */
export function signedHeaders(
  clientId: string,
  clientSecret: string,
  payload: string,
  clock: () => number = Date.now,
): SignedHeaders {
  const timestamp = unixSeconds(clock);
  const requestNonce = nonce();
  return {
    'x-auth-client': clientId,
    'x-auth-timestamp': timestamp,
    'x-auth-nonce': requestNonce,
    'x-auth-signature': sign(
      clientSecret,
      stringToSign(clientId, timestamp, requestNonce, payload),
    ),
  };
}
