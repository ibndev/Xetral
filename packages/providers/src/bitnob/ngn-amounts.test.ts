import { describe, expect, it } from 'vitest';
import { assertWithinCeiling, depositToKobo, DepositCeilingError } from './ngn-amounts.js';
import { ProviderContractError } from '../ports/errors.js';

describe('reading an NGN deposit amount', () => {
  it('treats kobo as the identity', () => {
    expect(depositToKobo('5000000', 'kobo')).toBe(5_000_000n);
  });

  it('scales naira into kobo', () => {
    expect(depositToKobo('50000', 'naira')).toBe(5_000_000n);
  });

  it('divides micro-units into kobo', () => {
    // N50,000.00 == 50,000,000,000 micro == 5,000,000 kobo
    expect(depositToKobo('50000000000', 'micro')).toBe(5_000_000n);
  });

  it('refuses a micro amount that is not a whole kobo', () => {
    // A deposit must equal what left the customer's account to the kobo.
    // Rounding here would invent money no bank sent.
    expect(() => depositToKobo('50000000001', 'micro')).toThrow(ProviderContractError);
  });

  it('rejects a JSON number past MAX_SAFE_INTEGER rather than coercing it', () => {
    // By this point JSON.parse has already rounded it, and no care downstream
    // recovers the lost unit.
    expect(() => depositToKobo(12345678901234567890, 'kobo')).toThrow(/string/);
  });

  it('accepts a safe integer', () => {
    expect(depositToKobo(5_000_000, 'kobo')).toBe(5_000_000n);
  });

  it('rejects a decimal string', () => {
    // Naira-as-text with decimals is VTpass's convention, not this one, and
    // guessing which is which is how a deposit is read 100x wrong.
    expect(() => depositToKobo('50000.00', 'naira')).toThrow(ProviderContractError);
  });

  it('rejects a value that is not a number at all', () => {
    expect(() => depositToKobo(null, 'kobo')).toThrow(ProviderContractError);
    expect(() => depositToKobo(undefined, 'kobo')).toThrow(ProviderContractError);
  });
});

describe('the ceiling', () => {
  const CEILING = 500_000_00n; // N500,000.00

  it('passes an ordinary deposit', () => {
    expect(() => assertWithinCeiling(50_000_00n, CEILING)).not.toThrow();
  });

  it('refuses one above the ceiling', () => {
    expect(() => assertWithinCeiling(600_000_00n, CEILING)).toThrow(DepositCeilingError);
  });

  it('catches a 100x unit misconfiguration on the first real deposit', () => {
    // THE point of the ceiling. If the unit is set to kobo but Bitnob is
    // actually sending naira, a N50,000 transfer reads as N5,000,000 — which
    // blows any sane ceiling, lands in suspense, and credits nobody.
    const misread = depositToKobo('5000000', 'naira'); // meant to be kobo
    expect(() => assertWithinCeiling(misread, CEILING)).toThrow(DepositCeilingError);
  });

  it('says which of the two explanations to check', () => {
    // The error has to be actionable at 3am: either raise the ceiling or fix
    // the unit, and the message names both.
    try {
      assertWithinCeiling(600_000_00n, CEILING);
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).toMatch(/BITNOB_NGN_AMOUNT_UNIT/);
      expect((error as Error).message).toMatch(/ceiling raised/);
    }
  });
});
