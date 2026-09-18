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

/**
 * A STEP THAT IS ALLOWED TO FAIL MUST HAVE ITS FAILURE COLLECTED.
 *
 * WHAT THIS COSTS WHEN IT IS WRONG, IN BOTH DIRECTIONS.
 *
 * Without `continue-on-error`, a failing step CANCELS EVERY STEP AFTER IT. A
 * transitive advisory in `multer` therefore reported typecheck, the unit
 * suites, the e2e suite, the build and BOTH BOOT PROBES as `skipped` for
 * several commits — a red badge for a reason nobody could act on that week,
 * saying nothing at all about the eight things it exists to say something
 * about. The probes are the ones that hurt: this repository added them because
 * eight failures have been invisible to the compiler AND the tests and
 * appeared only when something was actually started.
 *
 * WITH `continue-on-error` AND NO COLLECTOR, the gate silently stops being
 * one. That is the direction that must be impossible rather than discouraged —
 * 017's rule that forgetting must never be the permissive direction, and the
 * same argument `kill-switches.test.ts` makes about a setting nothing reads.
 *
 * So the pair is asserted: every `continue-on-error` step carries an `id`, and
 * some later step's `if` reads that id's OUTCOME. `outcome` and not
 * `conclusion` — `conclusion` is what `continue-on-error` rewrote the result
 * to, so a collector reading it can never fire, which is a check that cannot
 * fail the build.
 */
describe('a CI step allowed to fail still fails the build', () => {
  const yaml = readFileSync(CI, 'utf8');
  /* Read as TEXT rather than parsed, for the reason the migration lists above
     are: what is being asserted is what somebody will read in the diff. */
  const lenientSteps = (): readonly string[] =>
    yaml.split(/^ {6}- /m).slice(1).filter((s) => /^\s*continue-on-error:\s*true\s*$/m.test(s));
  const lenientIds = (): readonly string[] =>
    lenientSteps()
      .map((s) => /^\s*id:\s*(\S+)/m.exec(s)?.[1])
      .filter((v): v is string => v !== undefined);

  it('gives every continue-on-error step an id', () => {
    const nameless = lenientSteps()
      .filter((s) => !/^\s*id:\s*\S+/m.test(s))
      .map((s) => (/name:\s*(.+)/.exec(s)?.[1] ?? s.slice(0, 40)).trim());
    expect(
      nameless,
      'these steps may fail without failing the build, and have no id for a ' +
        `later step to collect:\n${nameless.join('\n')}`,
    ).toEqual([]);
  });

  it('collects every one of those ids in a later step, by OUTCOME', () => {
    const ids = lenientIds();

    expect(ids.length, 'no lenient step found — this test would assert nothing').toBeGreaterThan(0);

    const uncollected = ids.filter(
      (id) => !new RegExp(`steps\\.${id}\\.outcome\\s*==\\s*'failure'`).test(yaml),
    );
    expect(
      uncollected,
      "these steps are allowed to fail and nothing later reads their outcome, so " +
        `their gate does nothing at all:\n${uncollected.join('\n')}`,
    ).toEqual([]);
  });

  it('never collects a lenient step by conclusion, which can never be failure', () => {
    /* `conclusion` is what `continue-on-error` rewrote the outcome TO, so a
       collector reading it is a check that cannot fail the build — 013's
       lesson about a reconciliation check that reports through a SELECT. */
    const wrong = lenientIds().filter((id) => new RegExp(`steps\\.${id}\\.conclusion`).test(yaml));
    expect(wrong, `read by conclusion rather than outcome:\n${wrong.join('\n')}`).toEqual([]);
  });
});
