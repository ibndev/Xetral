import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The version somebody agreed to has to name the words they read.
 *
 * `consent_documents` records a hash of each published document, and every
 * consent points at a row. That is what makes "they agreed to the 25 August
 * terms" a statement anybody can check — and it is worth exactly nothing if
 * the page can be edited underneath a version that stays the same. A version
 * number that has drifted from its words is worse than none, because it looks
 * like evidence.
 *
 * So this hashes the pages as they are and compares them against the seeded
 * rows. Editing the terms is then a red build with one obvious fix: retire the
 * old version and publish a new one, which is also what asks every customer
 * again — `consent_outstanding` fills the moment you do.
 *
 * It reads the SQL as TEXT rather than connecting to a database, for the same
 * reason `retention-table.test.ts` does: the seed file is the thing under
 * review in a pull request, and the web workspace should not gain a database
 * to check a hash.
 */
const HERE = new URL('.', import.meta.url).pathname;

const SEED = readFileSync(
  join(HERE, '../../../../packages/ledger/sql/033_consent.seed.sql'),
  'utf8',
);

const PAGES: Readonly<Record<string, string>> = {
  terms: join(HERE, '../app/legal/terms/page.tsx'),
  privacy: join(HERE, '../app/legal/privacy/page.tsx'),
};

/** The hash seeded for a kind, out of the INSERT. */
function seededHash(kind: string): string | undefined {
  const match = new RegExp(`\\('${kind}',\\s*'[0-9-]+',\\s*\\n?\\s*'([0-9a-f]{64})'`).exec(SEED);
  return match?.[1];
}

/** The version seeded for a kind. */
function seededVersion(kind: string): string | undefined {
  return new RegExp(`\\('${kind}',\\s*'([0-9]{4}-[0-9]{2}-[0-9]{2})'`).exec(SEED)?.[1];
}

describe('every published consent document is the one that was hashed', () => {
  it('finds the seed it is meant to be checking', () => {
    // Guards the reader itself. Without this a moved file would make every
    // assertion below pass against an empty string — the failure mode the
    // route-coverage test once contained.
    expect(SEED).toContain('INSERT INTO consent_documents');
  });

  for (const [kind, path] of Object.entries(PAGES)) {
    it(`${kind} has not changed since it was published`, () => {
      const hash = createHash('sha256').update(readFileSync(path)).digest('hex');
      expect(seededHash(kind)).toBe(hash);
    });

    it(`${kind} quotes the version it is published under`, () => {
      // The date on the page and the version in the row are the same fact
      // stated twice, and two statements of one fact drift. A customer
      // producing a screenshot dated differently from our record is a
      // conversation with no good ending.
      const version = seededVersion(kind);
      expect(version).toBeDefined();

      const page = readFileSync(path, 'utf8');
      const updated = /updated="([^"]+)"/.exec(page)?.[1];
      expect(updated).toBeDefined();

      // "25 August 2026" against "2026-08-25".
      const [day, month, year] = (updated as string).split(' ');
      const months = [
        'January', 'February', 'March', 'April', 'May', 'June',
        'July', 'August', 'September', 'October', 'November', 'December',
      ];
      const index = months.indexOf(month as string) + 1;
      expect(index).toBeGreaterThan(0);
      const fromPage = `${year}-${String(index).padStart(2, '0')}-${(day as string).padStart(2, '0')}`;
      expect(version).toBe(fromPage);
    });
  }

  it('publishes exactly one version of each kind', () => {
    // The database enforces this with a partial unique index; the seed can
    // still name two, and the second INSERT would simply be refused at deploy
    // time on a database nobody is watching.
    for (const kind of ['terms', 'privacy', 'marketing_email']) {
      const occurrences = SEED.match(new RegExp(`\\('${kind}',`, 'g')) ?? [];
      expect(occurrences).toHaveLength(1);
    }
  });
});
