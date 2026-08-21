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
}
