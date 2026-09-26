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
  /**
   * THE PROVIDER'S OWN ID FOR THE BANK, WHICH IS NOT ITS CODE.
   *
   * Flutterwave answer `{ id: 280, code: "GH280100", name: … }` and the
   * branches call takes the ID. Optional because no other rail has one, and
   * because a country that needs no branch code never asks.
   */
  readonly id?: string;
}

/**
 * A BRANCH OF A BANK, which one corridor genuinely requires.
 *
 * FLUTTERWAVE, VERBATIM: "When transferring to Ghanaian bank accounts and
 * mobile money wallets, you need to pass the branch code of the institution or
 * telco in your Initiate Transfer request as destination_branch_code."
 *
 * It is a port method rather than a detail inside the adapter because the
 * SCREEN has to ask for it — a customer paying a Ghanaian bank account picks a
 * branch, the way they pick a bank. Where a rail needs none, `branches()`
 * answers an empty list and no picker is drawn, so the question "does this
 * corridor need one?" is answered by the adapter rather than by a `switch` in
 * two apps — 040's argument about a country being data.
 */
export interface PayoutBranch {
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
   * THE BRANCH, WHERE THE CORRIDOR REQUIRES ONE — Ghana, today.
   *
   * Undefined everywhere else, and sending an empty string instead would be a
   * field their API has to decide what to do with. 070 gave Ghana a bank rail
   * and every transfer on it would have been refused without this.
   */
  readonly branchCode?: string | undefined;
  /**
   * The name the LOOKUP returned, carried through so the adapter sends what
   * the customer was shown. Passing the sender's own text here would defeat
   * the lookup — see the port's header.
   *
   * OPTIONAL, BECAUSE ONE RAIL HAS NO NAME TO RETURN. A mobile money wallet
   * has no name enquiry on any network, so there is nothing to look up and
   * nothing to carry — and a required field here made that state
   * inexpressible, which is why the service refused every Ghanaian and Kenyan
   * payout rather than sending one. Undefined means NOBODY CONFIRMED WHO
   * HOLDS THIS, and is the only honest value; the alternative a required field
   * invites is the sender's own text, which confirms nothing while looking
   * exactly like a confirmation.
   */
  readonly accountName?: string | undefined;
  readonly amount: Money<C>;
  readonly narration?: string | undefined;
  /**
   * Ours, and DERIVED from the customer's key rather than generated. Their
   * side de-duplicates on it, so a retry after a timeout is one payout at
   * their end as well as at ours. On this operation a duplicate cannot be
   * clawed back.
   */
  readonly reference: string;
  /**
   * WHO IS SENDING, for the corridors that require it by regulation.
   *
   * Kenya's M-PESA payout is refused without `meta.sender`,
   * `meta.sender_country` and `meta.mobile_number` — it is treated as a
   * cross-border remittance and the originator has to be named. We sent no
   * `meta` at all, so every shilling transfer was refused for a missing
   * required field before anything else about it was considered.
   *
   * It is the SENDING CUSTOMER, never the platform: a remittance names the
   * person the money came from. Optional on the port because the rails that
   * do not ask for it must not be made to carry it.
   */
  readonly sender?:
    | {
        readonly name: string;
        /** ISO-3166 alpha-2 of the sender's own country. */
        readonly country: string;
        /** The sender's own number, digits only, international form. */
        readonly phone: string;
      }
    | undefined;
  /**
   * WHICH OF OUR BALANCES FUNDS THIS, when the rail holds several.
   *
   * Flutterwave is a PREFUNDED WALLET, not a rail that moves money on demand:
   * it debits the balance matching the payout currency unless told otherwise,
   * so a cedi payout needs cedis. A platform with no GHS float can either hold
   * one or name a different balance here and accept the provider's conversion
   * rate — and that is a treasury decision somebody has to make, which is why
   * it arrives as a value rather than being assumed by this file.
   *
   * Undefined means "the payout currency", which is the provider's own
   * default.
   */
  readonly debitCurrency?: string | undefined;
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
  /**
   * OUR reference, as the RAIL recorded it — read off their response, never
   * off a webhook body. It is what lets an unsigned event that names a
   * transfer id be checked against the payout it claims to be about: the id
   * comes from the doorbell, the reference from the provider's own answer,
   * and a mismatch settles nothing. Absent where a rail does not return one.
   */
  readonly reference?: string | undefined;
}

/**
 * WHICH RAIL MONEY LEAVES ON, where a country has more than one.
 *
 * 046 put ONE value on the country and that was right at the time — the Send
 * screen was offering a Nigerian bank list in Accra. What it cannot say is
 * "both", and Ghana and Kenya are both: most people there are paid into a
 * wallet, plenty into a bank account, and Flutterwave serves the two from one
 * transfers endpoint with different destination shapes.
 *
 * So the CALLER says which. Undefined means "whatever this country's default
 * is", which is what every caller written before 070 meant.
 */
export type PayoutMethod = 'bank' | 'mobile_money';

/** One transfer's inclusive range on a rail, in minor units. */
export interface TransferLimit {
  readonly minMinor: bigint;
  readonly maxMinor: bigint;
}

export interface PayoutPort {
  readonly provider: string;

