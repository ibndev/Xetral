import { describe, expect, it } from 'vitest';
import {
  add,
  allocate,
  applyBasisPoints,
  divideRounded,
  format,
  fromMajor,
  money,
  ngn,
  subtract,
  sum,
  toMajor,
  usd,
  greaterThan,
} from './money.js';
import { exponentOf, scaleOf } from './currency.js';

describe('construction', () => {
  it('rejects a fractional minor unit', () => {
    // 150.5 kobo is not a thing. Catching it here is the difference between
    // a loud error and a silently truncated fee.
    expect(() => money(150.5, 'NGN')).toThrow(RangeError);
  });

  it('accepts bigint and number alike', () => {
    expect(ngn(150_00).amount).toBe(15000n);
    expect(ngn(15000n).amount).toBe(15000n);
  });
});

describe('arithmetic', () => {
  it('adds and subtracts within a currency', () => {
    expect(add(ngn(1000), ngn(500)).amount).toBe(1500n);
    expect(subtract(ngn(1000), ngn(1500)).amount).toBe(-500n);
  });

  it('throws on cross-currency data arriving at runtime', () => {
    // The generic blocks this at compile time; the cast simulates untyped
    // JSON off a provider webhook, which is the only way it can happen.
    const dollars = usd(100) as unknown as ReturnType<typeof ngn>;
    expect(() => add(ngn(100), dollars)).toThrow(/currency mismatch/);
  });

  it('sums an empty list to zero rather than failing', () => {
    expect(sum('NGN', []).amount).toBe(0n);
  });

  it('handles amounts beyond Number.MAX_SAFE_INTEGER', () => {
    // ~₦92 trillion in kobo is where a JS number stops being exact. A
    // platform-wide liability account will pass through here.
    const huge = ngn(9_007_199_254_740_993n); // MAX_SAFE_INTEGER + 2
    expect(add(huge, ngn(1n)).amount).toBe(9_007_199_254_740_994n);
    expect(Number(huge.amount) + 1).not.toBe(9_007_199_254_740_994); // float loses it
  });
});

describe('divideRounded', () => {
  it('rounds away from and toward zero consistently for negatives', () => {
    // bigint division truncates toward zero: -7n / 2n === -3n. If 'up' meant
    // "toward positive infinity", a fee on a reversal would not cancel the
    // fee on the original. Both directions are defined by MAGNITUDE.
    expect(divideRounded(7n, 2n, 'up')).toBe(4n);
    expect(divideRounded(-7n, 2n, 'up')).toBe(-4n);
    expect(divideRounded(7n, 2n, 'down')).toBe(3n);
    expect(divideRounded(-7n, 2n, 'down')).toBe(-3n);
  });

  it('breaks ties to even', () => {
    expect(divideRounded(5n, 2n, 'half-even')).toBe(2n); // 2.5 -> 2
    expect(divideRounded(7n, 2n, 'half-even')).toBe(4n); // 3.5 -> 4
    expect(divideRounded(-5n, 2n, 'half-even')).toBe(-2n);
  });

  it('does not drift upward over a long run of ties, unlike half-up', () => {
    // The reason banker's rounding is the default an auditor expects.
    // Every one of these 50 divisions is an exact .5 tie. half-up rounds all
    // 50 the same way, gaining 0.5 each time; half-even alternates and lands
    // on the true total exactly.
    let evenTotal = 0n;
    let halfUpTotal = 0n;
    for (let i = 1n; i <= 100n; i += 2n) {
      evenTotal += divideRounded(i, 2n, 'half-even');
      halfUpTotal += divideRounded(i, 2n, 'up');
    }
    const exactTotal = 1250n; // (1 + 3 + ... + 99) / 2
    expect(evenTotal).toBe(exactTotal); // no drift
    expect(halfUpTotal).toBe(1275n); // 50 ties x 0.5 = 25 units of drift
    expect(halfUpTotal - exactTotal).toBe(25n);
  });

  it('refuses division by zero', () => {
    expect(() => divideRounded(1n, 0n, 'down')).toThrow(RangeError);
  });
});

describe('applyBasisPoints', () => {
  it('computes a 1.5% fee exactly', () => {
    expect(applyBasisPoints(ngn(10_000_00), 150, 'half-even').amount).toBe(15_000n);
  });

  it('does not lose sub-kobo fees to truncation when rounding up', () => {
    // ₦1.00 at 1 bp is 0.01 kobo. 'down' forgoes it; 'up' charges a kobo.
    // Both are legitimate; the point is that the caller chose.
    expect(applyBasisPoints(ngn(100), 1, 'down').amount).toBe(0n);
    expect(applyBasisPoints(ngn(100), 1, 'up').amount).toBe(1n);
  });

  it('rejects a negative or fractional rate', () => {
    expect(() => applyBasisPoints(ngn(100), -5, 'down')).toThrow(RangeError);
    expect(() => applyBasisPoints(ngn(100), 1.5, 'down')).toThrow(RangeError);
  });
});

