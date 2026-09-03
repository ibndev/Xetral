import type { Currency, Money } from '@xetral/shared';

/**
 * Sending money to a bank account somebody else holds.
 *
 * THE DESTINATION IS A PERSON, and that is the whole difference from every
 * other outbound port here. A crypto withdrawal goes to a string that either
 * checksums or does not; a bank payout goes to a name and a number that may
 * belong to somebody the sender has never met and did not intend to pay.
 *
 * So the port has a LOOKUP as a first-class operation rather than as a
 * convenience. `lookup()` answers with the name the BANK holds against that
 * account number, which is the only claim about the beneficiary that does not
 * come from the sender — and a transfer confirmed against a name the sender
 * typed themselves confirms nothing at all.
 */

/** A bank a customer can send to. */
export interface PayoutBank {
  /** The provider's code for this bank. Opaque, and passed back verbatim. */
  readonly code: string;
  readonly name: string;
}

/** Who the bank says holds this account. */
export interface BeneficiaryLookup {
  readonly accountNumber: string;
  readonly bankCode: string;
  /** THE BANK'S ANSWER. Never the sender's claim. */
  readonly accountName: string;
}

/**
 * GENERIC OVER THE CURRENCY, and that is not decoration.
 *
 * `Money` is declared `in out` in `@xetral/shared`, so it is INVARIANT: a
 * bare `Money` field means `Money<Currency>` — the union of every currency —
 * and `Money<'NGN'>` is not assignable to it. A non-generic version of this
 * interface compiles perfectly and then rejects every caller that holds a
 * concrete amount, which is all of them.
 *
 * Phase 10 walked into exactly this with `convertWithSpread`, and CLAUDE.md
 * records the rule; the rule is written down because the code still walks
 * into it. `SendRequest` on the crypto port takes the non-generic form and
 * gets away with it only because its callers happen to hold a `Currency`
 * union rather than a literal.
 */
export interface PayoutRequest<C extends Currency = Currency> {
  readonly country: string;
  readonly bankCode: string;
  readonly accountNumber: string;
  /**
   * The name the LOOKUP returned, carried through so the adapter sends what
   * the customer was shown. Passing the sender's own text here would defeat
   * the lookup — see the port's header.
   */
  readonly accountName: string;
  readonly amount: Money<C>;
  readonly narration?: string | undefined;
  /**
   * Ours, and DERIVED from the customer's key rather than generated. Their
   * side de-duplicates on it, so a retry after a timeout is one payout at
   * their end as well as at ours. On this operation a duplicate cannot be
   * clawed back.
   */
  readonly reference: string;
}

/**
 * What came back from sending.
 *
 * `state` is deliberately three-valued and not a boolean. A payout their API
 * has accepted but not yet settled is neither success nor failure, and a
 * caller that collapsed it would either tell a customer money had arrived
 * when it had not, or reverse a payment already on its way.
 */
export interface PayoutReceipt {
  readonly providerPayoutId: string;
  readonly state: 'sent' | 'completed' | 'failed';
  readonly failureReason?: string | undefined;
}

export interface PayoutPort {
  readonly provider: string;

  /** Banks a customer may send to in this country. */
  banks(country: string): Promise<readonly PayoutBank[]>;

  /**
   * Who holds this account.
   *
   * Throws `ProviderRejectedError` when the account does not exist — a
   * rejection, not ill health, so `037`'s failure rate does not count a
   * customer's typo as a provider being down.
   */
  lookup(
    country: string,
    bankCode: string,
    accountNumber: string,
  ): Promise<BeneficiaryLookup>;

  /**
   * Send it.
   *
   * A `ProviderTimeoutError` from here means we DO NOT KNOW whether the
   * payout happened, and the caller must neither settle nor reverse — the
   * rule the whole codebase follows, and the one place where the cost of
   * getting it wrong is a payment that cannot be recalled.
   */
  send<C extends Currency>(request: PayoutRequest<C>): Promise<PayoutReceipt>;

  /** What the provider says became of a payout we sent. */
  status(providerPayoutId: string): Promise<PayoutReceipt>;
}