  /**
   * WHETHER THIS RAIL SPENDS A BALANCE WE HAVE TO PUT THERE FIRST.
   *
   * Flutterwave does: it debits the balance matching the payout currency, so
   * a cedi payout needs a cedi float and a deployment that has never
   * collected a cedi has none. Paystack and Bitnob do not — they settle from
   * accounts this platform keeps no float in.
   *
   * IT IS ON THE PORT BECAUSE IT IS A FACT ABOUT THE RAIL, and the
   * alternative is a list of provider names in the service — which is the
   * shape 046 already refused for `payout_method` and the fulfilment port
   * refuses for VTpass's response codes. A rail added later declares its own
   * nature rather than being remembered about.
   *
   * ABSENT MEANS NOT PREFUNDED, which is the permissive reading and is
   * deliberate here even though this codebase usually defaults the strict
   * way. What the flag switches on is a REFUSAL, so an adapter that forgot to
   * declare it keeps working exactly as it did before the flag existed; the
   * opposite default would have a new adapter refuse every payout until
   * somebody found this line.
   */
  readonly prefunded?: boolean;

  /**
   * The same question asked of a DESTINATION rather than of an adapter.
   *
   * A single adapter can only answer for itself, so it implements
   * `prefunded` and leaves this out. A SWITCH cannot: the rail is chosen by
   * the destination's currency, so "are we prefunded?" is `true` for Accra
   * and `false` for Lagos in the very same process, and a property could
   * never say that. Two members rather than one because they are two
   * different things — a fact about a rail, and a routing decision.
   */
  prefundedFor?(country: string): Promise<boolean>;

  /**
   * WHAT ONE TRANSFER ON THIS RAIL MAY BE, per currency, in MINOR units —
   * inclusive at both ends. Absent for a currency means the rail states no
   * range and the only limits are the platform's own.
   *
   * A FACT ABOUT THE RAIL, declared by the adapter for `prefunded`'s reason:
   * Bitnob's M-Pesa payout takes KSh 150 to KSh 100,000 per transaction, and
   * outside that the refusal would arrive AFTER the customer's money was held,
   * as a failure reading like a bad number. Known in advance, it is a rail
   * that cannot carry this amount — so another one is tried, or the customer
   * is told before anything moves.
   */
  readonly limits?: Readonly<Partial<Record<string, TransferLimit>>>;

  /**
   * WHICH RAILS COULD SEND TO THIS COUNTRY, in the order they should be
   * tried — the routed one first. A switch answers; a single adapter leaves
   * it out and is its own only rail.
   *
   * IT EXISTS SO THE RAIL IS CHOSEN ONCE, BEFORE THE ROW IS WRITTEN. The row
   * records who sent the payout and that column is immutable (046); a rail
   * chosen again inside `send()` could differ from the one recorded, and then
   * the only rail that can resolve the payout id is not the one anything asks.
   */
  railsFor?(country: string): Promise<readonly string[]>;

  /** A named rail's `limits` for one currency, asked of a switch. */
  limitsVia?(provider: string, currency: string): TransferLimit | undefined;

  /** Sends on the NAMED rail, never on whichever the routing reads now. */
  sendVia?<C extends Currency>(provider: string, request: PayoutRequest<C>): Promise<PayoutReceipt>;

  /**
   * What a named rail says it holds for us, per currency — or undefined where
   * that rail has no balance read this platform can use. Read-only.
   */
  balancesOf?(provider: string): Promise<readonly Money<Currency>[] | undefined>;

  /**
   * Banks — or mobile money networks — a customer may send to in this country.
   *
   * ONE CALL FOR BOTH, because the question is the same one: what may the
   * `bank_code` on a transfer be? A country with two rails answers it twice,
   * and a picker built from the wrong one is 046's fault exactly — a selection
   * the customer's money cannot reach, which fails at the transfer and reads
   * to them as their own number being wrong.
   */
  banks(country: string, method?: PayoutMethod): Promise<readonly PayoutBank[]>;

  /**
   * Branches of one bank, or an empty list where the corridor needs none.
   *
   * EMPTY IS THE COMMON ANSWER and is not a failure. Only Ghana requires a
   * branch code today, so every other rail answers nothing and the screen
   * draws no picker — which keeps "does this need a branch?" a question the
   * adapter answers rather than one two apps hardcode.
   */
  branches?(country: string, bankId: string): Promise<readonly PayoutBranch[]>;

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

  /**
   * What the provider says became of a payout we sent.
   *
   * `provider` NAMES THE RAIL THAT ISSUED THE ID, and it is on this signature
   * because leaving it off was a real reversal waiting to happen. A payout id
   * is opaque and only its issuer can resolve one, so a switching
   * implementation asked without it falls back to whichever rail is
   * CURRENTLY active — and a Ghanaian transfer asked about at Paystack comes
   * back as "no such transfer", which every caller here reads as a definite
   * refusal and reverses. That reverses a payment that may well have arrived,
   * on the one flow where money cannot be recalled, and it happens only after
   * an operator switches rails, which is precisely when nobody is looking for
   * a new failure mode.
   *
   * `bank_payouts.provider` has carried the issuer since 046 for exactly this
   * reason; this is the parameter that lets a caller pass it. A single
   * adapter ignores it — it can only ever be itself.
   */
  status(providerPayoutId: string, provider?: string): Promise<PayoutReceipt>;
}
