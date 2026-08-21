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
  /** The provider's id for the account. Opaque to us; we never parse it. */
  readonly providerAccountId: string;
  /** The ten-digit NUBAN a customer types into their banking app. */
  readonly accountNumber: string;
  readonly bankName: string;
  /** The name the sending bank will display. Customers check this before
   *  sending, so it is part of the product, not a detail. */
  readonly accountName: string;
  readonly currency: Currency;
  readonly active: boolean;
}

export interface CreateVirtualAccountRequest {
  /** The provider's customer id, established by the KYC step. Required, not
   *  optional: a Nigerian bank account cannot be issued to an unidentified
   *  person, and inventing one here would hide a regulatory prerequisite
   *  behind a convenience. */
  readonly providerCustomerId: string;
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
