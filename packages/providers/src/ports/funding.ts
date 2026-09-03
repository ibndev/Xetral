import type { Currency } from '@xetral/shared';

/**
 * The bank-rail port: how a customer gets money INTO the platform.
 *
 * Written against what the platform needs rather than what Bitnob returns, for
 * the usual reason — a second rail (a different issuer, a second country)
 * should touch its own adapter and nothing else. There is deliberately no
 * `bitnobPseudoAccountId` here.
 *
 * WHAT THIS PORT DOES NOT DO
 * --------------------------
 * It does not receive money. Money arrives as a WEBHOOK, which is
 * provider-shaped by nature — signed differently, named differently, and
 * delivered out of order. Parsing one is the adapter's job, and what it
 * produces is a `LedgerIntent` like every other adapter output. This port
 * covers only the part with a request and a response: asking for an account.
 */

export interface VirtualAccount {
  /**
   * WHO ISSUED IT, recorded because a customer's account number is permanent
   * and the platform's choice of rail is not.
   *
   * An operator switching `funding_provider` during an incident changes who
   * the NEXT account is opened with. Every number already out there is saved
   * in somebody's banking app as a beneficiary and keeps receiving money from
   * the provider that issued it, so the row has to say which one that was —
   * reading it off the currently-configured port would relabel every existing
   * account the moment the setting changed.
   */
  readonly provider: string;
  /** The provider's id for the account. Opaque to us; we never parse it. */
  readonly providerAccountId: string;
  /**
   * The provider's own customer id, where the rail keys deposits on the
   * CUSTOMER rather than on the account.
   *
   * Paystack's transaction list is a customer-level query, so the
   * reconciliation sweep — the only thing that finds a webhook that never
   * arrived — cannot run from the account id alone. Undefined for a rail that
   * does not need it.
   */
  readonly providerCustomerRef: string | undefined;
  /** The ten-digit NUBAN a customer types into their banking app. */
  readonly accountNumber: string;
  readonly bankName: string;
  /** The name the sending bank will display. Customers check this before
   *  sending, so it is part of the product, not a detail. */
  readonly accountName: string;
  readonly currency: Currency;
  readonly active: boolean;
}

/**
 * Who the account is for, as the PLATFORM knows them.
 *
 * THE PORT USED TO TAKE A `providerCustomerId` AND NOTHING ELSE, and that was
 * Bitnob's prerequisite written into the shared interface. Bitnob will not
 * issue a naira account without a BVN-verified customer, which is true of
 * Bitnob and is not true of the rail generally: CBN's tiered KYC permits a
 * tier 1 account on a name, a phone number and an address, capped — and
 * `029_kyc_tiers.seed.sql` has capped tier 0 at ₦50,000 a day since it
 * landed. So the old shape refused every unverified customer a way to put
 * money in, on the screen they open in order to do exactly that.
 *
 * The port now carries the identity the platform HAS and each adapter decides
 * what it needs from it. That is the boundary rule this repo already follows
 * for VTpass codes and Airalo's token cache: absorb the quirk in the adapter
 * and let it stop there.
 */
export interface FundingCustomer {
  /** Ours, stable, and what an adapter keys its own customer record on. */
  readonly reference: string;
  readonly email: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly phone: string | undefined;
  /**
   * The provider's own customer id where one already exists — Bitnob's KYC
   * mapping, written by `provider_customers` at approval.
   *
   * Absent is the ordinary state of a new customer, not an error about them.
   * An adapter that CANNOT proceed without one refuses in its own code, where
   * the reason belongs, rather than by a type that makes the requirement
   * everybody's.
   */
  readonly providerCustomerId: string | undefined;
}

export interface CreateVirtualAccountRequest {
  readonly customer: FundingCustomer;
  readonly currency: Currency;
  /**
   * Caller-generated and stable across retries.
   *
   * Without it a timeout followed by a retry issues a SECOND account number to
   * the same customer — and the first one is already in their app, already
   * saved as a beneficiary, and still receiving money nobody is watching.
   */
  readonly idempotencyKey: string;
}

export interface FundingPort {
  readonly provider: string;
  /** Issues the customer's dedicated account, or returns the existing one. */
  createVirtualAccount(request: CreateVirtualAccountRequest): Promise<VirtualAccount>;
  /** Re-reads one, for reconciliation and for confirming activation. */
  getVirtualAccount(providerAccountId: string): Promise<VirtualAccount>;
  /**
   * Deposits the provider has recorded for an account.
   *
   * The reconciliation path for the failure this rail cannot otherwise
   * detect: a webhook that never arrives. The customer transferred money, sees
   * nothing, and no amount of waiting fixes it — so the answer has to be to
   * ASK, the same shape as `FulfilmentPort.status()`.
   */
  listDeposits(providerAccountId: string): Promise<readonly ProviderDeposit[]>;
}

export interface ProviderDeposit {
  /** The provider's id for this credit. Becomes our replay guard. */
  readonly providerReference: string;
  readonly amountMinor: bigint;
  readonly currency: Currency;
  readonly senderName: string | undefined;
  readonly senderBank: string | undefined;
  readonly senderAccount: string | undefined;
  readonly occurredAt: Date;
}
