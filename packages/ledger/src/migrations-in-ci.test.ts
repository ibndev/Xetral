import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * EVERY MIGRATION IS APPLIED TO BOTH DATABASES CI USES, AND TO NEITHER TWICE.
 *
 * CI keeps two: an INVARIANT database, where the `.test.sql` suites run, and
 * an E2E database, which the API is pointed at. They are separate on purpose —
 * the invariant suites write fixtures the e2e flows would trip over. The cost
 * of that separation is that every new migration has to be added in TWO
 * places, and this test exists because it was added in one.
 *
 * WHAT THAT ACTUALLY COST. Migrations 050 through 058 were applied to the
 * invariant database and never to the e2e one. So `payment_links` did not
 * exist where the e2e suites run, and the only reason nothing was red is that
 * the payment-link suite had not been written yet when the chain was last
 * touched. The failure it produces is not a compile error or a missing table
 * in a diff — it is a suite that passes on a developer's machine, where the
 * database was migrated by hand, and fails in CI for a reason that reads as
 * flakiness.
 *
 * The lists are read out of the workflow, not maintained here. A list somebody
 * maintains is exactly what drifted.
 */
const SQL_DIRS = [
  new URL('../sql', import.meta.url).pathname,
  new URL('../../identity/sql', import.meta.url).pathname,
];
const CI = new URL('../../../.github/workflows/ci.yml', import.meta.url).pathname;

const MIGRATION = /packages\/(?:ledger|identity)\/sql\/([0-9]+_[a-zA-Z0-9_.]+\.sql)/g;

/** The migration files on disk — everything that is not a `.test.sql`. */
function onDisk(): readonly string[] {
  return SQL_DIRS.flatMap((dir) => readdirSync(dir))
    .filter((name) => name.endsWith('.sql') && !name.endsWith('.test.sql'))
    .sort();
}

/** The files a named step applies, in the order it applies them. */
function appliedBy(step: string, next: string): readonly string[] {
  const workflow = readFileSync(CI, 'utf8');
  const from = workflow.indexOf(step);
  const to = workflow.indexOf(next, from);
  expect(from, `${step} is no longer a step in ci.yml`).toBeGreaterThan(-1);
  return [...workflow.slice(from, to).matchAll(MIGRATION)]
    .map((m) => m[1] as string)
    .filter((name) => !name.endsWith('.test.sql'));
}

describe('CI applies every migration to both of its databases', () => {
  const invariant = appliedBy(
    'Apply migrations (invariant database)',
    'Apply migrations (e2e database)',
  );
  const e2e = appliedBy('Apply migrations (e2e database)', 'Dependency scanning');

  it('applies each one to the invariant database', () => {
    const missing = onDisk().filter((name) => !invariant.includes(name));
    expect(
      missing,
      `on disk and never applied to the invariant database, so their ` +
        `invariants cannot run:\n${missing.join('\n')}`,
    ).toEqual([]);
  });

  it('applies each one to the e2e database', () => {
    const missing = onDisk().filter((name) => !e2e.includes(name));
    expect(
      missing,
      `on disk and never applied to the e2e database, so the API is pointed ` +
        `at a schema that predates them:\n${missing.join('\n')}`,
    ).toEqual([]);
  });

  it('applies the same set to both, in the same order', () => {
    /*
     * ORDER, not just membership. These files are not independent — 059 alters
     * a table 058 creates — so a chain that applies them in a different order
     * is a chain that fails, and a chain that fails only in CI is the worst
     * place to find out.
     */
    expect(e2e).toEqual(invariant);
  });

  it('names nothing that is not on disk', () => {
    /*
     * The other direction, and it matters as much: a step naming a file that
     * has been renamed fails the whole build with a psql error about a missing
     * path, which says nothing about which of sixty lines is wrong.
     */
    const disk = new Set(onDisk());
    const ghosts = [...new Set([...invariant, ...e2e])].filter((name) => !disk.has(name));
    expect(ghosts, `named in ci.yml and not on disk:\n${ghosts.join('\n')}`).toEqual([]);
  });
});
