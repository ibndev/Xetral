import type { Currency, Money } from '@xetral/shared';

/**
 * The FX port: what a currency is worth, and executing a conversion.
 *
 * A RATE IS A RATIO, not a decimal. `quoteMinor = baseMinor * numerator /
 * denominator`, both integers. A decimal rate is a float in disguise and this
 * one multiplies every conversion; and "minor units per major unit" — which
 * works for USD to NGN — collapses in the other direction, where one kobo is
 * 0.0006 cents and any per-major integer rounds to zero.
 */

export interface FxRate {
  readonly base: Currency;
  readonly quote: Currency;
  readonly numerator: bigint;
  readonly denominator: bigint;
  /** Rates move. A stale quote either fails on execution or silently gives the
   *  customer a different number from the one they accepted. */
  readonly expiresAt: Date;
}

export interface FxExecution {
  readonly providerReference: string;
  /** What the provider actually charged us, in BASE minor units. The
   *  difference between this and what the customer paid is our margin, and a
   *  trade that cannot show where its margin came from cannot be audited. */
  readonly costMinor: bigint;
  readonly filledQuoteMinor: bigint;
}

export interface FxPort {
  readonly provider: string;
  /** The market rate, before our spread. */
  rate(base: Currency, quote: Currency): Promise<FxRate>;
  /**
   * Execute the conversion at the provider.
   *
   * `reference` is ours and derived, so their de-duplication and ours agree on
   * what "the same trade" means.
   */
  convert<B extends Currency>(
    base: B,
    quote: Currency,
    // Generic for the same reason as `convertWithSpread`: a bare `Money` here
    // is `Money<Currency>`, which no caller holding a `Money<'NGN'>` can
    // satisfy.
    amount: Money<B>,
    reference: string,
  ): Promise<FxExecution>;
}
