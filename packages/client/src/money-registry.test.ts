import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EXPONENTS, exponentFor, formatMinor } from './money.js';

/**
 * THE CLIENT'S EXPONENTS ARE THE SERVER'S, CURRENCY FOR CURRENCY.
 *
 * The client keeps its own copy so a browser bundle does not import the money
 * package — and that copy had fallen two migrations behind: no USDC, no CAD,
 * so both formatted at two decimals. For USDC that is a factor of ten
 * thousand on every figure `formatMinor` drew. Read as TEXT from the
 * registry, because importing `@xetral/shared` here is exactly the dependency
 * the copy exists to avoid.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const REGISTRY = readFileSync(join(HERE, '../../shared/src/money/currency.ts'), 'utf8');

const server = new Map<string, number>();
for (const m of REGISTRY.matchAll(/^\s*([A-Z]{3,5}):\s*\{\s*exponent:\s*(\d+)/gm)) {
  server.set(m[1]!, Number(m[2]));
}

describe('the client exponent table', () => {
  it('reads a registry at all', () => {
    // A regex that matches nothing agrees with everything.
    expect(server.size).toBeGreaterThanOrEqual(10);
  });

  it('has every server currency, at the server’s exponent', () => {
    for (const [code, exponent] of server) expect([code, EXPONENTS[code]]).toEqual([code, exponent]);
  });

  it('has nothing the server does not', () => {
    for (const code of Object.keys(EXPONENTS)) expect(server.has(code)).toBe(true);
  });

  it('formats a USDC holding at six decimals', () => {
    expect(exponentFor('USDC')).toBe(6);
    expect(formatMinor('2500000', 'USDC')).toBe('2.500000 USDC');
  });
});
