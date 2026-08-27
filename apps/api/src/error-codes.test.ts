import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { knownErrorCodes } from '@xetral/client';
import { describe, expect, it } from 'vitest';

/**
 * Every code the API can emit must be a code a client can name.
 *
 * `toApiError` flattens an unrecognised code to `unknown`, which is the right
 * behaviour — a proxy must not be able to inject a code a caller's `switch`
 * then handles as though we sent it. But it means a code added here and not
 * added there fails SILENTLY and in the worst possible place: the customer
 * sees "Something went wrong. Please try again." for a problem they could have
 * fixed in five seconds, and nothing anywhere goes red.
 *
 * This test is the red thing. It reads the codes out of the source rather than
 * from a list somebody maintains, because a list somebody maintains is exactly
 * what drifted.
 */

const SOURCE = dirname(fileURLToPath(import.meta.url));

/**
 * Codes that never reach a legitimate client, each with the reason.
 *
 * Being on this list is a claim, not an exemption: it says a customer's app
 * cannot receive this code in any flow. Adding one without that being true
 * hides the very failure the test exists to catch, so the reason is required
 * and is read in review.
 */
const INTERNAL: Readonly<Record<string, string>> = {
  // Webhook authentication. The only caller is a provider, which has no UI.
  invalid_signature: 'answered to a provider webhook, never to an app',
  raw_body_unavailable: 'a bootstrap fault in webhook body capture, not a client condition',
  // Deployment faults. A client can do nothing with these beyond "try later",
  // which `unknown` already says.
  encryption_not_configured: 'the keyring is unset — an operator fault, not a customer one',
  // The deny-by-default guard's own refusal, for a route that does not exist
  // in any client.
  route_not_declared: 'raised for an undeclared route, which no shipped client calls',
};

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return name.endsWith('.ts') && !name.endsWith('.d.ts') ? [path] : [];
  });
}

/** Reads `error: 'some_code'` out of the source. Deliberately crude: the point
 *  is to find codes nobody remembered to register, and a clever parser that
 *  missed one would defeat that. */
function emittedCodes(): ReadonlySet<string> {
  const found = new Set<string>();
  for (const file of sourceFiles(SOURCE)) {
    if (file.endsWith('.test.ts')) continue;
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(/error: '([a-z_]+)'/g)) {
      const code = match[1];
      if (code !== undefined) found.add(code);
    }
    // A code chosen by a ternary is invisible to the pattern above, because
    // what follows `error:` is an expression rather than a literal. Two codes
    // were reaching customers that way with no client-side name, and the
    // scanner reported full coverage — the same shape as the route-coverage
    // test walking its own hand-written list.
    for (const match of text.matchAll(
      /error:\s*[^,\n]*?\?\s*'([a-z_]+)'\s*:\s*'([a-z_]+)'/g,
    )) {
      for (const code of [match[1], match[2]]) {
        if (code !== undefined) found.add(code);
      }
    }
  }
  return found;
}

describe('the API cannot emit a code the client flattens', () => {
  const emitted = emittedCodes();

  it('found the codes at all', () => {
    // Guards the scanner. If the regex stopped matching, every assertion below
    // would pass while checking nothing.
    expect(emitted.size).toBeGreaterThan(40);
    expect(emitted.has('insufficient_funds')).toBe(true);
  });

  it('has a client-side name for every customer-reachable code', () => {
    const known = new Set(knownErrorCodes());
    const orphans = [...emitted]
      .filter((code) => !known.has(code) && INTERNAL[code] === undefined)
      .sort();

    expect(orphans).toEqual([]);
  });

  it('does not carry a client code the API never sends', () => {
    // The other direction. A code in the client that the API cannot produce is
    // dead branch in every error switch, and reads as though a case is handled
    // when nothing will ever reach it.
    const unreachable = knownErrorCodes()
      .filter((code) => !emitted.has(code))
      .sort();

    expect(unreachable).toEqual([]);
  });

  it('explains every code it calls internal', () => {
    for (const [code, reason] of Object.entries(INTERNAL)) {
      expect(reason.length, code).toBeGreaterThan(20);
      // And it must actually be emitted — a stale entry here is a claim about
      // a code that no longer exists.
      expect(emitted.has(code), `${code} is no longer emitted`).toBe(true);
    }
  });
});
