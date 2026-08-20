import { describe, expect, it, vi } from 'vitest';
import { XetralClient } from './client.js';
import { MemoryTokenStore, Session } from './session.js';

const NOW = 1_800_000_000;

function respond(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function makeClient(fetchImpl: ReturnType<typeof vi.fn>) {
  const store = new MemoryTokenStore();
  await store.write({ accessToken: 'a1', refreshToken: 'r1', expiresAt: NOW + 900 });

  const session = new Session({
    baseUrl: 'https://api.test',
    store,
    fetch: fetchImpl as unknown as typeof fetch,
    nowSeconds: () => NOW,
  });
  return new XetralClient({
    baseUrl: 'https://api.test',
    session,
    fetch: fetchImpl as unknown as typeof fetch,
  });
}

describe('requests', () => {
  it('carries the bearer token', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) =>
      respond(200, { balances: [] }),
    );
    const client = await makeClient(fetchImpl);
    await client.balances();

    const init = fetchImpl.mock.calls[0]?.[1];
    expect((init?.headers as Record<string, string>)['authorization']).toBe('Bearer a1');
  });

  it('keeps money as strings all the way through', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) =>
      respond(200, {
        balances: [
          { currency: 'BTC', spendable: '0.12345678', pending: '0.00000000', total: '0.12345678' },
        ],
      }),
    );
    const client = await makeClient(fetchImpl);
    const [balance] = await client.balances();

    expect(balance?.spendable).toBe('0.12345678');
    expect(typeof balance?.spendable).toBe('string');
  });

  it('refreshes ONCE and retries after a 401', async () => {
    let refreshes = 0;
    let walletCalls = 0;
    const fetchImpl = vi.fn(async (url: string) => {
      const path = String(url);
      if (path.endsWith('/v1/auth/refresh')) {
        refreshes += 1;
        return respond(200, { access_token: 'a2', refresh_token: 'r2', expires_in: 900 });
      }
      walletCalls += 1;
      if (walletCalls === 1) return respond(401, { error: 'invalid_token' });
      return respond(200, { balances: [] });
    });

    const client = await makeClient(fetchImpl);
    await expect(client.balances()).resolves.toEqual([]);
    expect(refreshes).toBe(1);
    expect(walletCalls).toBe(2);
  });

  it('does not loop when the retry also fails', async () => {
    // A frozen account or a revoked device produces a 401 that refreshing
    // cannot fix, and every attempt consumes a refresh token.
    let refreshes = 0;
    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url).endsWith('/v1/auth/refresh')) {
        refreshes += 1;
        return respond(200, { access_token: 'a2', refresh_token: 'r2', expires_in: 900 });
      }
      return respond(401, { error: 'invalid_token' });
    });

    const client = await makeClient(fetchImpl);
    await expect(client.balances()).rejects.toMatchObject({ code: 'invalid_token' });
    expect(refreshes).toBe(1);
  });

  it('reports a dropped connection as a network error, not an API one', async () => {
    // "Insufficient funds" and "your train went into a tunnel" need very
    // different words on screen.
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => {
      throw new TypeError('failed to fetch');
    });
    const client = await makeClient(fetchImpl);
    await expect(client.balances()).rejects.toMatchObject({ code: 'network' });
  });

  it('maps insufficient funds without inventing a figure', async () => {
    // The API deliberately sends no balance. A client that filled one in would
    // undo the server-side decision that stops a stolen session farming it.
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) =>
      respond(422, { error: 'insufficient_funds' }),
    );
    const client = await makeClient(fetchImpl);

    await expect(
      client.transfer({
        recipient: 'them@example.ng',
        amount: '5000.00',
        currency: 'NGN',
        pin: '374915',
        idempotencyKey: 'k1',
      }),
    ).rejects.toMatchObject({ code: 'insufficient_funds', isUserFixable: true });
  });

  it('does not widen its error union on an unrecognised code', async () => {
    // A proxy or an error page must not be able to inject a code a caller's
    // switch would then handle as if we had sent it.
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) =>
      respond(500, { error: 'something_new' }),
    );
    const client = await makeClient(fetchImpl);
    await expect(client.balances()).rejects.toMatchObject({ code: 'unknown' });
  });

  it('sends the PIN in the body, never the query string', async () => {
    // Query strings land in access logs, proxy logs and browser history.
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) =>
      respond(200, { status: 'delivered' }),
    );
    const client = await makeClient(fetchImpl);

    await client.buy({
      service: 'data',
      itemCode: 'mtn:1gb',
      target: '08030000000',
      amount: '350.00',
      pin: '374915',
      idempotencyKey: 'k1',
    });

    const call = fetchImpl.mock.calls[0];
    expect(String(call?.[0])).not.toContain('374915');
    expect(String(call?.[1]?.body)).toContain('374915');
  });
});
