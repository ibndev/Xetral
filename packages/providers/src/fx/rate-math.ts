import { divideRounded } from '@xetral/shared';
import type { Currency, Money } from '@xetral/shared';
import type { FxRate } from '../ports/fx.js';

/**
 * The arithmetic that decides how much money somebody gets.
 *
 * One file, with its own tests, for the same reason `bitnob/amounts.ts` and
 * `ngn-amounts.ts` are: a second conversion written inline at a call site is
 * how a rate ends up applied twice, or applied to the wrong side.
 *
 * ROUNDING IS ALWAYS EXPLICIT. `divideRounded` has no default mode, so every
 * call here states one and the choice is visible in review rather than
 * inherited from whatever the division operator happened to do.
 */

export interface ConversionResult {
  /** What the customer receives, after the spread. */
  readonly quoteMinor: bigint;
  /** Our margin, in BASE minor units. */
  readonly spreadMinor: bigint;
  /** The rate actually applied to the customer, as a ratio. Stored on the
   *  trade so a statement months later shows the number they were shown. */
  readonly appliedNumerator: bigint;
  readonly appliedDenominator: bigint;
}

/**
 * Applies a market rate and a spread.
 *
 * The spread comes off the BASE amount before conversion. That is what makes
 * it revenue in the base currency and keeps the entry balanced per currency
 * without a cross-currency fudge:
 *
 *     spread    = baseMinor * bps / 10000              (rounded DOWN)
 *     converted = (baseMinor - spread) * num / den     (rounded DOWN)
 *
 * The two roundings favour opposite parties by less than one minor unit each,
 * and both are stated separately rather than netted, because a reader should
 * be able to check either one on its own.
 */
/**
 * Generic over the base currency, and it has to be.
 *
 * `Money` is invariant, so a bare `Money` parameter means `Money<Currency>` —
 * the union of every currency — and `Money<'USD'>` is deliberately NOT
 * assignable to it. A non-generic signature here would reject every real
 * caller, which is the trap CLAUDE.md records and this function walked into.
 */
export function convertWithSpread<B extends Currency>(
  amount: Money<B>,
  rate: FxRate,
  spreadBasisPoints: number,
): ConversionResult {
  if (amount.currency !== rate.base) {
    throw new RangeError(`a ${amount.currency} amount cannot be converted by a ${rate.base} rate`);
  }
  if (amount.amount <= 0n) {
    throw new RangeError('a conversion needs a positive amount');
  }
  if (!Number.isInteger(spreadBasisPoints) || spreadBasisPoints < 0 || spreadBasisPoints > 10_000) {
    throw new RangeError(`spread must be 0..10000 basis points, got ${spreadBasisPoints}`);
  }

  // DOWN: the customer keeps the fraction of a minor unit rather than us. On a
  // margin this is the direction that cannot be accused of shaving.
  const spreadMinor = divideRounded(amount.amount * BigInt(spreadBasisPoints), 10_000n, 'down');
  const convertible = amount.amount - spreadMinor;

  // DOWN again, and here it favours US by under one minor unit of the quote
  // currency. Rounding up would credit a unit no provider gave us, which the
  // balance invariant would then have to absorb from somewhere.
  const quoteMinor = divideRounded(convertible * rate.numerator, rate.denominator, 'down');

  if (quoteMinor <= 0n) {
    // Below this the conversion is meaningless: the customer pays and receives
    // nothing. Refusing beats quoting zero.
    throw new RangeError(
      `converting ${amount.amount} ${amount.currency} at this rate yields nothing`,
    );
  }

  return {
    quoteMinor,
    spreadMinor,
    // The EFFECTIVE rate, base-to-quote INCLUDING the spread — not the market
    // rate. This is the number for a statement, because it describes what
    // actually happened to the customer's money.
    appliedNumerator: quoteMinor,
    appliedDenominator: amount.amount,
  };
}

/** Inverts a rate, for quoting the other direction of a pair. */
export function invert(rate: FxRate): FxRate {
  return {
    base: rate.quote,
    quote: rate.base,
    numerator: rate.denominator,
    denominator: rate.numerator,
    expiresAt: rate.expiresAt,
  };
}

/**
 * A rate rendered for display: quote major units per ONE base major unit.
 *
 * DISPLAY ONLY, and named so. It goes through a float and must never compute
 * an amount — the ratio is the authority and this is a rendering of it. Same
 * rule as Bitnob's `display_amount`.
 */
export function displayRate(rate: FxRate, baseExponent: number, quoteExponent: number): string {
  const scaled =
    (Number(rate.numerator) / Number(rate.denominator)) * 10 ** (baseExponent - quoteExponent);
  return scaled.toFixed(Math.max(2, quoteExponent));
}
