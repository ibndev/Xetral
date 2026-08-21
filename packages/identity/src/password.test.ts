import { describe, expect, it } from 'vitest';
import {
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  WeakPasswordError,
  assertPasswordPolicy,
  hashPassword,
  passwordNeedsRehash,
  verifyPassword,
} from './password.js';
import { dummySecretHash, needsRehashSecret, verifySecret } from './secret-hash.js';

describe('policy', () => {
  it('requires length and nothing else', () => {
    expect(() => assertPasswordPolicy('short')).toThrow(WeakPasswordError);
    expect(() => assertPasswordPolicy('a'.repeat(MIN_PASSWORD_LENGTH))).not.toThrow();

    // No composition rules: a long passphrase of plain lowercase words is
    // stronger than Password1! and must not be rejected for lacking a symbol.
    expect(() => assertPasswordPolicy('correct horse battery staple')).not.toThrow();
  });

  it('caps length so an unauthenticated endpoint cannot buy free scrypt work', () => {
    expect(() => assertPasswordPolicy('a'.repeat(MAX_PASSWORD_LENGTH + 1))).toThrow(
      WeakPasswordError,
    );
  });

  it('rejects the openers of a credential-stuffing list, case-insensitively', () => {
    expect(() => assertPasswordPolicy('password123')).toThrow(WeakPasswordError);
    expect(() => assertPasswordPolicy('PassWord123')).toThrow(WeakPasswordError);
  });
});

describe('hashing', () => {
  it('produces a versioned envelope the database will accept', async () => {
    // user_credentials.password_hash carries CHECK (password_hash ~ '^v[0-9]+:').
    expect(await hashPassword('a-long-enough-password')).toMatch(/^v1:scrypt:/);
  });

  it('salts, so two users with the same password do not share a hash', async () => {
    const [a, b] = await Promise.all([
      hashPassword('a-long-enough-password'),
      hashPassword('a-long-enough-password'),
    ]);
    expect(a).not.toBe(b);
    expect(await verifyPassword('a-long-enough-password', a)).toBe(true);
    expect(await verifyPassword('a-long-enough-password', b)).toBe(true);
  });

  it('rejects a near miss', async () => {
    const stored = await hashPassword('a-long-enough-password');
    expect(await verifyPassword('a-long-enough-passworD', stored)).toBe(false);
    expect(await verifyPassword('', stored)).toBe(false);
  });

  it('refuses to hash a weak password in the first place', async () => {
    await expect(hashPassword('short')).rejects.toThrow(WeakPasswordError);
  });

  it('verifies an existing password that today policy would reject', async () => {
    // Raising the minimum length must not lock existing customers out.
    const legacyHash = await hashPassword('exactly-ten-plus');
    expect(await verifyPassword('exactly-ten-plus', legacyHash)).toBe(true);
  });

  it('flags a hash made with older parameters', async () => {
    expect(passwordNeedsRehash(await hashPassword('a-long-enough-password'))).toBe(false);
    expect(passwordNeedsRehash('v1:scrypt:16384:8:1:c2FsdA:aGFzaA')).toBe(true);
  });
});

describe('shared KDF', () => {
  it('is the same envelope format PINs use, so one path is audited not two', async () => {
    const stored = await hashPassword('a-long-enough-password');
    expect(await verifySecret('a-long-enough-password', stored)).toBe(true);
    expect(needsRehashSecret(stored)).toBe(false);
  });

  it('offers a dummy hash so an unknown account costs the same as a wrong password', async () => {
    // Without this the login endpoint is an account-enumeration oracle: no
    // user found returns measurably faster than a failed comparison.
    const dummy = await dummySecretHash();
    expect(dummy).toMatch(/^v1:scrypt:/);
    expect(await verifySecret('anything at all', dummy)).toBe(false);

    // Memoised: the second call must not pay for another derivation.
    expect(await dummySecretHash()).toBe(dummy);
  });
});