describe('allocate', () => {
  it('splits without losing a minor unit', () => {
    const parts = allocate(ngn(100_00), 3);
    expect(parts.map((p) => p.amount)).toEqual([3334n, 3333n, 3333n]);
    expect(sum('NGN', parts).amount).toBe(10000n);
  });

  it('reconciles for every split of a stubborn amount', () => {
    // The property that actually matters: parts always sum to the whole.
    for (let n = 1; n <= 17; n++) {
      expect(sum('NGN', allocate(ngn(1_000_01), n)).amount).toBe(100001n);
    }
  });

  it('preserves sign when splitting a refund', () => {
    const parts = allocate(ngn(-100_00), 3);
    expect(sum('NGN', parts).amount).toBe(-10000n);
    expect(parts.every((p) => p.amount <= 0n)).toBe(true);
  });
});

describe('parsing', () => {
  it('round-trips a decimal string', () => {
    expect(fromMajor('1234.56', 'NGN').amount).toBe(123456n);
    expect(toMajor(fromMajor('1234.56', 'NGN'))).toBe('1234.56');
  });

  it('tolerates thousands separators and whitespace', () => {
    expect(fromMajor(' 1,234,567.89 ', 'NGN').amount).toBe(123456789n);
  });

  it('pads a short fraction rather than misreading it', () => {
    expect(fromMajor('10.5', 'NGN').amount).toBe(1050n); // not 105n
  });

  it('rejects more precision than the currency has', () => {
    // Truncating "0.005" to 0 kobo is how a customer gets charged something
    // other than what they typed. Reject and let the caller decide.
    expect(() => fromMajor('0.005', 'NGN')).toThrow(/2 decimal place/);
  });

  it('handles a zero-exponent currency without inventing decimals', () => {
    expect(fromMajor('100', 'JPY').amount).toBe(100n);
    expect(toMajor(money(100n, 'JPY'))).toBe('100');
    expect(() => fromMajor('100.5', 'JPY')).toThrow(/0 decimal place/);
  });

  it('handles crypto precision', () => {
    expect(fromMajor('0.00000001', 'BTC').amount).toBe(1n); // one satoshi
    expect(fromMajor('1250.50', 'USDT').amount).toBe(1_250_500_000n);
  });

  it('rejects junk', () => {
    for (const bad of ['', 'abc', '1.2.3', '--5', '1e5']) {
      expect(() => fromMajor(bad, 'NGN')).toThrow(RangeError);
    }
  });
});

describe('registry invariants', () => {
  it('never assumes an exponent of 2', () => {
    expect(exponentOf('JPY')).toBe(0);
    expect(exponentOf('BTC')).toBe(8);
    expect(scaleOf('JPY')).toBe(1n);
    expect(scaleOf('BTC')).toBe(100_000_000n);
  });

  it('computes scale without passing through a float', () => {
    // 10 ** 18 is not exactly representable as a double. The loop is.
    expect(scaleOf('USDT')).toBe(1_000_000n);
  });
});

describe('formatting', () => {
  it('formats naira for display', () => {
    // Non-breaking spaces vary by ICU build, so assert on the parts.
    const out = format(ngn(1_234_56));
    expect(out).toContain('1,234.56');
    expect(out).toMatch(/₦|NGN/);
  });

  it('formats crypto without Intl, trimming trailing zeros', () => {
    expect(format(money(150_000_000n, 'BTC'))).toBe('1.5 BTC');
    expect(format(money(100_000_000n, 'BTC'))).toBe('1 BTC');
  });

  it('formats negatives', () => {
    expect(format(ngn(-50_00))).toContain('50.00');
  });
});

describe('compile-time currency safety', () => {
  it('rejects cross-currency addition at compile time', () => {
    // Regression guard for the `in out` variance annotation on Money.
    //
    // The directive below inverts the usual contract: it FAILS the build if
    // its line stops erroring. Remove the variance annotation and the
    // widening returns, the line compiles, the directive goes unused, and
    // tsc reports it — turning a silent loss of the guarantee into a red
    // build. Verified the hard way: before the annotation existed, this
    // exact line compiled cleanly and the guarantee was fiction.
    //
    // (Note the phrasing. A comment line STARTING with the directive token
    // is itself parsed as a directive, even mid-paragraph — which is how
    // this block first broke the build it was written to explain.)
    // This closure is NEVER INVOKED. Its body exists only to be type-checked.
    //
    // It has to be uncalled, because these calls are also guarded at runtime:
    // vitest strips the types and executes whatever it can reach, so calling
    // this would throw the very TypeError the type system is meant to make
    // unreachable — and the test would fail for the right reason at the
    // wrong layer. Compile-time and runtime guards are asserted separately.
    const compileTimeOnly = () => {
      // @ts-expect-error — adding NGN to USD must never compile.
      add(ngn(100), usd(100));

      // @ts-expect-error — nor subtraction.
      subtract(usd(100), ngn(100));

      // @ts-expect-error — nor comparison across currencies.
      greaterThan(ngn(100), usd(100));
    };

    expect(compileTimeOnly).toBeTypeOf('function'); // referenced, not run
  });
});
