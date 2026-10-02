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
  /**
   * When this purchase was first initiated — the purchase row's `created_at`,
   * NOT "now".
   *
   * It is here because VTpass requires the id it de-duplicates on to begin
   * with a `YYYYMMDDHHMM` timestamp in Africa/Lagos, and an adapter that used
   * the clock would compute a different id on a retry and on every requery,
   * which defeats both sides' de-duplication at once. Passing the moment the
   * purchase was created makes that id derivable again by anyone holding the
   * row — which is exactly what reconciliation needs, days later.
   *
   * Providers with no such requirement ignore it.
   */
  readonly initiatedAt: Date;
}

/**
 * What it takes to look a purchase up again: our reference, and when it
 * started. The second half is not redundant — see `initiatedAt` above; an
 * adapter that has to reconstruct a provider-side id needs both.
 */
export interface PurchaseLookup {
  readonly reference: string;
  readonly initiatedAt: Date;
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

  /**
   * WHAT THIS ITEM COSTS, read from the provider at the moment of purchase —
   * or null where the customer names the amount (airtime, a meter top-up).
   *
   * THE AMOUNT ON A PURCHASE REQUEST IS THE CUSTOMER'S, and nothing used to
   * compare it with anything. The reserve took whatever figure the request
   * carried and the provider was sent the PRODUCT CODE — an Airalo package,
   * a Twilio number, a VTpass data plan — which it fulfils at its own price
   * whatever we were paid. A request for a $20 eSIM carrying `"amount":
   * "0.01"` was charged one cent and delivered the eSIM; the platform paid
   * the difference out of its float, with every entry balanced. So the
   * service asks this before anything is held, and refuses a request whose
   * amount is not the price.
   *
   * An item the provider does not list is a REJECTION
   * (`ProviderRejectedError`, code `item_not_found`), never a null: a null
   * would let a made-up code through as "customer names the amount".
   */
  priceOf(itemCode: string): Promise<bigint | null>;

  purchase(request: PurchaseRequest): Promise<PurchaseResult>;

  /**
   * Re-reads a purchase by OUR reference.
   *
   * This is the recovery path after a timeout, and it is not a retry. A timeout
   * means we do not know whether the provider acted; asking again is how you
   * find out, and sending the purchase again is how one airtime top-up becomes
   * two.
   */
  status(lookup: PurchaseLookup): Promise<PurchaseResult>;
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

/**
 * WHO WITHIN A SERVICE: the networks airtime and data are sold for, the
 * electricity companies a meter belongs to. An optional capability, for the
 * provider whose catalogue is per group (VTpass's `serviceID`); a provider
 * with one catalogue per service has no groups and does not implement it.
 */
export interface CatalogueGroup {
  /** The provider's own id, which is what a catalogue is asked for by. */
  readonly code: string;
  readonly name: string;
}

export interface CatalogueGroups {
  groups(): Promise<readonly CatalogueGroup[]>;
}

export function supportsGroups(port: FulfilmentPort): port is FulfilmentPort & CatalogueGroups {
  return typeof (port as Partial<CatalogueGroups>).groups === 'function';
}

export function supportsVerification(
  port: FulfilmentPort,
): port is FulfilmentPort & TargetVerification {
  return typeof (port as Partial<TargetVerification>).verifyTarget === 'function';
}
