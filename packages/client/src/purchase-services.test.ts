import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PURCHASE_SERVICES } from './catalogues.js';

/**
 * EVERY TILE SENDS A SERVICE CODE THE API ACCEPTS.
 *
 * The Electricity tile sent `electricity`; the API's schema says `utility`.
 * So its catalogue and every purchase from it answered 400, on a screen that
 * looked complete. Read as text from the API's own schema, both directions.
 */
const here = new URL('.', import.meta.url).pathname;
const DTO = readFileSync(join(here, '../../../apps/api/src/purchases/dto.ts'), 'utf8');

function apiServices(): string[] {
  const match = /purchaseSchema = z\.object\(\{\s*service: z\.enum\(\[([^\]]+)\]\)/.exec(DTO);
  if (match === null) throw new Error('could not find the service enum in purchases/dto.ts');
  return [...(match[1] ?? '').matchAll(/'([a-z]+)'/g)].map((m) => m[1] as string).sort();
}

describe('purchase services', () => {
  it('offers exactly the services the API accepts', () => {
    expect(PURCHASE_SERVICES.map((s) => s.code).sort()).toEqual(apiServices());
  });
});
