import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Every HTTP method the API declares, the web proxy forwards.
 *
 * `/api/x/[...path]/route.ts` exported GET and POST, and the API declares
 * DELETE on four routes — so deleting a retired FX rate or spread, removing a
 * recipient and unlinking a wallet were answered 405 by Next itself and never
 * reached the server. The route table and the proxy are two lists of one fact,
 * read here as text so the one that is added to is not the only one checked.
 */
const here = new URL('.', import.meta.url).pathname;
const ROUTES = readFileSync(join(here, '../../../api/src/auth/routes.ts'), 'utf8');
const PROXY = readFileSync(join(here, '../app/api/x/[...path]/route.ts'), 'utf8');

describe('the same-origin proxy', () => {
  it('forwards every method the API declares', () => {
    const declared = new Set(
      [...ROUTES.matchAll(/\.(?:public|authenticated|staff)\(\s*'([A-Z]+)'/g)].map((m) => m[1]),
    );
    expect(declared.size).toBeGreaterThanOrEqual(2);
    for (const method of declared) {
      expect(PROXY, `the proxy does not forward ${method}`).toMatch(
        new RegExp(`export async function ${method}\\(`),
      );
    }
  });
});
