import { describe, expect, it } from 'vitest';
import { money, toMajor } from '@xetral/shared';
import {
  MICRO_PER_CENT,
  MICRO_PER_USD,
  MicroAmountError,
  microToUsd,
  microToUsdExact,
  parseMicro,
  usdToMicro,
} from './amounts.js';

describe('the scale itself', () => {
  it('is 1 USD = 1,000,000 micro = 100 cents', () => {
    // If this ever changes, everything below is wrong by a power of ten and
    // the failure lands on customer balances.
    expect(MICRO_PER_USD).toBe(1_000_000n);
    expect(MICRO_PER_CENT).toBe(10_000n);
    expect(MICRO_PER_USD / MICRO_PER_CENT).toBe(100n);
  });
});

describe('parsing micro-units', () => {
  it('accepts an integer string', () => {
    expect(parseMicro('25000000')).toBe(25_000_000n);
    expect(parseMicro(' -25000000 ')).toBe(-25_000_000n);
  });

  it('accepts a safe integer number', () => {
    expect(parseMicro(25_000_000)).toBe(25_000_000n);
  });

  it('rejects a number that JSON.parse has already corrupted', () => {
    // THE case this function exists for. 12345678901234567 cannot be
    // represented as a double; by the time it is a JS number it is
    // ...568, and the lost unit is unrecoverable. Accepting it would write a
    // wrong amount that looks entirely plausible.
    const corrupted = 12345678901234567;
    expect(corrupted).not.toBe(12345678901234567n as unknown as number);
    expect(() => parseMicro(corrupted)).toThrow(MicroAmountError);
    expect(() => parseMicro(corrupted)).toThrow(/MAX_SAFE_INTEGER|string/);

    // The same value as a string survives intact, which is the fix the error
    // message points at.
    expect(parseMicro('12345678901234567')).toBe(12345678901234567n);
  });

  it('rejects a fractional amount rather than truncating it', () => {
    expect(() => parseMicro(25_000_000.5)).toThrow(MicroAmountError);
    expect(() => parseMicro('25000000.5')).toThrow(MicroAmountError);
  });

  it('rejects junk and missing values', () => {
    for (const bad of [undefined, null, {}, [], '', 'abc', '1e6', true]) {
      expect(() => parseMicro(bad)).toThrow(MicroAmountError);
    }
  });
});

describe('micro-units to cents', () => {
  it('converts a whole-dollar charge', () => {
    // $25.00 -> 2500 cents. The number a card statement shows.
    const { amount, remainderMicro } = microToUsd(25_000_000n);
    expect(amount.amount).toBe(2500n);
    expect(amount.currency).toBe('USD');
    expect(remainderMicro).toBe(0n);
    expect(toMajor(amount)).toBe('25.00');
  });

  it('converts an amount with cents', () => {
    expect(microToUsd(1_234_560_000n).amount.amount).toBe(123_456n);
  });

  it('hands back the sub-cent remainder instead of hiding it', () => {
    // 1,234,567 micro is 123.4567 cents. The ledger's smallest unit is the
    // cent, so 123 is posted and 4,567 micro is returned for the caller to
    // account for -- not silently dropped, and not rounded into existence.
    const { amount, remainderMicro } = microToUsd(1_234_567n);
    expect(amount.amount).toBe(123n);
    expect(remainderMicro).toBe(4_567n);
  });

  it('keeps a refund the exact mirror of the charge it reverses', () => {
    // Truncation toward zero, not toward negative infinity. If -7 rounded away
    // from zero while +7 rounded toward it, a refund would not cancel its
    // charge and the pair would leave a residue in the ledger.
    const charge = microToUsd(1_234_567n);
    const refund = microToUsd(-1_234_567n);
    expect(refund.amount.amount).toBe(-charge.amount.amount);
    expect(refund.remainderMicro).toBe(-charge.remainderMicro);
  });

  it('survives an amount beyond what a double can hold', () => {
    // A platform-wide float figure passes through here. 2^53 cents is about
    // $90 trillion; bigint has no such ceiling.
    const huge = 90_071_992_547_409_930_000n;
    expect(microToUsd(huge).amount.amount).toBe(9_007_199_254_740_993n);
  });
});

describe('the exact conversion', () => {
  it('accepts a whole number of cents', () => {
    expect(microToUsdExact(25_000_000n).amount).toBe(2500n);
  });

  it('refuses a sub-cent amount rather than picking a direction', () => {
    // Used on the settlement path, where a fractional cent means the provider
    // contract changed. Failing loudly makes that an alert instead of a slow
    // drip nobody reads.
    expect(() => microToUsdExact(1_234_567n)).toThrow(MicroAmountError);
    expect(() => microToUsdExact(1n)).toThrow(/whole number of cents/);
  });
});

describe('cents back to micro-units', () => {
  it('round-trips exactly', () => {
    for (const cents of [0n, 1n, 2500n, 123_456n, 9_007_199_254_740_993n]) {
      const usd = money(cents, 'USD');
      expect(microToUsd(usdToMicro(usd)).amount.amount).toBe(cents);
    }
  });

  it('never leaves a remainder in that direction', () => {
    // Cents divide into micro-units cleanly, so outbound amounts are always
    // exact. Only the inbound direction can lose anything.
    expect(usdToMicro(money(2500n, 'USD'))).toBe(25_000_000n);
    expect(microToUsd(usdToMicro(money(123n, 'USD'))).remainderMicro).toBe(0n);
  });
});

describe('no floats anywhere on this path', () => {
  it('produces bigint amounts, never numbers', () => {
    const { amount } = microToUsd(25_000_000n);
    expect(typeof amount.amount).toBe('bigint');
    expect(typeof usdToMicro(amount)).toBe('bigint');
  });

  it('gives an exact answer where a float would drift', () => {
    // 0.1 + 0.2 !== 0.3 is the whole reason this module exists. Summing a
    // hundred amounts of $0.07 must land on exactly $7.00.
    let total = 0n;
    for (let i = 0; i < 100; i++) total += microToUsd(70_000n).amount.amount;
    expect(total).toBe(700n);

    let floatTotal = 0;
    for (let i = 0; i < 100; i++) floatTotal += 0.07;
    expect(floatTotal).not.toBe(7);
  });
});
