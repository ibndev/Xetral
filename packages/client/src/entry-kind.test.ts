import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ENTRY_KIND_LABELS, entryKindLabel } from './entry-kind.js';

/**
 * EVERY ENTRY KIND THE LEDGER CAN WRITE HAS A WORD A CUSTOMER READS.
 *
 * `entry_kind` is a Postgres enum and this is a TypeScript object, and only
 * an insert proves they agree — which is Phase 3's finding about `EntryKind`
 * and `AccountRef`, in a third place. The consequence here is smaller and
 * more visible than a failed write: a kind with no label renders on the
 * activity list as the raw identifier, underscores and all, on the screen
 * every customer opens. `card_auth_expiry` under somebody's grocery shopping.
 *
 * SO THE ENUM IS READ FROM THE MIGRATION AS TEXT. The alternative is a
 * hand-written list here, which is the thing that drifts — the mistake
 * `route-coverage.test.ts` records about its own controller array.
 *
 * BOTH DIRECTIONS, because a label for a kind the ledger cannot write is dead
 * weight that reads as coverage. A member removed from the enum by a later
 * migration should take its label with it.
 */
const SQL_DIR = join(
  new URL('.', import.meta.url).pathname,
  '..', '..', 'ledger', 'sql',
);

/**
 * THE ENUM IS 001's `CREATE TYPE` PLUS EVERY LATER `ALTER TYPE`, and reading
 * only the first was this guard's own first bug.
 *
 * `card_termination` arrives in 003, the two gift card kinds in 005 and
 * `dispute_refund` in 018 — four kinds the ledger writes every day, which a
 * reader of 001 alone concludes do not exist. It reported four correct labels
 * as naming nothing, which is a guard failing on correct code: the shape that
 * gets a test deleted rather than the code fixed.
 */
function enumMembers(): readonly string[] {
  const files = readdirSync(SQL_DIR)
    .filter((f) => f.endsWith('.sql') && !f.endsWith('.test.sql'))
    .sort();
  const out = new Set<string>();
  for (const file of files) {
    // Comments first: the enum is documented member by member, and a quoted
    // word inside a comment would read as a member that does not exist.
    const source = readFileSync(join(SQL_DIR, file), 'utf8').replace(/--[^\n]*/g, ' ');
    const created = source.match(/CREATE TYPE entry_kind AS ENUM \(([\s\S]*?)\)/);
    if (created !== null) {
      for (const m of (created[1] ?? '').matchAll(/'([a-z_]+)'/g)) out.add(m[1] as string);
    }
    for (const m of source.matchAll(/ALTER TYPE\s+entry_kind\s+ADD VALUE(?:\s+IF NOT EXISTS)?\s+'([a-z_]+)'/g)) {
      out.add(m[1] as string);
    }
  }
  if (out.size === 0) throw new Error('no entry_kind members found in packages/ledger/sql');
  return [...out];
}

describe('what a customer calls a transaction', () => {
  const members = enumMembers();

  it('reads a non-empty enum out of the migration', () => {
    // Without this the two assertions below pass on an empty list, which is
    // the shape of a guard that cannot fail.
    expect(members.length).toBeGreaterThan(15);
  });

  it('names every kind the ledger can write', () => {
    const unlabelled = members.filter((k) => ENTRY_KIND_LABELS[k] === undefined);
    expect(
      unlabelled,
      'these entry kinds have no customer-facing label, so the activity list ' +
        'renders their raw identifier:\n' + unlabelled.join('\n'),
    ).toEqual([]);
  });

  it('names nothing the ledger cannot write', () => {
    const extra = Object.keys(ENTRY_KIND_LABELS).filter((k) => !members.includes(k));
    expect(
      extra,
      'these labels name an entry kind that is not in the enum:\n' + extra.join('\n'),
    ).toEqual([]);
  });

  it('falls back to something readable rather than to a blank', () => {
    // The window between a migration adding a kind and somebody adding its
    // label is what this is for: obviously provisional, never empty, and
    // never an identifier with an underscore in it.
    expect(entryKindLabel('some_new_kind')).toBe('Some new kind');
    expect(entryKindLabel('')).toBe('Transaction');
  });
});
