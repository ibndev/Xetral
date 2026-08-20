import { describe, expect, it, vi } from 'vitest';
import { MemoryTokenStore, Session } from './session.js';
import { SessionExpiredError } from './errors.js';

const NOW = 1_800_000_000;

function respond(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function makeSession(
  fetchImpl: ReturnType<typeof vi.fn>,
  options: { onSignedOut?: () => void } = {},
) {
  const store = new MemoryTokenStore();
  const session = new Session({
    baseUrl: 'https://api.test',
    store,
    fetch: fetchImpl as unknown as typeof fetch,
    nowSeconds: () => NOW,
    ...(options.onSignedOut === undefined ? {} : { onSignedOut: options.onSignedOut }),
  });
  return { session, store };
}

describe('signing in', () => {
  it('stores the tokens it was given', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) =>
      respond(200, { access_token: 'a1', refresh_token: 'r1', expires_in: 900 }),
    );
    const { session, store } = makeSession(fetchImpl);

    await session.signIn('me@example.ng', 'pw', { fingerprint: 'fp', platform: 'ios' });

    expect(await store.read()).toMatchObject({ accessToken: 'a1', refreshToken: 'r1' });
  });

  it('reports bad credentials as such', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) =>
      respond(401, { error: 'invalid_credentials' }),
    );
    const { session } = makeSession(fetchImpl);

    await expect(
      session.signIn('me@example.ng', 'wrong', { fingerprint: 'fp', platform: 'ios' }),
    ).rejects.toMatchObject({ code: 'invalid_credentials' });
  });
});

describe('single-flight refresh', () => {
  it('sends ONE refresh for many concurrent callers', async () => {
    // THE test this file exists for. Refresh tokens rotate and a replayed one
    // revokes the whole device family — so a screen firing four requests on
    // mount must not send four refreshes with the same token, or the server
    // correctly reads three as theft and signs the customer out for opening a
    // page.
    let refreshes = 0;
    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url).endsWith('/v1/auth/refresh')) {
        refreshes += 1;
        // Slow, so the callers genuinely overlap.
        await new Promise((resolve) => setTimeout(resolve, 20));
        return respond(200, {
          access_token: `a${refreshes + 1}`,
          refresh_token: `r${refreshes + 1}`,
          expires_in: 900,
        });
      }
      return respond(200, { access_token: 'a1', refresh_token: 'r1', expires_in: 900 });
    });

    const { session, store } = makeSession(fetchImpl);
    await session.signIn('me@example.ng', 'pw', { fingerprint: 'fp', platform: 'ios' });
    // Expire it.
    await store.write({ accessToken: 'a1', refreshToken: 'r1', expiresAt: NOW - 1 });

    const tokens = await Promise.all([
      session.accessToken(),
      session.accessToken(),
      session.accessToken(),
      session.accessToken(),
    ]);

    expect(refreshes).toBe(1);
    // And all four got the SAME new token, not one each.
    expect(new Set(tokens).size).toBe(1);
    expect(tokens[0]).toBe('a2');
  });

  it('allows a NEW refresh after the first settles', async () => {
    // The latch must clear. A refresh that wedged it would leave the session
    // unable to rotate ever again — a slow logout rather than an obvious one.
    let refreshes = 0;
    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url).endsWith('/v1/auth/refresh')) {
        refreshes += 1;
        return respond(200, {
          access_token: `a${refreshes + 1}`,
          refresh_token: `r${refreshes + 1}`,
          expires_in: 900,
        });
      }
      return respond(200, { access_token: 'a1', refresh_token: 'r1', expires_in: 900 });
    });

    const { session } = makeSession(fetchImpl);
    await session.signIn('me@example.ng', 'pw', { fingerprint: 'fp', platform: 'ios' });

    await session.refresh();
    await session.refresh();
    expect(refreshes).toBe(2);
  });

  it('clears the latch after a FAILED refresh', async () => {
    // A failure must not wedge the session either. This one fails on a 500,
    // which is transient and worth retrying — unlike a 401.
    let attempts = 0;
    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url).endsWith('/v1/auth/refresh')) {
        attempts += 1;
        if (attempts === 1) return respond(500, { error: 'upstream' });
        return respond(200, { access_token: 'a2', refresh_token: 'r2', expires_in: 900 });
      }
      return respond(200, { access_token: 'a1', refresh_token: 'r1', expires_in: 900 });
    });

    const { session } = makeSession(fetchImpl);
    await session.signIn('me@example.ng', 'pw', { fingerprint: 'fp', platform: 'ios' });

    await expect(session.refresh()).rejects.toBeDefined();
    // The second attempt is allowed and succeeds.
    await expect(session.refresh()).resolves.toMatchObject({ accessToken: 'a2' });
    expect(attempts).toBe(2);
  });
});

