import { describe, expect, it } from 'vitest';
import { fingerprintOf } from './error-recorder.service.js';

/**
 * Fingerprinting is where this whole design succeeds or fails.
 *
 * Too coarse and two unrelated bugs share a row, so fixing one closes the
 * other and the second is never seen again. Too fine and one bug becomes a
 * thousand rows, the table is a log with extra steps, and "is this new?" —
 * the only question it exists to answer — becomes unanswerable.
 *
 * Neither failure is visible from a passing test suite; both are visible from
 * a production table that has forty thousand rows in it a week after launch,
 * by which point nobody trusts the page. So the normalisation is pinned here
 * rather than discovered there.
 */

const fp = (message: string, route?: string): string =>
  fingerprintOf(route === undefined ? { message } : { message, route });

describe('the same bug, different occurrences', () => {
  it('ignores the identifiers a message carries', () => {
    // The core case. Errors name the thing they failed on, and that name is
    // exactly what differs between two occurrences of one bug.
    expect(fp('user 8814 not found')).toBe(fp('user 22 not found'));
    expect(fp('purchase 5521 timed out')).toBe(fp('purchase 99120 timed out'));
  });

  it('ignores UUIDs', () => {
    expect(fp('no card 0f8c1e9a-6b21-4d3f-9c77-2b1a5e6d4f03')).toBe(
      fp('no card 71a4c2b8-9e14-4f60-8d23-5c7b0a9e1f42'),
    );
  });

  it('ignores email addresses', () => {
    // Otherwise every customer hitting one bug gets their own row — turning
    // one incident into as many rows as it has victims, and putting a list of
    // customer addresses into a table read by everyone on call.
    expect(fp('cannot register ada@example.ng')).toBe(fp('cannot register bola@example.com'));
  });

  it('ignores quoted values and long hex runs', () => {
    expect(fp(`duplicate key value violates unique constraint 'idempotency_key'`)).toBe(
      fp(`duplicate key value violates unique constraint 'provider_reference'`),
    );
    expect(fp('bad signature a3f9c2b18e4d7f60a1b2c3d4e5f60718')).toBe(
      fp('bad signature 0011223344556677889900aabbccddee'),
    );
  });

  it('ignores formatting of the same sentence', () => {
    // A message broken across lines by a driver, or padded, is the same bug.
    expect(fp('connection   terminated\n  unexpectedly')).toBe(
      fp('connection terminated unexpectedly'),
    );
    expect(fp('Connection Terminated')).toBe(fp('connection terminated'));
  });

  it('ignores amounts with separators', () => {
    expect(fp('insufficient funds: needed 1,250,000 kobo')).toBe(
      fp('insufficient funds: needed 40 kobo'),
    );
  });
});

describe('different bugs, kept apart', () => {
  it('separates different sentences', () => {
    expect(fp('user not found')).not.toBe(fp('card not found'));
  });

  it('separates the same sentence on different routes', () => {
    // "Not found" from two endpoints is two bugs. Merging them would hide
    // whichever one appeared second behind a row somebody had already seen.
    expect(fp('not found', '/v1/cards/:id')).not.toBe(fp('not found', '/v1/wallets'));
  });

  it('does not collapse everything to one value', () => {
    // The failure mode a too-aggressive normaliser produces, and it is silent:
    // every error in the platform reported as one recurring bug.
    const distinct = new Set([
      fp('TypeError: cannot read properties of undefined'),
      fp('relation "cards" does not exist'),
      fp('connection terminated unexpectedly'),
      fp('provider refused the request'),
      fp('insufficient funds'),
    ]);
    expect(distinct.size).toBe(5);
  });
});

describe('the shape of the value', () => {
  it('is sixteen hex characters, matching the column CHECK', () => {
    // The schema constrains this to `^[0-9a-f]{16}$`. A mismatch would mean
    // every recording attempt fails, silently, inside a filter written never
    // to throw — the worst combination available.
    expect(fp('anything at all')).toMatch(/^[0-9a-f]{16}$/);
    expect(fp('')).toMatch(/^[0-9a-f]{16}$/);
    expect(fp('12345 6789 <>&"\'')).toMatch(/^[0-9a-f]{16}$/);
  });

  it('is stable across calls', () => {
    const message = 'purchase 5521 timed out after 30000ms';
    expect(fp(message)).toBe(fp(message));
  });

  it('treats an absent route as its own bucket', () => {
    expect(fp('boom')).toBe(fp('boom'));
    expect(fp('boom')).not.toBe(fp('boom', '/v1/wallets'));
  });
});
