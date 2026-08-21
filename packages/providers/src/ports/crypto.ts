import type { Currency, Money } from '@xetral/shared';

/**
 * The crypto port: on-chain deposits and withdrawals.
 *
 * Two things here have no equivalent anywhere else in the platform, and the
 * port is shaped by both.
 *
 * A DEPOSIT IS NOT FINAL WHEN FIRST SEEN. `confirmations` is on the event
 * rather than implied, and the caller decides when it is enough. Modelling a
 * deposit as a single "it arrived" would credit money a chain reorganisation
 * can still remove.
 *
 * A WITHDRAWAL CANNOT BE RECALLED. There is no chargeback and no provider to
 * appeal to, so `send` is the last moment anything can be checked — which is
 * why quoting the fee is a separate call the caller must make first, and why
 * the port has no `cancel`.
 */

export type CryptoNetwork = 'bitcoin' | 'ethereum' | 'tron' | 'bsc';

export interface CryptoAddress {
  readonly providerAddressId: string;
  readonly address: string;
  /** Chains that use one (memo/tag). Sending without it loses the money on
   *  those chains, so it is part of the address, not an extra. */
  readonly memo: string | undefined;
  readonly asset: Currency;
  readonly network: CryptoNetwork;
}

export interface CreateAddressRequest {
  readonly providerCustomerId: string;
  readonly asset: Currency;
  readonly network: CryptoNetwork;
  /** Stable across retries: a second address for the same customer is one more
   *  place money can arrive that nobody is watching. */
  readonly idempotencyKey: string;
}

export interface WithdrawalQuote {
  /** What the network will charge, in the ASSET's minor units. */
  readonly feeMinor: bigint;
  /** How long this quote is good for. Fees move; a stale one either fails to
   *  broadcast or silently costs the customer more than they agreed. */
  readonly expiresAt: Date;
}

export interface SendRequest {
  readonly asset: Currency;
  readonly network: CryptoNetwork;
  readonly destination: string;
  readonly memo: string | undefined;
  /** What the DESTINATION receives. The fee is charged on top. */
  readonly amount: Money<Currency>;
  readonly feeMinor: bigint;
  /** Ours, derived from the customer's key. Sent so their de-duplication and
   *  ours agree on what "the same withdrawal" means — the one operation where
   *  a duplicate cannot be undone. */
  readonly reference: string;
}

export type WithdrawalState = 'broadcast' | 'confirmed' | 'failed';

export interface WithdrawalReceipt {
  readonly providerReference: string;
  readonly state: WithdrawalState;
  /** Present once it is on a chain. */
  readonly txHash: string | undefined;
  readonly failureReason: string | undefined;
}

export interface CryptoPort {
  readonly provider: string;
  createDepositAddress(request: CreateAddressRequest): Promise<CryptoAddress>;
  /** What the network will charge. Called BEFORE the customer commits, so the
   *  number they approve is the number they pay. */
  quoteWithdrawal(
    asset: Currency,
    network: CryptoNetwork,
    amount: Money<Currency>,
  ): Promise<WithdrawalQuote>;
  send(request: SendRequest): Promise<WithdrawalReceipt>;
  /** The reconciliation path. A send that timed out may or may not have been
   *  broadcast, and only the provider knows which. */
  withdrawalStatus(reference: string): Promise<WithdrawalReceipt>;
}
