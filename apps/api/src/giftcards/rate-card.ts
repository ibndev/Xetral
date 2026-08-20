import { divideRounded, scaleOf } from '@xetral/shared';
import type { Currency, Money } from '@xetral/shared';

/**
 * What we pay for a card, and the one place that arithmetic happens.
 *
 * A rate card quotes payout minor units per ONE MAJOR unit of face value:
 * "N1,250.00 per USD" is 125000. That is how the Nigerian gift card market
 * actually prices, and it means the rate IS the currency conversion — which is
 * why this phase does not need Phase 10's FX machinery. The rate is set by us
 * and reviewed by us, so it is a price, not a market quote.
 */

export interface RateCard {
  readonly id: string;
  readonly brand: string;
  readonly country: string;
  readonly card_type: string;
  readonly face_currency: string;
  readonly payout_currency: string;
  readonly payout_rate_minor: string;
  readonly min_face_minor: string;
  readonly max_face_minor: string;
}

/**
 * face_minor * rate / 10^face_exponent.
 *
 * Rounded DOWN, stated explicitly because every rounding choice moves money to
 * someone and this one moves a fraction of a kobo to us. It is defensible at
 * that size and indefensible if it were ever silent, which is why
 * `divideRounded` has no default mode and this call site names one.
 *
 * The division is exact in almost every real case — rates are large and face
 * values are round — so this is not a decision that shows up in a customer's
 * balance. It is a decision that shows up in a reconciliation report if nobody
 * made it.
 */
export function payoutFor(
  faceMinor: bigint,
  rate: RateCard,
  payoutCurrency: Currency,
): Money<Currency> {
  const faceScale = scaleOf(rate.face_currency as Currency);
  const amount = divideRounded(faceMinor * BigInt(rate.payout_rate_minor), faceScale, 'down');
  return { amount, currency: payoutCurrency };
}
