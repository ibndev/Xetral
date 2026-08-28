import type { Currency, Money } from '@xetral/shared';

/**
 * Asking a provider what it thinks we hold.
 *
 * SEPARATE FROM EVERY OTHER PORT, deliberately. `CardPort`, `FundingPort`,
 * `CryptoPort` and `FxPort` are each about MOVING money and each answers about
 * one transaction. This one answers about a TOTAL, and a total is the only
 * question that catches money which was never a transaction on our side — a
 * fee deducted from the float, a settlement applied and never announced, a
 * credit made outside our flow. Bolting it onto one of the others would tie
 * "what do we hold" to whichever product happened to own the adapter.
 *
 * It is READ-ONLY by construction. Nothing here can move a balance, which is
 * what makes it safe for a scheduled job to call on a loop.
 */
export interface ProviderBalancePort {
  /** Which provider this is, for the record a discrepancy writes. */
  readonly provider: string;

  /**
   * Everything the provider says it holds for us, per currency.
   *
   * An array rather than a map keyed by currency, because `Money` is invariant
   * over its currency parameter: a `Record<Currency, Money<Currency>>` cannot
   * be expressed without widening the value to `Money<Currency>`, the union,
   * which is precisely the type that rejects every real caller. Each element
   * carries its own currency and stays narrow.
   */
  floatBalances(): Promise<readonly Money<Currency>[]>;
}
