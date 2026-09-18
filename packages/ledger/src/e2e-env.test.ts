import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * EVERY ENVIRONMENT VARIABLE AN E2E SUITE READS MUST BE IN `passThroughEnv`.
 *
 * WHAT THIS COST. Phase 20 gave the funding suite a second connection — the
 * DDL in "NAMES THE MISSING MIGRATION" needs to own the table, and 099 takes
 * DDL away from the application role precisely so a query needing it cannot
 * reach a deploy. The commit added `DATABASE_OWNER_URL` to the test AND to
 * ci.yml's step env, and not to the one list that decides whether the task can
 * SEE it. Turbo strips anything undeclared, `OWNER_DATABASE_URL` fell back to
 * `DATABASE_URL`, and the ALTER was refused with `must be owner of table
 * virtual_accounts` — the exact failure that commit was fixing, reintroduced
 * one file away from the fix.
 *
 * IT WAS INVISIBLE TWICE OVER, which is why it shipped. A developer runs
 * `vitest` directly and never goes through turbo, so it passes locally and has
 * passed locally every time since. CI runs `npm run test:e2e`, which is turbo,
 * so it failed there — and the dependency audit was cancelling every step after
 * it, so the e2e suite was reported as `skipped` and nobody saw the failure for
 * five commits. Two layers of masking over one missing line.
 *
 * SO THE FALLBACK IS THE TRAP, not the bug. `?? DATABASE_URL` is right for a
 * developer against a database they own, and it is exactly what turns a
 * stripped variable into a confusing refusal rather than a missing-config
 * error. A default that is correct in one environment and silently wrong in
 * another has to be checked from the outside — 017's rule that forgetting must
 * never be the permissive direction.
 *
 * READ FROM THE SUITES rather than maintained here. A hand-written list is
 * what drifted; `migrations-in-ci.test.ts` makes the same argument about the
 * migration chain.
 */
const TURBO = new URL('../../../turbo.json', import.meta.url).pathname;
const ROOTS = [
  new URL('../../../apps/api/src', import.meta.url).pathname,
  new URL('../../../packages/ledger/src', import.meta.url).pathname,
  new URL('../../../packages/providers/src', import.meta.url).pathname,
];

/** Every `.e2e.test.ts` under the workspaces that declare a `test:e2e` task. */
function e2eFiles(dir: string): readonly string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...e2eFiles(path));
    else if (entry.name.endsWith('.e2e.test.ts')) out.push(path);
  }
  return out;
}

/**
 * Both spellings, because either reaches the same variable and a reader
 * reaching for one is not thinking about this test.
 */
function envNamesIn(source: string): readonly string[] {
  const names = new Set<string>();
  for (const m of source.matchAll(/process\.env\[['"]([A-Z0-9_]+)['"]\]/g)) names.add(m[1] ?? '');
  for (const m of source.matchAll(/process\.env\.([A-Z0-9_]+)/g)) names.add(m[1] ?? '');
  names.delete('');
  return [...names];
}

describe('the e2e task can see what the e2e suites read', () => {
  const declared: readonly string[] =
    (JSON.parse(readFileSync(TURBO, 'utf8')) as {
      tasks: Record<string, { passThroughEnv?: readonly string[] }>;
    }).tasks['test:e2e']?.passThroughEnv ?? [];

  const read = new Map<string, string[]>();
  for (const root of ROOTS) {
    for (const file of e2eFiles(root)) {
      for (const name of envNamesIn(readFileSync(file, 'utf8'))) {
        read.set(name, [...(read.get(name) ?? []), file]);
      }
    }
  }

  it('finds the suites at all, so a silent zero cannot pass this', () => {
    /* A test that reads no files agrees with every possible turbo.json. */
    expect(read.size, 'no environment variable found in any e2e suite').toBeGreaterThan(0);
  });

  it('declares every variable an e2e suite reads', () => {
    const missing = [...read.entries()]
      .filter(([name]) => !declared.includes(name))
      .map(([name, files]) => `${name} (read by ${files.length} suite(s))`);
    expect(
      missing,
      'turbo strips an undeclared variable, so the suite sees undefined and takes ' +
        `whatever fallback it has:\n${missing.join('\n')}`,
    ).toEqual([]);
  });

  it('declares nothing that no suite reads', () => {
    /*
     * The other direction, for `route-coverage.test.ts`'s reason: a list
     * describing a surface that is not there invites the reader to stop
     * trusting it.
     */
    const unused = declared.filter((name) => !read.has(name));
    expect(unused, `declared in turbo.json and read by no e2e suite:\n${unused.join('\n')}`).toEqual(
      [],
    );
  });
});
