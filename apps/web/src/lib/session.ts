'use client';

import { MemoryTokenStore, Session, XetralClient } from '@xetral/client';
import type { Tokens, TokenStore } from '@xetral/client';

/**
 * The placeholder standing in for the refresh token the page never sees.
 *
 * Declared here rather than beside `browserAuthFetch` because the store needs
 * it too, and two spellings of the same placeholder is a bug waiting for
 * somebody to compare them.
 */
const COOKIE_HELD = 'held-in-an-httponly-cookie';

/**
 * The browser's view of a session.
 *
 * The ACCESS token lives in memory — deliberately not `localStorage`, which
 * any injected script can read, and not `sessionStorage` either. Losing it on
 * refresh is not a problem: the refresh token is in an httpOnly cookie, so the
 * page asks `/api/auth/refresh` and gets a new one without the customer
 * noticing.
 *
 * The REFRESH token is never here at all. It cannot be: the cookie is
 * httpOnly, which is the entire point.
 */
class BrowserTokenStore implements TokenStore {
  readonly #memory = new MemoryTokenStore();

  /**
   * THE SECOND SINGLE-FLIGHT LATCH, and it is not optional.
   *
   * `Session` has one on `refresh()`, which is what Phase 11 was asked for and
   * what stops several requests rotating the same token. It does not cover
   * THIS path. On a fresh page load nothing is in memory, so every caller of
   * `read()` goes to `/api/auth/refresh` to exchange the cookie — and `read()`
   * is called by `accessToken()`, which every single request calls first.
   *
   * So a page with two components loading data on mount sent two refreshes
   * carrying the same cookie, the server correctly read the second as a
   * replayed token, and it revoked the whole device family. The customer was
   * signed out for opening a page — the precise failure Phase 2 accepted as a
   * cost and assigned to the client to fix, reintroduced one layer below where
   * the fix was put.
   *
   * Found by driving the built app in a browser. Neither the type system nor
   * the client's own unit tests could see it: the latch that exists is real,
   * correct, and on the wrong function.
   */
  #bootstrapping: Promise<Tokens | undefined> | undefined;

  async read(): Promise<Tokens | undefined> {
    const held = await this.#memory.read();
    if (held !== undefined) return held;

    if (this.#bootstrapping !== undefined) return this.#bootstrapping;

    this.#bootstrapping = this.#exchangeCookie().finally(() => {
      // Cleared in a `finally` so a failed exchange does not wedge the store
      // into a state where no further attempt is possible.
      this.#bootstrapping = undefined;
    });
    return this.#bootstrapping;
  }

  /**
   * Nothing in memory — a fresh page load. The cookie may still be alive, so
   * ask. Exactly one of these is ever in flight.
   */
  async #exchangeCookie(): Promise<Tokens | undefined> {
    const response = await fetch('/api/auth/refresh', { method: 'POST' });
    if (!response.ok) return undefined;

    const body = (await response.json()) as { access_token?: string; expires_in?: number };
    if (typeof body.access_token !== 'string') return undefined;

    const tokens: Tokens = {
      accessToken: body.access_token,
      // A placeholder. The real one is in the httpOnly cookie, which is the
      // point — see browserAuthFetch below.
      refreshToken: COOKIE_HELD,
      expiresAt: Math.floor(Date.now() / 1000) + (body.expires_in ?? 900),
    };
    await this.#memory.write(tokens);
    return tokens;
  }

  async write(tokens: Tokens): Promise<void> {
    await this.#memory.write(tokens);
  }

  async clear(): Promise<void> {
    await this.#memory.clear();
    // A clear during a bootstrap must not be undone by that bootstrap's own
    // write landing afterwards. Dropping the latch means the in-flight
    // exchange still resolves for whoever awaited it and no new caller joins.
    this.#bootstrapping = undefined;
  }
}

let cached: { session: Session; client: XetralClient } | undefined;

/**
 * One session and one client for the whole tab.
 *
 * A module-level singleton, and it has to be: the single-flight refresh latch
 * lives on the `Session` instance, so a component that built its own would
 * refresh in parallel with everybody else's — which is the exact thing the
 * latch exists to prevent, and would sign the customer out.
 */
