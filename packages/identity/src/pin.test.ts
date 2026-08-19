import { describe, expect, it } from 'vitest';
import {
  MAX_PIN_ATTEMPTS,
  WeakPinError,
  assertPinPolicy,
  hashPin,
  needsRehash,
  verifyPin,
} from './pin.js';

describe('PIN policy', () => {
  it('requires exactly six digits', () => {
    for (const bad of ['12345', '1234567', 'abcdef', '12 456', '', '12345a']) {
      expect(() => assertPinPolicy(bad)).toThrow(WeakPinError);
    }
  });

  it('rejects a repeated digit', () => {
    // 888888 is not on the denylist, so it can only be caught by the repeated-
    // digit rule -- which is what this asserts. 111111 IS on the denylist and
    // is rejected earlier, by a different rule with a different message.
    expect(() => assertPinPolicy('888888')).toThrow(/same digit/);
    expect(() => assertPinPolicy('111111')).toThrow(WeakPinError);
  });

  it('rejects a run in either direction', () => {
    // 123456 is the single most common PIN in every leak ever analysed, and
    // 654321 is the second thing an attacker tries.
    expect(() => assertPinPolicy('123456')).toThrow(WeakPinError);
    expect(() => assertPinPolicy('654321')).toThrow(WeakPinError);
    expect(() => assertPinPolicy('345678')).toThrow(/consecutive/);
  });

  it('accepts an ordinary PIN', () => {
    expect(() => assertPinPolicy('374915')).not.toThrow();
    // Leading zeros must survive: a PIN is a string of digits, not a number.
    expect(() => assertPinPolicy('048261')).not.toThrow();
  });
});

describe('hashing', () => {
  it('produces a versioned envelope the database will accept', async () => {
    // transaction_pins.pin_hash carries CHECK (pin_hash ~ '^v[0-9]+:'), so an
    // unversioned hash cannot be stored at all.
    const stored = await hashPin('374915');
    expect(stored).toMatch(/^v1:scrypt:\d+:\d+:\d+:[\w-]+:[\w-]+$/);
  });

  it('salts, so two users with the same PIN do not share a hash', async () => {
    // Without this, one cracked hash unlocks every account that chose that PIN,
    // and a hash column becomes a ready-made grouping of identical PINs.
    const [a, b] = await Promise.all([hashPin('374915'), hashPin('374915')]);
    expect(a).not.toBe(b);
    expect(await verifyPin('374915', a)).toBe(true);
    expect(await verifyPin('374915', b)).toBe(true);
  });

  it('verifies the right PIN and rejects a near miss', async () => {
    const stored = await hashPin('374915');
    expect(await verifyPin('374915', stored)).toBe(true);
    expect(await verifyPin('374916', stored)).toBe(false);
    expect(await verifyPin('', stored)).toBe(false);
  });

  it('refuses to hash a weak PIN in the first place', async () => {
    await expect(hashPin('123456')).rejects.toThrow(WeakPinError);
  });

  it('verifies an existing PIN that today policy would reject', async () => {
    // Policy tightens over time. A customer whose PIN predates a new rule must
    // still be able to get in -- otherwise adding a banned PIN to the list
    // locks people out of their own money.
    const legacy = 'v1:scrypt:16384:8:1:c2FsdHNhbHQ:x';
    expect(await verifyPin('123456', legacy)).toBe(false); // wrong hash, not a throw
    await expect(verifyPin('123456', legacy)).resolves.toBeTypeOf('boolean');
  });
});

describe('malformed stored values', () => {
  it('returns false rather than throwing', async () => {
    // These reach us from a database column. A crash here is an outage on the
    // transaction path; false is a declined PIN and an alert.
    for (const bad of ['', 'garbage', 'v1:scrypt:1:2:3', 'v2:argon2:1:2:3:a:b', 'v1:md5:1:2:3:a:b']) {
      expect(await verifyPin('374915', bad)).toBe(false);
    }
  });

  it('refuses absurd work factors from a tampered envelope', async () => {
    // A stored N of 2^30 would allocate gigabytes and stall the worker. The
    // value is ours, but "ours" is worth one comparison rather than a hung
    // process.
    const hostile = 'v1:scrypt:1073741824:8:1:c2FsdA:aGFzaA';
    expect(await verifyPin('374915', hostile)).toBe(false);
  });
});

describe('parameter upgrades', () => {
  it('flags a hash made with older parameters', async () => {
    expect(needsRehash(await hashPin('374915'))).toBe(false);
    expect(needsRehash('v1:scrypt:16384:8:1:c2FsdA:aGFzaA')).toBe(true);
    expect(needsRehash('garbage')).toBe(true);
  });
});

describe('lockout constants', () => {
  it('matches what record_pin_failure enforces in SQL', () => {
    // Drift between these two numbers means the API tells a customer they have
    // attempts left that the database has already spent.
    expect(MAX_PIN_ATTEMPTS).toBe(5);
  });
});
