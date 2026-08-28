import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RETENTION_ROWS } from './retention-table';

/**
 * The published privacy notice cannot drift from what the system does.
 *
 * A privacy notice is normally written once, from a template, and then
 * describes what somebody intended rather than what runs. The gap opens
 * silently — a retention period is tightened during an incident, or a table is
 * added — and the page still says what it said the day it was written. Nobody
 * notices, because nothing checks a paragraph.
 *
 * So this reads the migration the deletion job actually uses and asserts that
 * every period the page quotes is the period the database is configured with.
 * Changing what we keep now means changing what we tell customers, or the
 * build fails.
 *
 * It reads the SQL as TEXT deliberately, rather than connecting to a database.
 * The web workspace has no database and should not gain one to check a
 * sentence; the migration file is the thing under review in a pull request,
 * and it is the thing this compares against.
 */
const SQL = readFileSync(
  join(new URL('.', import.meta.url).pathname, '../../../../packages/ledger/sql/019_retention.sql'),
  'utf8',
);

/** The seeded default for a `platform_settings` key, out of the INSERT. */
function seededValue(key: string): string | undefined {
  const match = new RegExp(`\\('${key}',\\s*'(\\d+)'`).exec(SQL);
  return match?.[1];
}

describe('the privacy notice matches the schema', () => {
  it('finds the migration it is meant to be checking', () => {
    // Guards the reader itself. Without this, a moved file would make every
    // assertion below pass against an empty string.
    expect(SQL).toContain('CREATE OR REPLACE FUNCTION apply_retention()');
    expect(SQL).toContain('retention_decisions');
  });

  it('quotes the period the deletion job is actually configured with', () => {
    const checked = RETENTION_ROWS.filter((row) => row.settingKey !== undefined);
    // If this ever became zero the suite would pass while checking nothing.
    expect(checked.length).toBeGreaterThan(2);

    for (const row of checked) {
      const key = row.settingKey as string;
      const seeded = seededValue(key);
      expect(seeded, `${key} is not seeded in 019_retention.sql`).toBeDefined();

      // The page says "90 days"; the schema says '90'. Compare the number,
      // because the words around it are for a customer to read.
      const quoted = /(\d+)/.exec(row.period)?.[1];
      expect(quoted, `"${row.period}" states no number`).toBeDefined();
      expect(
        quoted,
        `the notice says "${row.period}" for ${row.what}, but ${key} is ${seeded}`,
      ).toBe(seeded);
    }
  });

  it('names only settings the migration defines', () => {
    // The other direction, as route coverage does: a notice describing a
    // period that no longer exists invites the reader to stop trusting it.
    for (const row of RETENTION_ROWS) {
      if (row.settingKey === undefined) continue;
      expect(SQL, `${row.settingKey} is quoted but not defined`).toContain(row.settingKey);
    }
  });

  it('explains every row it lists', () => {
    // "12 months" with no reason is a period, not a notice. The obligation is
    // to say WHY, and a row that cannot answer that is one to reconsider
    // rather than to publish.
    for (const row of RETENTION_ROWS) {
      expect(row.why.length, `${row.what} has no stated reason`).toBeGreaterThan(40);
      expect(row.period.length).toBeGreaterThan(0);
    }
  });
});
