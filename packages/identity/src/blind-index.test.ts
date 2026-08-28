import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { assertValidBlindIndexKey, blindIndex, blindIndexEquals } from './blind-index.js';
import type { BlindIndexKey } from './blind-index.js';

const key: BlindIndexKey = { version: 'v1', key: randomBytes(32) };
const other: BlindIndexKey = { version: 'v1', key: randomBytes(32) };

describe('fingerprinting a secret value', () => {
  it('gives the same answer every time, which the envelope cannot', () => {
    // The whole reason this module exists. `seal()` uses a random IV, so one
    // BVN sealed twice is two different strings — right for confidentiality
    // and useless for "has this BVN already opened an account?".
    expect(blindIndex('22334455667', key)).toBe(blindIndex('22334455667', key));
  });

  it('gives a different answer for a different value', () => {
    expect(blindIndex('22334455667', key)).not.toBe(blindIndex('22334455668', key));
  });

  it('gives a different answer under a different key', () => {
    // What makes an eleven-digit value safe to fingerprint at all. Unkeyed,
    // the whole BVN space is a few hours of hashing, so the digest would BE
    // the BVN.
    expect(blindIndex('22334455667', key)).not.toBe(blindIndex('22334455667', other));
  });

  it('ignores whitespace, so one person cannot get two accounts with a space bar', () => {
    expect(blindIndex(' 2233 4455 667 ', key)).toBe(blindIndex('22334455667', key));
  });

  it('has the shape the column CHECK demands', () => {
    expect(blindIndex('22334455667', key)).toMatch(/^v[0-9]+:[0-9a-f]{64}$/);
  });

  it('binds the version into the message, not just onto the front', () => {
    // Otherwise a v1 fingerprint could be relabelled v2 by editing the string,
    // and a rotation that had not actually happened would look complete.
    const v2: BlindIndexKey = { version: 'v2', key: key.key };
    const relabelled = blindIndex('22334455667', key).replace('v1:', 'v2:');
    expect(blindIndex('22334455667', v2)).not.toBe(relabelled);
  });

  it('refuses an empty value rather than fingerprinting nothing', () => {
    // Every empty value would share one fingerprint, so the uniqueness rule
    // would refuse the second customer who submitted nothing.
    expect(() => blindIndex('   ', key)).toThrow(/empty/);
  });

  it('refuses a key too short to be one', () => {
    expect(() => assertValidBlindIndexKey({ version: 'v1', key: randomBytes(16) })).toThrow(
      /at least 32 bytes/,
    );
    expect(() => assertValidBlindIndexKey({ version: '1', key: randomBytes(32) })).toThrow(
      /look like 'v1'/,
    );
  });

  it('compares in constant time', () => {
    const a = blindIndex('22334455667', key);
    expect(blindIndexEquals(a, a)).toBe(true);
    expect(blindIndexEquals(a, blindIndex('22334455668', key))).toBe(false);
    expect(blindIndexEquals(a, 'short')).toBe(false);
  });
});