export function xetral(onSignedOut?: () => void): { session: Session; client: XetralClient } {
  if (cached !== undefined) return cached;

  const session = new Session({
    // Same origin, through the proxy. The API's real address is server-side
    // only.
    baseUrl: '/api/x-auth',
    store: new BrowserTokenStore(),
    ...(onSignedOut === undefined ? {} : { onSignedOut }),
    fetch: browserAuthFetch,
  });

  const client = new XetralClient({ baseUrl: '/api/x', session });
  cached = { session, client };
  return cached;
}

/**
 * Routes the session's auth calls at THIS app's handlers rather than the API,
 * and puts back the one field they deliberately withhold.
 *
 * `Session` is written against the API, where a login response carries a
 * refresh token. Here it must not: the whole point of the route handlers is
 * that the refresh token goes into an httpOnly cookie and never reaches the
 * page. So the response is missing a field `Session` requires.
 *
 * The placeholder is substituted HERE rather than making the field optional in
 * `Session`, because on mobile it genuinely is required — the Keychain is the
 * only place it lives. Weakening the shared type to fit one platform would
 * remove a real guarantee from the other. The value is never sent anywhere:
 * `/api/auth/refresh` reads the cookie and ignores its body.
 */
/**
 * The FOUR auth calls this app answers itself, because they touch the cookie.
 *
 * Everything else the session makes goes to the ordinary proxy. That
 * distinction was implicit — the rewrite matched the whole `/v1/auth/` prefix
 * — and being implicit is what broke two things silently.
 */
const COOKIE_ROUTES: readonly string[] = ['login', 'register', 'refresh', 'logout'];

async function browserAuthFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const path = rewrite(String(input));
  const response = await fetch(path, init);

  if (!response.ok || !path.includes('/api/auth/')) return response;

  const body = (await response.json().catch(() => undefined)) as
    | Record<string, unknown>
    | undefined;
  if (body === undefined) return response;

  return new Response(JSON.stringify({ ...body, refresh_token: COOKIE_HELD }), {
    status: response.status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * WHERE A SESSION CALL ACTUALLY GOES — and the bug this exists to close.
 *
 * `/api/x-auth` is a SENTINEL, not a route: nothing serves it, and this
 * function is the only reason any request to it succeeds. The old rewrite
 * replaced `/api/x-auth/v1/auth/` with `/api/auth/` and left everything else
 * alone — so any session call that was not under `/v1/auth/` went out to a
 * prefix no route handler answers and got a 404.
 *
 * `Session.countries()` is exactly that. It requests `/v1/countries`, which
 * never matched, so THE COUNTRY LIST HAS NEVER LOADED ON THE WEB: the signup
 * form's country picker was permanently empty and the dialling code
 * permanently rendered its placeholder. Reported as the picker not responding
 * and the code not appearing, which reads as a styling fault and is a 404.
 *
 * The `/v1/auth/` prefix was not safe either. Only FOUR auth routes are
 * answered by this app — the ones that must handle the refresh cookie — and
 * the rewrite sent every other one to `/api/auth/...`, where nothing serves
 * it. Password reset is under `/v1/auth/` and would have 404'd the same way.
 *
 * So the rule is stated the other way round: the four cookie routes go to this
 * app's handlers, and EVERYTHING ELSE goes to the proxy, which is where the
 * API is. A session call added later is served by default rather than lost by
 * default. `session-routing.test.ts` keeps the four in step with the route
 * handlers that exist.
 */
function rewrite(url: string): string {
  const auth = /\/api\/x-auth\/v1\/auth\/([a-z-]+)/.exec(url);
  if (auth !== null && COOKIE_ROUTES.includes(auth[1] ?? '')) {
    return url.replace('/api/x-auth/v1/auth/', '/api/auth/');
  }
  // The ordinary same-origin proxy. Same shape as `XetralClient`'s base.
  return url.replace('/api/x-auth/', '/api/x/');
}

/** Forgets the cached client, so the next sign-in starts clean rather than
 *  reusing a session whose tokens were just cleared. */
export function resetXetral(): void {
  cached = undefined;
}
