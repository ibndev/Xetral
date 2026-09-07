import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MOMO_NETWORKS } from './momo-networks.js';

/*
 * READ AS TEXT, from the adapter that actually sends these codes.
 *
 * Importing `@xetral/providers` here would make the client depend on the
 * provider package — the wrong direction, and a dependency a bundler would
 * then have to follow into a browser. The same shape as
 * `crypto-networks.test.ts`, which binds three copies of the asset list this
 * way for the same reason: a code offered in one place and refused in another
 * compiles perfectly and fails on a customer.
 */
const ADAPTER = new URL(
  '../../providers/src/flutterwave/payout-adapter.ts',
  import.meta.url,
);

function adapterNetworks(): Record<string, string[]> {
  const text = readFileSync(ADAPTER, 'utf8');
  const start = text.indexOf('FLUTTERWAVE_MOBILE_MONEY_NETWORKS');
  expect(start).toBeGreaterThan(-1);
  const block = text.slice(start, text.indexOf('};', start));

  const out: Record<string, string[]> = {};
  for (const match of block.matchAll(/(\b[A-Z]{2}\b):\s*\[([\s\S]*?)\]/g)) {
    const iso = match[1];
    const body = match[2];
    if (iso === undefined || body === undefined) continue;
    out[iso] = [...body.matchAll(/code:\s*'([A-Z0-9]+)'/g)]
      .map((m) => m[1])
      .filter((c): c is string => c !== undefined);
  }
  return out;
}

describe('the picker offers exactly what the rail accepts', () => {
  const fromAdapter = adapterNetworks();

  it('found the adapter list at all', () => {
    // Guards the reader. If the regex stopped matching, every assertion below
    // would pass while comparing two empty objects — which is the failure
    // mode a scanner-based test has, and the reason this check exists.
    expect(Object.keys(fromAdapter).sort()).toEqual(['GH', 'KE']);
    expect(fromAdapter['KE']).toEqual(['MPS']);
  });

  it('names the same countries in both places', () => {
    expect(Object.keys(MOMO_NETWORKS).sort()).toEqual(Object.keys(fromAdapter).sort());
  });

  it('names the same network codes, in both directions', () => {
    for (const [iso, networks] of Object.entries(MOMO_NETWORKS)) {
      const offered = networks.map((n) => n.code).sort();
      const accepted = [...(fromAdapter[iso] ?? [])].sort();
      // A code here and not there is a picker entry that cannot be used; one
      // there and not here is a wallet nobody can link.
      expect(offered, `network codes for ${iso}`).toEqual(accepted);
    }
  });

  it('gives every network a name a person would recognise', () => {
    // The code goes on the wire; the name goes on the screen. A picker showing
    // 'VOD' asks a customer in Accra to know Flutterwave's internal spelling
    // of Telecel Cash.
    for (const networks of Object.values(MOMO_NETWORKS)) {
      for (const network of networks) {
        expect(network.name.length).toBeGreaterThan(network.code.length);
      }
    }
  });
});
