import { describe, expect, it } from 'vitest';
import { convertWithSpread, displayRate, invert } from './rate-math.js';
import type { FxRate } from '../ports/fx.js';
import { money } from '@xetral/shared';

/** 1 USD = ₦1,650.25, expressed as the ratio kobo-per-cent: 165025 / 100. */
const USD_NGN: FxRate = {
  base: 'USD',
  quote: 'NGN',
  numerator: 165_025n,
  denominator: 100n,
  expiresAt: new Date('2030-01-01'),
};

/** The same rate the other way: cents per kobo. */
const NGN_USD: FxRate = {
  base: 'NGN',
  quote: 'USD',
  numerator: 100n,
  denominator: 165_025n,
  expiresAt: new Date('2030-01-01'),
};

describe('converting with no spread', () => {
  it('turns $100.00 into ₦165,025.00', () => {
    const out = convertWithSpread(money(10_000n, 'USD'), USD_NGN, 0);
    expect(out.quoteMinor).toBe(16_502_500n);
    expect(out.spreadMinor).toBe(0n);
  });

  it('works in the DIRECTION a per-major rate cannot express', () => {
    // ₦165,025.00 back to $100.00. A "minor units per major unit" rate would
    // be 0.0006 cents per kobo, which is zero as an integer — the reason a
    // rate is stored as a ratio.
    const out = convertWithSpread(money(16_502_500n, 'NGN'), NGN_USD, 0);
    expect(out.quoteMinor).toBe(10_000n);
  });
});

describe('the spread', () => {
  it('comes off the base amount, in the base currency', () => {
    // 1.5% of ₦1,650,250.00 is ₦24,753.75.
    const out = convertWithSpread(money(165_025_000n, 'NGN'), NGN_USD, 150);
    expect(out.spreadMinor).toBe(2_475_375n);
    // And the customer converts what is left.
    expect(out.quoteMinor).toBe(98_500n); // $985.00
  });

  it('rounds the spread DOWN, in the customer\'s favour', () => {
    // 1 basis point of 12345 kobo is 1.2345 kobo. Rounding up would take a
    // whole kobo the customer never agreed to.
    const out = convertWithSpread(money(12_345n, 'NGN'), NGN_USD, 1);
    expect(out.spreadMinor).toBe(1n);
  });

  it('takes nothing at zero basis points', () => {
    const out = convertWithSpread(money(1_000_000n, 'NGN'), NGN_USD, 0);
    expect(out.spreadMinor).toBe(0n);
  });

  it('refuses a spread outside 0..10000 basis points', () => {
    expect(() => convertWithSpread(money(100n, 'USD'), USD_NGN, -1)).toThrow(RangeError);
    expect(() => convertWithSpread(money(100n, 'USD'), USD_NGN, 10_001)).toThrow(RangeError);
    // And a decimal, which is a float trying to be a rate.
    expect(() => convertWithSpread(money(100n, 'USD'), USD_NGN, 1.5)).toThrow(RangeError);
  });
});

describe('rounding on the conversion', () => {
  it('rounds DOWN, never crediting a unit nobody gave us', () => {
    // 1 kobo at this rate is 0.000606 cents. Rounding up would credit a whole
    // cent the provider never supplied, which the balance invariant would then
    // have to absorb from somewhere.
    expect(() => convertWithSpread(money(1n, 'NGN'), NGN_USD, 0)).toThrow(/yields nothing/);
  });

  it('refuses a conversion that would yield zero rather than quoting it', () => {
    // A customer paying and receiving nothing is not a trade.
    expect(() => convertWithSpread(money(100n, 'NGN'), NGN_USD, 0)).toThrow(RangeError);
  });
});

describe('what it refuses', () => {
  it('refuses an amount in the wrong currency for the rate', () => {
    // The compiler cannot catch this — `Money<Currency>` is the union — so the
    // check has to be here.
    expect(() => convertWithSpread(money(100n, 'NGN'), USD_NGN, 0)).toThrow(
      /cannot be converted by a USD rate/,
    );
  });

  it('refuses a zero or negative amount', () => {
    expect(() => convertWithSpread(money(0n, 'USD'), USD_NGN, 0)).toThrow(RangeError);
    expect(() => convertWithSpread(money(-100n, 'USD'), USD_NGN, 0)).toThrow(RangeError);
  });
});

describe('the applied rate', () => {
  it('describes what happened, spread included', () => {
    // Not the market rate: the ratio between what the customer gave up and
    // what they received. That is the number a statement has to show.
    const out = convertWithSpread(money(165_025_000n, 'NGN'), NGN_USD, 150);
    expect(out.appliedDenominator).toBe(165_025_000n);
    expect(out.appliedNumerator).toBe(out.quoteMinor);
  });
});

describe('inverting', () => {
  it('swaps the pair and the ratio', () => {
    const back = invert(USD_NGN);
    expect(back.base).toBe('NGN');
    expect(back.quote).toBe('USD');
    expect(back.numerator).toBe(100n);
    expect(back.denominator).toBe(165_025n);
  });

  it('round-trips an amount to within rounding', () => {
    const there = convertWithSpread(money(10_000n, 'USD'), USD_NGN, 0);
    const back = convertWithSpread(money(there.quoteMinor, 'NGN'), invert(USD_NGN), 0);
    expect(back.quoteMinor).toBe(10_000n);
  });
});

describe('displayRate', () => {
  it('renders a rate a human can read', () => {
    // USD (2dp) to NGN (2dp): 165025/100 with equal exponents is 1650.25.
    expect(displayRate(USD_NGN, 2, 2)).toBe('1650.25');
  });
});
