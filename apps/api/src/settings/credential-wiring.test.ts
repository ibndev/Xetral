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
      // `[,)]` after the name, so `bitnobApiKeyResolver(...)` — which is the
      // CORRECT spelling — does not match. The first version of this test
      // reported all five resolved clients as offenders.
      .filter((line) => /apiKey:\s*bitnobApiKey\s*[,)]/.test(line));

    expect(
      offenders,
      'these build a Bitnob client from the environment, so a key pasted on ' +
        '/admin/credentials never reaches them:\n' + offenders.join('\n'),
    ).toEqual([]);
  });

  it('every Bitnob client is built through the resolver', () => {
    const src = source();
    const clients = (src.match(/new BitnobClient\(/g) ?? []).length;
    const resolved = (src.match(/bitnobApiKeyResolver\(config, credentials\)/g) ?? []).length;

    expect(clients, 'app.module.ts builds no Bitnob clients at all').toBeGreaterThan(0);
    expect(
      resolved,
      `${clients} Bitnob clients are built and ${resolved} take a resolved key`,
    ).toBe(clients);
  });

  it('a missing key refuses with a message naming where to put one', async () => {
    // NOT `Bearer undefined`, which Bitnob answers 401 to — and a 401 reads
    // as "the key is wrong" when the truth is that there is no key. The
    // difference is what an operator does next.
    const client = new BitnobClient({
      baseUrl: 'https://example.invalid',
      apiKey: async () => undefined,
      // Would fail the request if it were ever reached; the refusal happens
      // first, which is what this asserts.
      fetch: () => {
        throw new Error('the request was sent without a key');
      },
    });

    await expect(client.request('GET', '/health')).rejects.toThrow(/no API key is configured/);
  });

  it('a resolved key is what gets sent', async () => {
    let sent: string | undefined;
    const client = new BitnobClient({
      baseUrl: 'https://example.invalid',
      apiKey: async () => 'from-the-database',
      fetch: (_url, init) => {
        sent = (init.headers as Record<string, string>)['authorization'];
        return Promise.resolve(
          new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      },
    });

    await client.request('GET', '/health');
    expect(sent).toBe('Bearer from-the-database');
  });
});
