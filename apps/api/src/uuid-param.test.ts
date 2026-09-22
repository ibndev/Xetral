import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NotFoundException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { isUuid, uuidOr404 } from './uuid-param.js';

/**
 * Every id a route takes in its path goes through `uuidOr404`.
 *
 * The fault this guards was not in one controller, it was in the SHAPE of
 * every one: a handler reads `@Param('id')` and hands it to a query that
 * casts it, and nothing between them asks whether it is a uuid. Twenty-seven
 * routes answered 500 to `/1`. Fixing them one at a time is how the
 * twenty-eighth is written the old way next month, so the rule is read off
 * the controllers rather than off a list of the ones somebody remembered.
 */

const SOURCE = dirname(fileURLToPath(import.meta.url));

function controllers(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...controllers(path));
    else if (name.endsWith('.controller.ts')) out.push(path);
  }
  return out;
}

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sources(path));
    else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) out.push(path);
  }
  return out;
}

describe('uuidOr404', () => {
  it('passes a uuid through unchanged, in either case', () => {
    const id = '0b3d8f2a-9c41-4e7b-8a15-3f6d2c9e1a70';
    expect(uuidOr404('card_not_found').transform(id, { type: 'param' })).toBe(id);
    expect(isUuid(id.toUpperCase())).toBe(true);
  });

  it.each(['1', 'transactions', '', '0b3d8f2a-9c41-4e7b-8a15-3f6d2c9e1a7', "' OR 1=1 --"])(
    'answers %j as the route’s own not-found, never as a 400',
    (bad) => {
      const pipe = uuidOr404('card_not_found');
      let thrown: unknown;
      try {
        pipe.transform(bad, { type: 'param' });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(NotFoundException);
      expect((thrown as NotFoundException).getResponse()).toEqual({ error: 'card_not_found' });
    },
  );
});

describe('every path id in the API', () => {
  const files = controllers(SOURCE);

  it('finds the controllers it is guarding', () => {
    // Guards the scanner: a path change that found nothing would pass below.
    expect(files.length).toBeGreaterThan(10);
  });

  it('goes through uuidOr404', () => {
    const bare: string[] = [];
    for (const file of files) {
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, index) => {
          if (/@Param\('id'\s*\)/.test(line)) bare.push(`${relative(SOURCE, file)}:${index + 1}`);
        });
    }
    expect(bare, 'an id read without the shape check answers 500 to a typo').toEqual([]);
  });

  it('answers with a code the route itself already emits for an unknown id', () => {
    // A code invented for the pipe would make the malformed answer differ from
    // the unknown one — which is the difference this exists to remove — and
    // would be a code no client has words for.
    const emitted = new Set<string>();
    for (const file of sources(SOURCE)) {
      for (const match of readFileSync(file, 'utf8').matchAll(/error: '([a-z_]+)'/g)) {
        emitted.add(match[1]!);
      }
    }
    const used = new Set<string>();
    for (const file of files) {
      for (const match of readFileSync(file, 'utf8').matchAll(/uuidOr404\('([a-z_]+)'\)/g)) {
        used.add(match[1]!);
      }
    }
    expect(used.size).toBeGreaterThan(5);
    expect([...used].filter((code) => !emitted.has(code))).toEqual([]);
  });
});