describe('a session that is over', () => {
  it('signs the customer out on invalid_grant, without retrying', async () => {
    // invalid_grant means consumed, expired or revoked — including the family
    // being revoked because somebody replayed a stolen token. There is nothing
    // to retry, and retrying would consume more tokens.
    const onSignedOut = vi.fn();
    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url).endsWith('/v1/auth/refresh')) {
        return respond(401, { error: 'invalid_grant' });
      }
      return respond(200, { access_token: 'a1', refresh_token: 'r1', expires_in: 900 });
    });

    const { session, store } = makeSession(fetchImpl, { onSignedOut });
    await session.signIn('me@example.ng', 'pw', { fingerprint: 'fp', platform: 'ios' });

    await expect(session.refresh()).rejects.toBeInstanceOf(SessionExpiredError);
    expect(onSignedOut).toHaveBeenCalledOnce();
    // And the tokens are gone locally, so nothing tries again with them.
    expect(await store.read()).toBeUndefined();
  });

  it('refuses to hand out a token when there is none', async () => {
    const onSignedOut = vi.fn();
    const { session } = makeSession(vi.fn(), { onSignedOut });
    await expect(session.accessToken()).rejects.toBeInstanceOf(SessionExpiredError);
    expect(onSignedOut).toHaveBeenCalledOnce();
  });
});

describe('proactive refresh', () => {
  it('refreshes BEFORE the token expires, not after a 401', async () => {
    // Waiting for the 401 means every customer's first action after fifteen
    // minutes costs an extra round trip and a failed request.
    let refreshed = false;
    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url).endsWith('/v1/auth/refresh')) {
        refreshed = true;
        return respond(200, { access_token: 'a2', refresh_token: 'r2', expires_in: 900 });
      }
      return respond(200, { access_token: 'a1', refresh_token: 'r1', expires_in: 900 });
    });

    const { session, store } = makeSession(fetchImpl);
    await session.signIn('me@example.ng', 'pw', { fingerprint: 'fp', platform: 'ios' });
    // Thirty seconds left: inside the skew window, not yet expired.
    await store.write({ accessToken: 'a1', refreshToken: 'r1', expiresAt: NOW + 30 });

    expect(await session.accessToken()).toBe('a2');
    expect(refreshed).toBe(true);
  });

  it('does not refresh a token with plenty of life left', async () => {
    let refreshed = false;
    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url).endsWith('/v1/auth/refresh')) refreshed = true;
      return respond(200, { access_token: 'a1', refresh_token: 'r1', expires_in: 900 });
    });

    const { session } = makeSession(fetchImpl);
    await session.signIn('me@example.ng', 'pw', { fingerprint: 'fp', platform: 'ios' });

    expect(await session.accessToken()).toBe('a1');
    expect(refreshed).toBe(false);
  });
});

describe('signing out', () => {
  it('clears locally even when the network call fails', async () => {
    // The opposite order leaves a customer holding live tokens because a
    // request timed out — on the one action they took to become safe.
    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url).endsWith('/v1/auth/logout')) throw new Error('offline');
      return respond(200, { access_token: 'a1', refresh_token: 'r1', expires_in: 900 });
    });

    const { session, store } = makeSession(fetchImpl);
    await session.signIn('me@example.ng', 'pw', { fingerprint: 'fp', platform: 'ios' });

    await session.signOut();
    expect(await store.read()).toBeUndefined();
  });
});
