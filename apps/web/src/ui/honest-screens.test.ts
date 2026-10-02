import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * WHAT THE SCREENS CLAIM, held to what the code does — the round 44 audit.
 *
 * Every pattern below shipped and every one read correctly in review. Each
 * was a sentence or a fallback that described something that does not happen,
 * on a screen a customer reads to decide what to do with money. Both apps are
 * scanned, because each of these was found on both.
 */
const ROOTS = [
  join(import.meta.dirname, '..'),
  join(import.meta.dirname, '..', '..', '..', 'mobile', 'app'),
  join(import.meta.dirname, '..', '..', '..', 'mobile', 'src'),
];

function sources(dir: string): readonly string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...sources(path));
    else if (/\.tsx?$/.test(entry.name) && !entry.name.includes('.test.')) found.push(path);
  }
  return found;
}

const all = ROOTS.flatMap(sources).map((path) => ({ path, text: readFileSync(path, 'utf8') }));

describe('what the screens claim', () => {
  it('reads the scan roots', () => {
    // A guard over an empty list agrees with everything.
    expect(all.length).toBeGreaterThan(40);
  });

  it('never turns a failed identity read into "never submitted"', () => {
    // `client.kyc().catch(() => null)` made a failed read and "no submission"
    // the same value: a verified customer was told to do their KYC.
    const offenders = all.filter((f) => /\.kyc\(\)\s*\.catch\(/.test(f.text)).map((f) => f.path);
    expect(offenders).toEqual([]);
  });

  it('promises no email nothing sends', () => {
    // No template exists for an eSIM or a payer's receipt, and Airalo is never
    // sent the address.
    const offenders = all
      .filter((f) => /email the QR|on its way to your email|receipt is on its way/i.test(f.text))
      .map((f) => f.path);
    expect(offenders).toEqual([]);
  });

  it('does not say an account number needs identity verification', () => {
    // Tier 1 accounts open without it since round 26.
    const offenders = all
      .filter((f) => /before (you can be issued |)an account number/i.test(f.text))
      .map((f) => f.path);
    expect(offenders).toEqual([]);
  });

  it('searches recipients with the shared matcher, not a digits-only copy', () => {
    // `destination.includes(needle.replace(/[^0-9]/g, ''))` is `includes('')`
    // for any name: every recipient matched every name.
    const offenders = all.filter((f) => /\.includes\(needle\.replace\(/.test(f.text)).map((f) => f.path);
    expect(offenders).toEqual([]);
  });
});
