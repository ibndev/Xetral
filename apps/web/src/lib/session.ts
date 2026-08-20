'use client';

import { MemoryTokenStore, Session, XetralClient } from '@xetral/client';
import type { Tokens, TokenStore } from '@xetral/client';

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

  async read(): Promise<Tokens | undefined> {
    const held = await this.#memory.read();
    if (held !== undefined) return held;

    // Nothing in memory — a fresh page load. The cookie may still be alive, so
    // ask. A `refresh_token` of '' is a placeholder: the real one is in the
    // cookie and the route handler reads it from there.
    const response = await fetch('/api/auth/refresh', { method: 'POST' });
    if (!response.ok) return undefined;

    const body = (await response.json()) as { access_token?: string; expires_in?: number };
    if (typeof body.access_token !== 'string') return undefined;

    const tokens: Tokens = {
      accessToken: body.access_token,
      refreshToken: '',
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
 * Routes the session's auth calls at THIS app's handlers rather than the API.
 *
 * `Session` speaks the API's auth shape, and the handlers speak the same shape
 * back — so the only difference is where the refresh token is kept, which is
 * exactly the substitution this app exists to make.
 */
async function browserAuthFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const path = String(input).replace('/api/x-auth/v1/auth/', '/api/auth/');
  return fetch(path, init);
}

/** Forgets the cached client, so the next sign-in starts clean rather than
 *  reusing a session whose tokens were just cleared. */
export function resetXetral(): void {
  cached = undefined;
}
