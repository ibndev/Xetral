import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * WHAT THE APPS OFFER AND WHAT THE SCHEMA ACCEPTS ARE ONE LIST.
 *
 * This is `crypto-networks.test.ts` applied to the wallet, and it exists
 * because the same failure had already happened twice in this codebase in
 * different clothes:
 *
 *  - the web app sent `TRON` to a schema expecting `tron`, so the entire
 *    crypto product answered 400 from a browser for months;
 *  - `historyQuerySchema` accepted `['NGN', 'USD']` and nothing else, so a
 *    customer holding USDT could read the balance on the home screen and
 *    could not see a single transaction behind it.
 *
 * Neither was visible from inside either half. Both lists compiled, both
 * suites passed, and each side was internally consistent — the drift only
 * shows when the two files are put next to each other, which is what this
 * does.
 *
 * BOTH DIRECTIONS. A currency the apps offer and the schema refuses is a form
 * that 400s on a field the customer filled in correctly. One the schema
 * accepts and no app offers is a currency nobody can reach, which is the
 * quieter failure and the one that lasts longer.
 */

const HERE = new URL('.', import.meta.url).pathname;
const DTO = join(HERE, 'dto.ts');
const CATALOGUES = join(HERE, '..', '..', '..', '..', 'packages', 'client', 'src', 'catalogues.ts');

/** A `const X = ['a', 'b'] as const;` declaration, read as text. */
function listNamed(source: string, name: string): readonly string[] {
  const match = source.match(new RegExp(`const ${name}\\s*=\\s*\\[([^\\]]*)\\]`));
  if (match === null) throw new Error(`no ${name} in that file`);
  return Array.from((match[1] ?? '').matchAll(/'([^']+)'/g), (m) => m[1] as string);
}

describe('the currencies a customer can send', () => {
  const dto = readFileSync(DTO, 'utf8');
  const catalogues = readFileSync(CATALOGUES, 'utf8');

  it('are the same in the apps and in the schema, in both directions', () => {
    expect([...listNamed(catalogues, 'TRANSFER_CURRENCIES')].sort()).toEqual(
      [...listNamed(dto, 'TRANSFER_CURRENCIES')].sort(),
    );
  });

  it('does not offer gift cards, which are not a currency', () => {
    /*
     * Selling a gift card is an OFFER we review and pay out for, with its own
     * screen and its own hold — not money sent to somebody. It also has no
     * currency code, so it could only ever reach the transfer schema as a
     * value that schema refuses.
     */
    const offered = listNamed(catalogues, 'TRANSFER_CURRENCIES');
    expect(offered.some((c) => /gift/i.test(c))).toBe(false);
  });
});

describe('the activity filters', () => {
  const dto = readFileSync(DTO, 'utf8');
  const catalogues = readFileSync(CATALOGUES, 'utf8');

  /** The `currency:` and `kinds:` of every ACTIVITY_FILTERS entry. */
  function filters(): readonly { currency: string; kinds: readonly string[] }[] {
    const block = catalogues.slice(catalogues.indexOf('export const ACTIVITY_FILTERS'));
    const body = block.slice(0, block.indexOf('] as const'));
    return Array.from(body.matchAll(/\{[^{}]*?currency:\s*'([^']+)'([^{}]*)\}/gs), (m) => ({
      currency: m[1] as string,
      kinds: Array.from((m[2] ?? '').matchAll(/'(giftcard_[a-z_]+)'/g), (k) => k[1] as string),
    }));
  }

  it('every one names a currency the history endpoint accepts', () => {
    // The bug this catches directly: a rail offering USDT against a schema
    // that only knows NGN and USD, which is a tab that 400s when tapped.
    const accepted = new Set(listNamed(dto, 'HISTORY_CURRENCIES'));
    const bad = filters().filter((f) => !accepted.has(f.currency));
    expect(bad, `filters the API would refuse:\n${JSON.stringify(bad)}`).toEqual([]);
  });

  it('every kind it asks for is one the schema knows', () => {
    // An unknown kind is not a 400 by accident here — it is one on purpose,
    // because the alternative is a tab that reads as "you have done nothing
    // with gift cards" when the truth is that the filter is misspelt.
    const known = new Set(listNamed(dto, 'HISTORY_KINDS'));
    const asked = filters().flatMap((f) => f.kinds);
    expect(asked.length).toBeGreaterThan(0);
    expect(asked.filter((k) => !known.has(k))).toEqual([]);
  });

  it('covers every currency a customer can send, so nothing is unreadable', () => {
    /*
     * Money a customer can MOVE is money they must be able to see the history
     * of. The reverse does not hold — a currency can arrive that cannot be
     * sent — which is why this is one direction rather than an equality.
     */
    const shown = new Set(filters().map((f) => f.currency));
    const sendable = listNamed(dto, 'TRANSFER_CURRENCIES');
    expect(sendable.filter((c) => !shown.has(c))).toEqual([]);
  });
});
