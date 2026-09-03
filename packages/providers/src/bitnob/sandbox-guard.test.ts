import { describe, expect, it } from 'vitest';

import { BitnobClient } from './client.js';

/**
 * The staging guard.
 *
 * This replaces a check that could no longer see what it guarded. Bitnob v2
 * serves sandbox and production from ONE host — `https://api.bitnob.com` —
 * and the SECRET selects the environment, so `assertProviderSandbox`'s
 * substring test on the URL became both unpassable (a correct base URL has no
 * "sandbox" in it, so staging would not boot) and unsound (a URL contrived to
 * contain the word would pass while pointing at production).
 */

function respond(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function clientFor(
  environment: unknown,
  options: { requireSandbox: boolean },
): { client: BitnobClient; paths: string[] } {
  const paths: string[] = [];
  const client = new BitnobClient({
    baseUrl: 'https://api.bitnob.com',
    clientId: 'client_abc',
    clientSecret: 'sekret',
    requireSandbox: options.requireSandbox,
    fetch: (url) => {
      paths.push(new URL(url).pathname);
      return Promise.resolve(
        url.endsWith('/api/whoami')
          ? respond({ data: { environment } })
          : respond({ data: { id: 'card_1' } }),
      );
    },
  });
  return { client, paths };
}

describe('a staging deployment holding a live Bitnob secret', () => {
  it('is refused BEFORE the money-moving request is sent', async () => {
    const { client, paths } = clientFor('live', { requireSandbox: true });

    await expect(client.request('POST', '/api/cards', { customer_id: 'c1' })).rejects.toThrow(
      /requires a Bitnob SANDBOX credential/,
    );

    // The whole point. `/api/cards` must not appear: a card issued from a
    // staging box against a live account is a real card, and refusing after
    // the fact is not refusing.
    expect(paths).toEqual(['/api/whoami']);
  });

  it('is refused when the answer cannot be read at all', async () => {
    // The tempting reading of a missing field is "we could not tell, carry
    // on" — and carrying on is issuing real cards from staging.
    const { client } = clientFor(undefined, { requireSandbox: true });
    await expect(client.request('POST', '/api/cards', {})).rejects.toThrow(
      /reports undefined/,
    );
  });

  it('names what it saw, so the fix is one step', async () => {
    const { client } = clientFor('live', { requireSandbox: true });
    await expect(client.request('POST', '/api/cards', {})).rejects.toThrow(
      /Replace BITNOB_CLIENT_SECRET with the sandbox one/,
    );
  });
});

describe('a staging deployment holding a sandbox secret', () => {
  it('is allowed through', async () => {
    const { client, paths } = clientFor('sandbox', { requireSandbox: true });
    await expect(client.request('POST', '/api/cards', {})).resolves.toBeDefined();
    expect(paths).toEqual(['/api/whoami', '/api/cards']);
  });

  it('asks once, not on every request', async () => {
    // One round trip on one request. A check per call would put a provider
    // round trip in front of every provider round trip.
    const { client, paths } = clientFor('sandbox', { requireSandbox: true });
    await client.request('POST', '/api/cards', {});
    await client.request('POST', '/api/cards', {});
    await client.request('GET', '/api/balances');

    expect(paths.filter((p) => p === '/api/whoami')).toHaveLength(1);
  });

  it('asks once even when several requests race the first', async () => {
    // The single-flight latch. Without it a screen firing four requests on
    // mount asks four times — the same argument the client package makes
    // about refresh.
    const { client, paths } = clientFor('sandbox', { requireSandbox: true });
    await Promise.all([
      client.request('GET', '/api/balances'),
      client.request('GET', '/api/balances'),
      client.request('GET', '/api/balances'),
    ]);

    expect(paths.filter((p) => p === '/api/whoami')).toHaveLength(1);
  });
});

describe('production', () => {
  it('does not ask at all', async () => {
    // A live deployment signing with a live secret is the correct state, and
    // paying a round trip to confirm it would be a check that can only ever
    // say yes.
    const { client, paths } = clientFor('live', { requireSandbox: false });
    await expect(client.request('POST', '/api/cards', {})).resolves.toBeDefined();
    expect(paths).toEqual(['/api/cards']);
  });
});
