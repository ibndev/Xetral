/**
 * The caller's address, on its way to the API.
 *
 * WITHOUT THIS THE LIMITER PROTECTING SIGN-IN IS A DENIAL OF SERVICE AGAINST
 * OUR OWN CUSTOMERS. Everything the web app sends reaches the API over a fresh
 * server-side `fetch`, so the address the API sees is this container's, not the
 * customer's — and the login limiter's per-IP bucket is therefore ONE bucket
 * shared by every web customer at once. At the production default of 30 per
 * fifteen minutes, the thirty-first sign-in from the whole web app is refused,
 * and it refuses a customer rather than an attacker. It would fire first on the
 * busiest morning.
 *
 * Demonstrated against the built bundle: three logins carrying three different
 * `x-forwarded-for` values each got their own bucket; three carrying none — the
 * shape this app was sending — shared one, and the third was refused.
 *
 * COPIED, NOT APPENDED, and that is the part worth reading twice. The API
 * resolves the client address with Express's `trust proxy` HOP COUNT, and a
 * header this app added an entry to would be one hop longer than the same
 * request arriving by any other path — one number cannot be correct for two
 * path lengths. Copying keeps every shape identical, so `TRUST_PROXY_HOPS`
 * means one thing.
 *
 * That now covers the phone as well as the browser: `apps/mobile` reaches the
 * API through this proxy rather than through a public API hostname, so a
 * request from a handset and a request from a tab are the same shape by the
 * time the limiter counts them.
 *
 * The value is whatever the edge put there. This app never adds to it and never
 * invents one: a header a browser was able to set is the thing the hop count
 * exists to discard, and forging one here would launder it.
 */
export function forwardedFor(request: Request): Record<string, string> {
  const forwarded = request.headers.get('x-forwarded-for');
  return forwarded === null ? {} : { 'x-forwarded-for': forwarded };
}
