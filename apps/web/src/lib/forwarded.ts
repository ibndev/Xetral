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
  return {
    ...(forwarded === null ? {} : { 'x-forwarded-for': forwarded }),
    ...clientOrigin(request),
  };
}

/** Must equal `PROXY_HEADERS` in the API's `sign-in-events.service.ts`;
 *  `sign-in-origin.test.ts` there reads this file and fails on a drift. */
export const PROXY_HEADERS = {
  secret: 'x-xetral-proxy-secret',
  ip: 'x-xetral-client-ip',
  country: 'x-xetral-client-country',
} as const;

/**
 * Where the CUSTOMER was, as Cloudflare told THIS app.
 *
 * THE API CANNOT WORK IT OUT FOR ITSELF. This app's request to the API is a
 * second trip through Cloudflare, and the country Cloudflare stamps on that
 * one is this server's — Germany. A customer signing in from Lagos was
 * emailed "Sign-in from a new country: DE". Only this app saw the customer's
 * own request, so it relays `CF-IPCountry` and `CF-Connecting-IP` from THAT —
 * values Cloudflare sets itself and overwrites whatever a browser sent.
 *
 * VOUCHED WITH `WEB_PROXY_SECRET`, the same value on both services. Without it
 * the API cannot tell this app from anybody else typing a country, and a
 * forged one is how a takeover would keep the alert quiet; so with no secret
 * nothing is sent and the API records no country rather than a wrong one.
 */
function clientOrigin(request: Request): Record<string, string> {
  const secret = process.env['WEB_PROXY_SECRET'];
  if (secret === undefined || secret === '') return {};
  const ip = request.headers.get('cf-connecting-ip');
  const country = request.headers.get('cf-ipcountry');
  return {
    [PROXY_HEADERS.secret]: secret,
    ...(ip === null ? {} : { [PROXY_HEADERS.ip]: ip }),
    ...(country === null ? {} : { [PROXY_HEADERS.country]: country }),
  };
}
