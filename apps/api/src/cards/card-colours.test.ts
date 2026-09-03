import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { CARD_COLOURS } from './dto.js';

/**
 * The finishes a card can have, in the two places that decide.
 *
 * `dto.ts` refuses a bad request with a field name a client can act on.
 * `045_card_fee_split.sql` refuses a bad ROW however it was written, including
 * from a psql prompt. Both are wanted; what is not wanted is them disagreeing.
 *
 * A value the schema accepts and the CHECK refuses is a request that 500s
 * where it should 400 — and a value the CHECK accepts and the schema refuses
 * is a finish an operator can set and no customer can choose. Neither
 * disagreement is visible to the compiler, and neither shows up in a green
 * test run unless something reads both.
 */
const MIGRATION = join(
  import.meta.dirname,
  '../../../../packages/ledger/sql/045_card_fee_split.sql',
);

function coloursInTheDatabase(): readonly string[] {
  const sql = readFileSync(MIGRATION, 'utf8');
  const check = /colour\s+TEXT\s+NOT NULL\s+DEFAULT\s+'[a-z]+'\s*CHECK\s*\(colour IN \(([^)]*)\)\)/i.exec(
    sql,
  );
  if (check === null) {
    throw new Error(
      'could not find the colour CHECK in 045. If the constraint moved, this test ' +
        'must follow it — a coverage test that cannot find its subject passes ' +
        'silently, which is the failure it exists to prevent.',
    );
  }
  return [...(check[1] ?? '').matchAll(/'([a-z]+)'/g)].map((m) => m[1] as string);
}

describe('the finishes a card can have', () => {
  it('are the same list in the request schema and in the database', () => {
    expect([...CARD_COLOURS].sort()).toEqual([...coloursInTheDatabase()].sort());
  });

  it('has more than one, or the choice is not a choice', () => {
    expect(CARD_COLOURS.length).toBeGreaterThan(1);
  });

  it('includes the DEFAULT the column falls back to', () => {
    /*
     * Every card issued before the column existed has this finish, so a
     * default that is not an offered choice would mean an existing card
     * rendering with a face no customer can pick — and no way to get back to
     * it after changing.
     */
    const sql = readFileSync(MIGRATION, 'utf8');
    const fallback = /colour\s+TEXT\s+NOT NULL\s+DEFAULT\s+'([a-z]+)'/i.exec(sql)?.[1];
    expect(fallback).toBeDefined();
    expect(CARD_COLOURS).toContain(fallback as (typeof CARD_COLOURS)[number]);
  });
});
