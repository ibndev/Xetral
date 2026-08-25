import type { Money } from '@xetral/shared';

/**
 * The virtual-card port.
 *
 * Written against what the PLATFORM needs, not against what Bitnob returns.
 * That is the whole discipline of a port: when a second issuer is added, this
 * file does not change, and the quirks of the new one are absorbed in its
 * adapter. A port that grows a `bitnobCardReference` field has stopped being a
 * port.
 */

export type CardStatus = 'active' | 'frozen' | 'terminated';

export interface VirtualCard {
  /** The provider's id for the card. Opaque to us; we never parse it. */
  readonly providerCardId: string;
  readonly status: CardStatus;
  readonly last4: string;
  readonly expiryMonth: number;
  readonly expiryYear: number;
  readonly balance: Money<'USD'>;
}

/**
 * What a customer needs in order to actually USE the card, and what nothing in
 * this platform may store.
 *
 * A SEPARATE TYPE from `VirtualCard`, and that separation is the design. If
 * these fields were optional members of `VirtualCard`, every listing, every
 * webhook mapping and every log line that serialises a card would carry a PAN
 * whenever the provider happened to include one — and the day it did, nothing
 * would fail. Two types means the number can only travel through code that
 * asked for it by name.
 *
 * It exists for exactly one round trip: fetched from the provider, returned to
 * the customer who proved a PIN, and dropped. `003_cards.sql` has no column
 * that could hold it, which is what makes "never stored" structural rather
 * than a rule somebody has to keep.
 */
export interface CardSecrets {
  /** The full card number. Never logged, never stored, never in an error. */
  readonly pan: string;
  readonly cvv: string;
  readonly expiryMonth: number;
  readonly expiryYear: number;
  /** As embossed. Absent when the provider does not return it. */
  readonly nameOnCard?: string;
}

export interface IssueCardRequest {
  /** Our user id. The adapter maps it to the provider's customer reference. */
  readonly ownerId: string;
  readonly providerCustomerId: string;
  readonly nameOnCard: string;
  /** Amount to load at creation. */
  readonly initialFunding: Money<'USD'>;
}

export interface FundCardRequest {
  readonly providerCardId: string;
  readonly amount: Money<'USD'>;
  /**
   * Caller-generated, stable across retries.
   *
   * Required rather than optional, because the operation it guards is "move
   * money" and a retry without one is how a single funding becomes two. There
   * is no sensible default the adapter could invent.
   */
  readonly idempotencyKey: string;
}

/**
 * The result of an operation whose outcome is not yet known.
 *
 * Bitnob's card funding returns immediately with `status: "pending"` and
 * `balance_before === balance_after`, and that response must NOT be read as
 * success — the final state arrives by webhook, or by polling the card's
 * transactions. Modelling it as a distinct state rather than a boolean means a
 * caller cannot accidentally treat "we don't know yet" as "done".
 */
export type OperationOutcome =
  | { readonly state: 'settled' }
  | { readonly state: 'pending'; readonly providerReference: string };

export interface CardPort {
  issue(request: IssueCardRequest): Promise<VirtualCard>;
  fund(request: FundCardRequest): Promise<OperationOutcome>;
  freeze(providerCardId: string): Promise<VirtualCard>;
  unfreeze(providerCardId: string): Promise<VirtualCard>;
  terminate(providerCardId: string): Promise<VirtualCard>;
  get(providerCardId: string): Promise<VirtualCard>;
  /**
   * The number, the CVV and the expiry.
   *
   * Separate from `get` even though a provider may serve both from one call.
   * `get` is used by reconciliation and by ordinary reads; if it returned
   * secrets, every one of those paths would be handling a PAN it never asked
   * for. A caller has to name this method to receive one.
   *
   * Throws rather than returning a partial when the provider does not supply
   * the fields: half a card number is not a degraded reveal, it is a customer
   * staring at something they cannot use and no indication why.
   */
  reveal(providerCardId: string): Promise<CardSecrets>;
}
