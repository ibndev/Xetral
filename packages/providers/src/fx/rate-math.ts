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
 * EXACT, AND NOT A FLOAT — which it was, and which was wrong in one of the two
 * directions. `(Number(numerator) / Number(denominator)).toFixed(2)` rendered
 * USD→NGN as "1650.00" and NGN→USD as **"0.00"**, because USD per naira really
 * is 0.000606 and two decimal places cannot show it. A customer converting
 * naira to dollars was shown a rate of zero.
 *
 * That is Phase 10 finding 1 in the display layer: "minor units per major unit
 * works for USD→NGN and collapses in the other direction, where one kobo is
 * 0.0006 cents." The conversion arithmetic was fixed then; the rendering of it
 * was not, in two places that had each grown their own copy.
 *
 * THE PLACES ARE CHOSEN, not fixed. A rate of 1650 needs two decimals and a
 * rate of 0.000606 needs seven, so this widens until the figure carries real
 * digits rather than rounding to nothing — and stops, so a rate is never a
 * wall of noise.
 */
const MIN_SIGNIFICANT = 10_000n;
const MAX_PLACES = 12;

export function displayRate(rate: FxRate, baseExponent: number, quoteExponent: number): string {
  if (rate.numerator === 0n) return '0';

  let places = Math.max(2, quoteExponent);
  let scaled = scaleRate(rate, baseExponent, quoteExponent, places);

  // Widen only while the answer would be misleadingly blunt. A large rate
  // satisfies this on the first pass and keeps its two decimals.
  while (scaled < MIN_SIGNIFICANT && places < MAX_PLACES) {
    places += 1;
    scaled = scaleRate(rate, baseExponent, quoteExponent, places);
  }

  return insertPoint(scaled, places);
}

/**
 * `numerator / denominator * 10^(base - quote)`, rendered at `places` decimal
 * places, entirely in integers.
 *
 * The exponent difference can go either way — NGN→BTC is 2 − 8 — so the power
 * of ten is applied to whichever side keeps both operands whole. A
 * `10 ** negative` would be the float this function exists to avoid.
 */
function scaleRate(
  rate: FxRate,
  baseExponent: number,
  quoteExponent: number,
  places: number,
): bigint {
  const shift = places + baseExponent - quoteExponent;
  const numerator =
    shift >= 0 ? rate.numerator * 10n ** BigInt(shift) : rate.numerator;
  const denominator =
    shift >= 0 ? rate.denominator : rate.denominator * 10n ** BigInt(-shift);
  return numerator / denominator;
}

/** Puts the decimal point in, without going through a number. */
function insertPoint(scaled: bigint, places: number): string {
  if (places === 0) return scaled.toString();
  const digits = scaled.toString().padStart(places + 1, '0');
  return `${digits.slice(0, digits.length - places)}.${digits.slice(digits.length - places)}`;
}
