import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Every injected constructor parameter must name its token explicitly.
 *
 * THIS TRAP HAS NOW BITTEN TWICE. esbuild — what vitest transpiles with, and
 * what builds the bundle — does not emit `design:paramtypes`, so NestJS's
 * usual type-inferred constructor injection has nothing to read. A parameter
 * written as `private readonly settings: SettingsService` therefore:
 *
 *   - typechecks,
 *   - passes every unit test, because unit tests construct services directly
 *     and never go through the container,
 *   - and then fails at runtime with the container unable to resolve a
 *     dependency, which surfaces as HTTP 500 on every route the module
 *     serves.
 *
 * Phase 2 found it and wrote the convention down. It was still possible to
 * add a bare parameter directly beneath an `@Inject(...)` one in the same
 * constructor and have everything green until the e2e suite ran — which is
 * what happened, and cost a CI cycle to discover. A convention that only
 * lives in a document is a convention that holds until somebody is in a hurry.
 *
 * This is the same shape of check as `route-key.ts`'s canary and
 * `route-coverage.test.ts`: cheap, and it fails in the second where the
 * mistake is made rather than in the minute where it is expensive.
 */

const SRC = new URL('.', import.meta.url).pathname;

function walk(dir: string): readonly string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return walk(path);
    return path.endsWith('.ts') && !path.endsWith('.test.ts') ? [path] : [];
  });
}

/**
 * Constructor parameters that are injected but name no token.
 *
 * Deliberately a text scan rather than reflection: the failure being guarded
 * against is precisely that the runtime metadata is absent, so there is
 * nothing to reflect over. The source is the only place the answer exists.
 */
function untokenedParameters(): readonly string[] {
  const offences: string[] = [];

  for (const file of walk(SRC)) {
    const source = readFileSync(file, 'utf8');

    // Each `constructor(...)` and its parameter list, up to the closing
    // paren. Services in this codebase always write one parameter per line.
    for (const match of source.matchAll(/constructor\(\s*\n([\s\S]*?)\n\s*\)\s*\{/g)) {
      const body = match[1] ?? '';
      const lines = body.split('\n');

      lines.forEach((line, index) => {
        const isParameter = /^\s*(private|public|protected|readonly)\s/.test(line);
        if (!isParameter) return;

        if (line.includes('@Inject')) return;

        // The decorator may also sit on the line ABOVE, when the type name is
        // long enough to wrap — app.module.ts writes two that way.
        //
        // It only counts if that line is a decorator ALONE. Checking merely
        // that it starts with `@Inject` treats every parameter following a
        // decorated one as decorated itself, which is most of them: the first
        // version of this test passed while the bug it was written for sat
        // three lines away, because the bare parameter happened to follow an
        // `@Inject(SettingsService)` one.
        const previous = (lines[index - 1] ?? '').trim();
        const isLoneDecorator =
          previous.startsWith('@Inject') && !/\b(private|public|protected|readonly)\b/.test(previous);
        if (isLoneDecorator) return;

        offences.push(`${file.slice(SRC.length)}: ${line.trim()}`);
      });
    }
  }

  return offences.sort();
}

describe('dependency injection', () => {
  it('names a token for every injected constructor parameter', () => {
    const offences = untokenedParameters();
    expect(
      offences,
      'esbuild emits no design:paramtypes, so these resolve to undefined at ' +
        'runtime and every route on their module answers 500:\n' +
        offences.join('\n'),
    ).toEqual([]);
  });

  it('finds the parameters it is meant to be checking', () => {
    // A scanner whose regex stopped matching would pass the test above for
    // ever while checking nothing — the same failure mode `route-coverage`
    // had when it walked its own hand-written list.
    const files = walk(SRC);
    const constructors = files.reduce(
      (total, file) =>
        total + [...readFileSync(file, 'utf8').matchAll(/constructor\(\s*\n/g)].length,
      0,
    );
    expect(constructors).toBeGreaterThan(15);
  });
});
