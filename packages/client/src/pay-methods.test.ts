import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PAY_METHODS } from './pay-methods.js';

/**
 * The pay page's table and the API's must be one table. Read as TEXT, because
 * this package cannot import provider code — the same shape
 * `money-registry.test.ts` uses for the exponents.
 */
describe('the pay methods the page offers', () => {
  it('ARE EXACTLY the ones the API accepts, per currency and in order', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../../providers/src/ports/checkout.ts', import.meta.url)),
      'utf8',
    );
    const block = /CHECKOUT_METHODS[^=]*=\s*\{([\s\S]*?)\n\};/.exec(source)?.[1];
    expect(block).toBeDefined();
    const server: Record<string, string[]> = {};
    for (const line of (block ?? '').split('\n')) {
      const m = /^\s*([A-Z]{3}):\s*\[([^\]]*)\]/.exec(line);
      if (m === null) continue;
      server[m[1] as string] = [...(m[2] as string).matchAll(/'([a-z_]+)'/g)].map((x) => x[1] as string);
    }
    expect(server).toEqual(PAY_METHODS);
  });
});
