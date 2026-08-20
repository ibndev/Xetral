import type { Currency } from '@xetral/shared';

/**
 * The port for "buy a thing from a provider on a customer's behalf".
 *
 * Airtime, a data bundle, an electricity token, an eSIM, a phone number: all of
 * them are the same shape from the platform's side — pick something from a
 * catalogue, pay for it, receive something to hand the customer. Three
 * providers implement this, and none of their quirks appear here.
 *
 * WHAT DELIBERATELY IS NOT ON THIS PORT
 * -------------------------------------
 * VTpass can verify an electricity meter number before you buy, and returns the
 * account holder's name. That is genuinely useful and genuinely VTpass-shaped.
 * Putting it here would widen the port so two of its three implementations
 * throw — so it lives in `TargetVerification` below, which an adapter opts into.
 * A caller checks for the capability rather than assuming it.
 */

export type ServiceKind = 'airtime' | 'data' | 'utility' | 'esim' | 'number';

export interface CatalogueItem {
  /** The provider's identifier for this product. Opaque to us. */
  readonly code: string;
  readonly name: string;
  /**
   * Minor units, or null when the customer names the amount.
   *
   * Airtime is the null case: you send N500 of it, there is no product with a
   * price. Modelling that as a zero price would make "free" and "you decide"
   * the same value.
   */
  readonly priceMinor: bigint | null;
  readonly currency: Currency;
  readonly metadata: Readonly<Record<string, string>>;
}

export interface CatalogueQuery {
  /** Provider-specific grouping: a network, a disco, a country. */
  readonly group?: string;
}

export interface PurchaseRequest {
  /**
   * OUR reference, stable across retries, and the same value we use for the
   * ledger's idempotency key. Sent to the provider so their side can
   * de-duplicate too — ours stops us double-charging, theirs stops them
   * double-delivering, and a retry needs both.
   */
  readonly reference: string;
  readonly itemCode: string;
  /** Who or what receives it: a phone number, a meter number, a country code. */
  readonly target: string;
  /**
   * Minor units plus a currency code rather than `Money`, for the reason
   * given in ledger-intent: `Money` is invariant, so a bare `Money` field
   * means `Money<Currency>` and would reject every real caller.
   */
  readonly amountMinor: bigint;
  readonly currency: Currency;
}

/**
 * Three states, and the middle one is the point.
 *
 * A provider that has accepted a purchase but not yet delivered is neither a
 * success nor a failure, and collapsing it into a boolean forces the caller to
 * guess. Guessing "delivered" hands the customer nothing; guessing "failed"
 * refunds money that was actually spent.
 */
export type PurchaseStatus = 'delivered' | 'pending' | 'failed';

export interface PurchaseResult {
  readonly status: PurchaseStatus;
  readonly providerReference: string;
  /**
   * What the customer actually receives: an electricity token, an eSIM
   * activation code, the number that was bought. Free-form because it differs
   * per service and the platform only stores and displays it.
   */
  readonly delivery: Readonly<Record<string, string>>;
  /** Set only when status is 'failed'. Safe to show a customer. */
  readonly failureReason?: string;
}

export interface FulfilmentPort {
  readonly provider: string;
  readonly service: ServiceKind;

  catalogue(query: CatalogueQuery): Promise<readonly CatalogueItem[]>;

  purchase(request: PurchaseRequest): Promise<PurchaseResult>;

  /**
   * Re-reads a purchase by OUR reference.
   *
   * This is the recovery path after a timeout, and it is not a retry. A timeout
   * means we do not know whether the provider acted; asking again is how you
   * find out, and sending the purchase again is how one airtime top-up becomes
   * two.
   */
  status(reference: string): Promise<PurchaseResult>;
}

export interface VerifiedTarget {
  readonly target: string;
  /** The account holder, when the provider returns one. Shown to the customer
   *  so they can confirm they are paying the right meter. */
  readonly name: string;
  readonly metadata: Readonly<Record<string, string>>;
}

/**
 * An optional capability, not part of the port.
 *
 * A caller tests for it (`supportsVerification(port)`) rather than assuming it,
 * so adding a provider that cannot verify does not mean adding a method that
 * throws.
 */
export interface TargetVerification {
  verifyTarget(itemCode: string, target: string): Promise<VerifiedTarget>;
}

export function supportsVerification(
  port: FulfilmentPort,
): port is FulfilmentPort & TargetVerification {
  return typeof (port as Partial<TargetVerification>).verifyTarget === 'function';
}
