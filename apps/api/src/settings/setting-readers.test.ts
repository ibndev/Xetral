import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * EVERY SETTING AN OPERATOR CAN FILL IN IS READ BY SOMETHING.
 *
 * THE FAILURE THIS EXISTS FOR. `paystack_preferred_bank` was seeded by
 * `044_paystack_funding.sql`, rendered on the settings screen with its own
 * description, and named in `deploy/GO-LIVE.md` as a thing an operator must
 * decide. Nothing read it. The value that actually reached Paystack came from
 * an environment variable, resolved once at construction.
 *
 * So an operator filled the box, the dashboard saved it, the history recorded
 * the change — and every account issuance carried no `preferred_bank`. On a
 * live integration with more than one NUBAN provider Paystack refuses that,
 * which is how "we pasted a live key and configured all the settings" and
 * "Activate Account throws" were both true at the same time.
 *
 * That is `kill-switches.test.ts`'s failure — a control nothing reads, trusted
 * exactly when it matters — in a different table. A switch is not the only
 * kind of setting that can be silently inert, so this generalises it: any
 * `platform_settings` key a migration seeds must appear at a call site
 * somewhere outside the seed and the docs.
 *
 * Nothing in the type system can catch this. An unread row is a row.
 */

const HERE = new URL('.', import.meta.url).pathname;
const API_SRC = join(HERE, '..');
const SQL_DIRS = [
  join(HERE, '../../../../packages/ledger/sql'),
  join(HERE, '../../../../packages/identity/sql'),
];

function walk(dir: string, ext: string): readonly string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return walk(path, ext);
    return path.endsWith(ext) ? [path] : [];
  });
}

/**
 * Every key a migration INSERTs into `platform_settings`.
 *
 * Read out of the SQL rather than from a list here, because a list here is
 * one more thing that can fall out of step with the fourteen migrations that
 * seed this table — which is the gap that let `paystack_preferred_bank`
 * exist unread in the first place.
 */
function seededKeys(): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const dir of SQL_DIRS) {
    for (const file of walk(dir, '.sql')) {
      if (file.endsWith('.test.sql')) continue;
      const sql = readFileSync(file, 'utf8');
      // Only the VALUES rows of an INSERT INTO platform_settings.
      for (const block of sql.matchAll(
        /INSERT\s+INTO\s+platform_settings[\s\S]*?;/gi,
      )) {
        for (const row of block[0].matchAll(/\(\s*'([a-z0-9_]+)'\s*,\s*'/g)) {
          const key = row[1];
          if (key !== undefined) keys.add(key);
        }
      }
    }
  }
  return keys;
}

/**
 * Every key the application actually READS, as an argument to one of the four
 * typed primitives or to the kill-switch assertion.
 *
 * NOT "every key the source mentions", which is what this looked for first —
 * and it passed with the bug still in place, because `funding.service.ts`
 * names `paystack_preferred_bank` in a LOG MESSAGE advising an operator to
 * check it. A key in a sentence about a key is not a read, and a coverage
 * test that counts one is a test that reports coverage it does not have.
 * That is this file's own subject, so getting it wrong here would have been
 * the joke writing itself.
 */
function keysRead(): ReadonlySet<string> {
  const read = new Set<string>();

  for (const file of walk(API_SRC, '.ts')) {
    if (file.endsWith('.test.ts')) continue;
    for (const match of readFileSync(file, 'utf8').matchAll(
      /\b(?:integer|bigint|boolean|text|assertServiceEnabled)\(\s*'([a-z0-9_]+)'/g,
    )) {
      const key = match[1];
      if (key !== undefined) read.add(key);
    }
  }

  /*
   * AND THE ONES THE DATABASE READS ITSELF, which are not an oversight.
   *
   * A dispute's deadline, the retention periods and the risk thresholds are
   * read inside PL/pgSQL, deliberately: 018 records that a deadline a process
   * can supply is not a deadline, and 027 that a monitoring rule reading
   * anything a flow has to remember to set switches itself off silently. So
   * `SELECT … FROM platform_settings WHERE key = 'x'` is as real a read as an
   * accessor, and a guard that ignored it would demand those keys be moved
   * into TypeScript — which is the opposite of what this schema decided.
   */
  for (const dir of SQL_DIRS) {
    for (const file of walk(dir, '.sql')) {
      if (file.endsWith('.test.sql')) continue;
      for (const match of readFileSync(file, 'utf8').matchAll(
        /platform_settings\s+WHERE\s+key\s*=\s*'([a-z0-9_]+)'/gi,
      )) {
        const key = match[1];
        if (key !== undefined) read.add(key);
      }
    }
  }

  return read;
}

describe('a setting an operator can fill in is a setting something reads', () => {
  const seeded = seededKeys();
  const read = keysRead();

  it('finds the seeded keys at all', () => {
    // Guards the scanner: if this returned nothing the assertion below would
    // pass vacuously, which is the shape of failure a coverage test is for.
    expect(seeded.size).toBeGreaterThan(30);
    expect(seeded.has('transfer_fee_basis_points')).toBe(true);
    expect(seeded.has('paystack_preferred_bank')).toBe(true);
  });

  it('finds real reads, not mentions', () => {
    expect(read.size).toBeGreaterThan(20);
    expect(read.has('transfer_fee_basis_points')).toBe(true);
  });

  it('reads every one of them through a settings accessor', () => {
    const unread = [...seeded].filter((key) => !read.has(key));
    expect(unread).toEqual([]);
  });
});
