import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * THE CLIENTS AND THE SCHEMA AGREE ABOUT WHAT A CHAIN IS CALLED.
 *
 * They did not, and it broke the whole crypto product on the web. The browser
 * app sent `TRON`, `ETHEREUM` and `BITCOIN`; this file's `NETWORKS` is
 * lowercase and `z.enum` is case-sensitive. So every deposit address, every
 * fee quote and every withdrawal attempted from a browser was refused with
 * `400 invalid_request` on the `network` field — which the customer reads as
 * "Some details are missing or invalid", pointing at a form they filled in
 * correctly. The web was also missing `bsc` entirely.
 *
 * Nothing could see it. The API's own e2e suite drives the endpoints with the
 * correct casing, so it passed; the web app compiled, because a string is a
 * string; and the two lists sat in different workspaces, each internally
 * consistent. It was only visible by putting the two files side by side.
 *
 * Both directions, deliberately. A network the schema accepts and no client
 * offers is a chain customers cannot reach; one a client offers and the schema
 * refuses is the bug above.
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

describe('the chain names the clients send', () => {
  const dto = readFileSync(DTO, 'utf8');
  const catalogues = readFileSync(CATALOGUES, 'utf8');

  it('matches the schema exactly, in both directions', () => {
    expect([...listNamed(catalogues, 'CRYPTO_NETWORKS')].sort()).toEqual(
      [...listNamed(dto, 'NETWORKS')].sort(),
    );
  });

  it('and so do the asset codes', () => {
    expect([...listNamed(catalogues, 'CRYPTO_ASSETS')].sort()).toEqual(
      [...listNamed(dto, 'ASSETS')].sort(),
    );
  });

  it('every offered pair names a network and an asset the schema accepts', () => {
    // The lists agreeing is not enough: a pair is what actually gets sent, and
    // `{ asset: 'BTC', network: 'tron' }` would be two valid halves and one
    // request nothing can serve.
    const networks = new Set(listNamed(dto, 'NETWORKS'));
    const assets = new Set(listNamed(dto, 'ASSETS'));
    const pairs = Array.from(
      catalogues.matchAll(/\{\s*asset:\s*'([^']+)',\s*network:\s*'([^']+)'/g),
      (m) => ({ asset: m[1] as string, network: m[2] as string }),
    );

    expect(pairs.length).toBeGreaterThan(0);
    const bad = pairs.filter((p) => !assets.has(p.asset) || !networks.has(p.network));
    expect(bad, `pairs the API would refuse:\n${JSON.stringify(bad)}`).toEqual([]);
  });
});
