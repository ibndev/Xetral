import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BitnobClient } from '@xetral/providers';

/**
 * A PASTED KEY MUST REACH THE PROVIDER.
 *
 * `026_provider_credentials.sql` stores a key, hints it, audits it and logs
 * its rotation; `/admin/credentials` writes one; `secretFor()` reads one with
 * a five-second cache built for exactly this. And every Bitnob port was
 * constructed once at module build from `config.bitnobApiKey` — the
 * environment — so none of that reached the provider. An operator pasted a
 * key, the dashboard showed it as set, and every card, quote, address and
 * account number went on refusing with a generic error.
 *
 * Nothing could have caught it: both halves compiled, both were internally
 * consistent, and the only place they were supposed to meet was a line of
 * prose in a migration header saying the database is authoritative.
 */

const HERE = new URL('.', import.meta.url).pathname;
const MODULE = join(HERE, '..', 'app.module.ts');

function source(): string {
  return readFileSync(MODULE, 'utf8').replace(/\/\*[\s\S]*?\*\//g, ' ');
}

describe('the Bitnob key reaches the adapters', () => {
  it('no port captures the environment key directly', () => {
    // `bitnobApiKey` may appear ONLY inside the resolver, which is the one
    // place the environment is read — and it reads it as a FALLBACK behind
    // the database. A `apiKey: bitnobApiKey` anywhere else is a port that
    // ignores whatever an operator pasted.
    const offenders = source()
      .split('\n')
      // `[,)]` after the name, so `bitnobCredentials(...)` — which is the
      // CORRECT spelling — does not match. The first version of this test
      // reported all five resolved clients as offenders.
      .filter((line) => /client(Id|Secret):\s*config\.bitnobClient(Id|Secret)\s*[,)]/.test(line));

    expect(
      offenders,
      'these build a Bitnob client from the environment, so a key pasted on ' +
        '/admin/credentials never reaches them:\n' + offenders.join('\n'),
    ).toEqual([]);
  });

  it('every Bitnob client is built through the resolver', () => {
    const src = source();
    const clients = (src.match(/new BitnobClient\(/g) ?? []).length;
    const resolved = (src.match(/\.\.\.bitnobCredentials\(config, credentials\)/g) ?? []).length;

    expect(clients, 'app.module.ts builds no Bitnob clients at all').toBeGreaterThan(0);
    expect(
      resolved,
      `${clients} Bitnob clients are built and ${resolved} take resolved credentials`,
    ).toBe(clients);
  });

  it('a missing credential refuses with a message naming where to put one', async () => {
    // NOT an unsigned request, which Bitnob answers 401 to — and a 401 reads
    // as "the credential is wrong" when the truth is that there is none. The
    // difference is what an operator does next.
    const client = new BitnobClient({
      baseUrl: 'https://example.invalid',
      clientId: async () => undefined,
      clientSecret: async () => undefined,
      // Would fail the request if it were ever reached; the refusal happens
      // first, which is what this asserts.
      fetch: () => {
        throw new Error('the request was sent without credentials');
      },
    });

    await expect(client.request('GET', '/api/whoami')).rejects.toThrow(
      /no Bitnob client id and no client secret is configured/,
    );
  });

  it('names the half that is missing, when only one is', async () => {
    // An operator with an id and no secret is one paste away from working. A
    // message naming both would send them to check the one that is already
    // right.
    const client = new BitnobClient({
      baseUrl: 'https://example.invalid',
      clientId: async () => 'client_live_abc',
      clientSecret: async () => undefined,
      fetch: () => {
        throw new Error('the request was sent unsigned');
      },
    });

    await expect(client.request('GET', '/api/whoami')).rejects.toThrow(
      /no Bitnob client secret is configured/,
    );
  });

  it('resolved credentials are what sign the request', async () => {
    let headers: Record<string, string> = {};
    const client = new BitnobClient({
      baseUrl: 'https://example.invalid',
      clientId: async () => 'client_from_the_database',
      clientSecret: async () => 'secret_from_the_database',
      fetch: (_url, init) => {
        headers = init.headers as Record<string, string>;
        return Promise.resolve(
          new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      },
    });

    await client.request('GET', '/api/whoami');

    expect(headers['x-auth-client']).toBe('client_from_the_database');
    expect(headers['x-auth-signature']).toMatch(/^[0-9a-f]{64}$/);
    // THE SECRET IS NEVER TRANSMITTED. Asserted over every header value
    // rather than over the one it might plausibly appear in, because what is
    // being guarded against is the header nobody thought to check.
    expect(Object.values(headers).join(' ')).not.toContain('secret_from_the_database');
    // And no bearer token survives from the v1 shape.
    expect(headers['authorization']).toBeUndefined();
  });
});
