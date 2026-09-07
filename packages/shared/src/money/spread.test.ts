import { describe, expect, it } from 'vitest';
import { scaledRate, widenedSpread } from './spread.js';

const CEILING = 600;

describe('reading a rate without a float', () => {
  it('scales a decimal string by ten to the six', () => {
    expect(scaledRate('1650.000000')).toBe(1_650_000_000n);
    expect(scaledRate('1650')).toBe(1_650_000_000n);
    expect(scaledRate('0.000606')).toBe(606n);
  });

  it('keeps the digits a double would lose', () => {
    // Dollars per naira. As a `Number` the difference between these two is
    // already at the edge of what a double represents exactly, and it is the
    // whole of the move this feature exists to see.
    expect(scaledRate('0.000606') - scaledRate('0.000588')).toBe(18n);
  });

  it('refuses more precision than a rate is stored with', () => {
    // Silently truncating would change a price, which is the one thing a
    // parser here must not do.
    expect(() => scaledRate('1650.0000001')).toThrow(RangeError);
  });

  it('refuses something that is not a rate at all', () => {
    expect(() => scaledRate('1,650.00')).toThrow(RangeError);
    expect(() => scaledRate('')).toThrow(RangeError);
  });
});

describe('the payout currency strengthening', () => {
  it('widens roughly one for one on USD->NGN when the naira strengthens', () => {
    // We pay out naira. The naira getting stronger means fewer of them per
    // dollar, so the rate FALLS — 1650 to 1633.50 is 1%.
    const { effectiveBasisPoints, adverseBasisPoints, capped } = widenedSpread({
      baseBasisPoints: 150,
      publishedRate: '1650.000000',
      currentRate: '1633.500000',
      ceilingBasisPoints: CEILING,
    });
    expect(adverseBasisPoints).toBe(100);
    expect(effectiveBasisPoints).toBe(250);
    expect(capped).toBe(false);
  });

  it('widens on NGN->USD when the DOLLAR strengthens, which is the opposite move', () => {
    /*
     * THE CASE THAT MAKES THIS PER-PAIR RATHER THAN PER-CURRENCY. Here we pay
     * out dollars, so the adverse direction is the dollar strengthening —
     * the opposite statement about the naira from the test above. Expressed
     * as the published rate both are the same fall, which is why one rule
     * covers both and why neither test needed to name a currency.
     */
    const { adverseBasisPoints, effectiveBasisPoints } = widenedSpread({
      baseBasisPoints: 150,
      publishedRate: '0.000606',
      currentRate: '0.000600',
      ceilingBasisPoints: CEILING,
    });
    expect(adverseBasisPoints).toBe(99);
    expect(effectiveBasisPoints).toBe(249);
  });
});

describe('the payout currency weakening', () => {
  it('does NOT narrow, and does not touch the base at all', () => {
    // Charging less than an operator published is a pricing decision. The
    // quote is simply better than it needed to be.
    const moved = widenedSpread({
      baseBasisPoints: 150,
      publishedRate: '1650.000000',
      currentRate: '1700.000000',
      ceilingBasisPoints: CEILING,
    });
    expect(moved.effectiveBasisPoints).toBe(150);
    expect(moved.adverseBasisPoints).toBe(0);
  });

  it('leaves an unmoved rate exactly at the base', () => {
    expect(
      widenedSpread({
        baseBasisPoints: 150,
        publishedRate: '1650.000000',
        currentRate: '1650.000000',
        ceilingBasisPoints: CEILING,
      }).effectiveBasisPoints,
    ).toBe(150);
  });
});

describe('the ceilings', () => {
  it('never exceeds double the base', () => {
    // A 10% move against a 150bp base wants 1150bp; double the base is 300.
    const { effectiveBasisPoints, capped } = widenedSpread({
      baseBasisPoints: 150,
      publishedRate: '1650.000000',
      currentRate: '1485.000000',
      ceilingBasisPoints: CEILING,
    });
    expect(effectiveBasisPoints).toBe(300);
    expect(capped).toBe(true);
  });

  it('never exceeds the hard ceiling either, and the LOWER of the two wins', () => {
    // Base 500 doubles to 1000, so the hard ceiling of 600 is what binds.
    expect(
      widenedSpread({
        baseBasisPoints: 500,
        publishedRate: '1650.000000',
        currentRate: '1485.000000',
        ceilingBasisPoints: CEILING,
      }).effectiveBasisPoints,
    ).toBe(600);
  });

  it('cannot invent a margin on a pair priced at cost', () => {
    // Double zero is zero. A corridor an operator chose to quote at no margin
    // stays at no margin, whatever the market does — this mechanism protects
    // a published price, it does not overrule one.
    expect(
      widenedSpread({
        baseBasisPoints: 0,
        publishedRate: '1650.000000',
        currentRate: '1400.000000',
        ceilingBasisPoints: CEILING,
      }).effectiveBasisPoints,
    ).toBe(0);
  });
});

describe('what it refuses to guess', () => {
  it('holds at the base when there is no observation of the market', () => {
    // A missing figure is not a move. Reading it as one would widen every
    // corridor on the day the feed's key expires, which is the failure 057
    // records as the one nothing else can see.
    expect(
      widenedSpread({
        baseBasisPoints: 150,
        publishedRate: '1650.000000',
        ceilingBasisPoints: CEILING,
      }).effectiveBasisPoints,
    ).toBe(150);
  });

  it('holds at the base on a zero or nonsense rate rather than dividing by it', () => {
    expect(
      widenedSpread({
        baseBasisPoints: 150,
        publishedRate: '0.000000',
        currentRate: '1650.000000',
        ceilingBasisPoints: CEILING,
      }).effectiveBasisPoints,
    ).toBe(150);
  });

  it('rounds DOWN, which favours the customer', () => {
    // 1650 -> 1649.9 is 0.00606%, which is 0 basis points once floored. The
    // opposite direction from tax, and stated because every rounding choice
    // moves money to somebody.
    expect(
      widenedSpread({
        baseBasisPoints: 150,
        publishedRate: '1650.000000',
        currentRate: '1649.900000',
        ceilingBasisPoints: CEILING,
      }).effectiveBasisPoints,
    ).toBe(150);
  });
});
