import { z } from 'zod';
import { isCurrency } from '@xetral/shared';
import { ProviderContractError, ProviderRejectedError } from '../ports/errors.js';
import type {
  CreateVirtualAccountRequest,
  DepositLookup,
  DepositVerifier,
  FundingPort,
  ProviderDeposit,
  VerifiedDeposit,
  VirtualAccount,
} from '../ports/funding.js';
import { FLUTTERWAVE_ENDPOINTS, type FlutterwaveClient } from './client.js';
import { minorFromMajor } from './checkout-adapter.js';

const PROVIDER = 'flutterwave';

/**
 * A DEDICATED ACCOUNT NUMBER, through Flutterwave.
 *
 * WHY THIS EXISTS. `provider_routes` sends cedi and shilling COLLECTION here,
 * and until now nothing implemented `FundingPort` for this rail — so a
 * customer in Accra tapping "Activate account" reached a switch that had no
 * adapter to hand the request to. Before routing, the same tap went to
 * Paystack, whose Nigerian registration cannot open an account that settles
 * in cedis. Both produced "Payments are unavailable right now".
 *
 * ────────────────────────────────────────────────────────────────────────
 *  READ THIS BEFORE TRUSTING IT.
 *
 *  `POST /v3/virtual-account-numbers` is Flutterwave's published v3 endpoint
 *  and this file is written from that documentation, September 2026 — a
 *  source and a DATE, the rule this package records twice about Bitnob.
 *
 *  WHAT IS NOT ESTABLISHED IS WHETHER IT ISSUES OUTSIDE NIGERIA. Flutterwave
 *  documents virtual accounts most fully for NGN; in Ghana and Kenya money
 *  ordinarily arrives by a mobile money CHARGE rather than into a static
 *  number, which is exactly what `countries.funding_methods` already records —
 *  `{mobile_money}` for GH and KE, `{virtual_account}` for NG.
 *
 *  So this adapter may be asking for a product an account is not enabled for.
 *  When that happens Flutterwave refuses with its own sentence, and this
 *  RELAYS that sentence to the log while the customer gets a code their app
 *  turns into words — which is the honest failure, and far better than the
 *  silent one it replaces. `scripts/verify-flutterwave-sandbox.mjs` probes it
 *  against a test key; run that before relying on this in Accra or Nairobi.
 * ────────────────────────────────────────────────────────────────────────
 *
 * THE NAIRA ACCOUNT, and the one thing it needs that Paystack's does not.
 *
 * Flutterwave's own documentation is explicit that a PERMANENT account in the
 * live environment needs the customer's BVN, and their published Node SDK's
 * example request carries one. So on this rail an account number is a
 * VERIFIED customer's product, the same as on Bitnob — the refusal is ours,
 * `kyc_required`, raised before anything is sent, because an account request
 * without a BVN is refused by them in a sentence that reads like an outage.
 * The BVN is unsealed only here and only then; see `FundingCustomer.bvn`.
 *
 * AND MONEY INTO IT ARRIVES AS A CHARGE, on the same webhook as a checkout.
 * `verifyDeposit` is how a deposit is confirmed — by THEIR transaction id,
 * because a permanent account is one `tx_ref` that every payment into it
 * shares, and a lookup by reference answers only one of them.
 */
const accountResponse = z.object({
  status: z.string().optional(),
  message: z.string().optional(),
  data: z
    .object({
      /** Theirs, and what `getVirtualAccount` is later asked about. */
      order_ref: z.string().optional(),
      flw_ref: z.string().optional(),
      account_number: z.string().min(1),
      bank_name: z.string().optional(),
      /** Present on a permanent account; absent on a one-off charge number. */
      note: z.string().nullish(),
    })
    .optional(),
});

/** One transaction as their v3 API describes it — verify and list alike. */
const transaction = z.object({
  id: z.union([z.number(), z.string()]),
  tx_ref: z.string().nullish(),
  /** Left `unknown` and narrowed by `minorFromMajor`, from its TEXT. */
  amount: z.unknown(),
  currency: z.string().min(1),
  status: z.string().min(1),
  payment_type: z.string().nullish(),
  created_at: z.string().nullish(),
  meta: z
    .object({
      originatorname: z.string().nullish(),
      bankname: z.string().nullish(),
      originatoraccountnumber: z.string().nullish(),
    })
    .partial()
    .nullish(),
});

const verifyResponse = z.object({
  status: z.string().optional(),
  message: z.string().optional(),
  data: transaction.optional(),
});

const listResponse = z.object({
  status: z.string().optional(),
  message: z.string().optional(),
  data: z.array(transaction),
});

type Transaction = z.infer<typeof transaction>;

export class FlutterwaveFundingAdapter implements FundingPort, DepositVerifier {
  readonly provider = PROVIDER;
  readonly #client: FlutterwaveClient;

  constructor(client: FlutterwaveClient) {
    this.#client = client;
  }

  async createVirtualAccount(request: CreateVirtualAccountRequest): Promise<VirtualAccount> {
    const { customer, currency } = request;

    /*
     * A PERMANENT NAIRA ACCOUNT NEEDS A BVN, AND WE SAY SO BEFORE ASKING.
     *
     * Their live environment refuses `is_permanent: true` without one, in a
     * sentence that would reach the log as an outage on the screen a customer
     * opens to put money in. `kyc_required` is a code both apps already turn
     * into "verify your identity to get an account number" — a next step
     * rather than a shrug. Only naira: the rest of this method still ASKS
     * rather than deciding, for the reason the comment below records.
     */
    let bvn: string | undefined;
    if (currency === 'NGN') {
      bvn = customer.bvn === undefined ? undefined : await customer.bvn();
      if (bvn === undefined || bvn === '') {
        throw new ProviderRejectedError(
          PROVIDER,
          'Flutterwave opens a permanent naira account only with the customer’s ' +
            'BVN, and this customer has no approved identity yet.',
          'kyc_required',
        );
      }
    }

    /*
     * IT ASKS. IT DOES NOT DECIDE.
     *
     * This used to refuse every non-NGN currency here, in our own code,
     * WITHOUT CALLING ANYTHING — on the reasoning that `/v3/virtual-account-
     * numbers` is a Nigerian NUBAN product and `countries.funding_methods`
     * already said so.
     *
     * THAT IS THE EXACT SHAPE OF THE FAULT THAT COST FIVE ROUNDS ON THE MOBILE
     * MONEY NAME. `RESOLVES_MOBILE_MONEY` was a flat assertion too, its test
     * agreed with it because the same person wrote both, and the refusal a
     * customer read had been invented here rather than said by Flutterwave.
     * A belief about a provider, enforced before the call, is unfalsifiable:
     * nothing in any log, table or screen can ever contradict it.
     *
     * SO THE REQUEST GOES OUT AND THEIR ANSWER IS RELAYED. If they do not
     * issue in this currency they say so, in their own words, and
     * `account_issue_refused` carries it to an operator — 006's rule, and a
     * sentence somebody can act on rather than one we made up.
     *
     * THE CURRENCY IS STILL STATED, never defaulted. 061's fault was asking
     * for naira on behalf of every customer on the platform; the fix was to
     * ask in the customer's own currency, and that is what reaches the wire
     * here.
     */
    const body = await this.#client.request('POST', FLUTTERWAVE_ENDPOINTS.virtualAccounts, {
      email: customer.email,
      /* OURS AND STABLE ACROSS RETRIES. Without it a timeout followed by a
       * retry issues a SECOND number to one customer — and the first is
       * already saved in somebody's banking app, still receiving money that
       * nothing is watching. It is also what every payment into the account
       * is echoed back under, which is how a deposit finds its customer. */
      tx_ref: request.idempotencyKey,
      /* A PERMANENT number rather than one that expires with a single
       * charge: a customer saves this as a beneficiary and pays into it for
       * years, which is the whole product. */
      is_permanent: true,
      currency,
      ...(bvn === undefined ? {} : { bvn }),
      ...(customer.phone === undefined ? {} : { phonenumber: customer.phone }),
      firstname: customer.firstName,
      lastname: customer.lastName,
      narration: `${customer.firstName} ${customer.lastName}`.trim(),
    });

    const parsed = accountResponse.safeParse(body);
    if (!parsed.success || parsed.data.data === undefined) {
      /*
       * A CONTRACT BREAK, not an outage — and on this rail the likeliest
       * cause is that the account is not enabled for virtual numbers in this
       * currency. Waiting does not fix either, and a retry loop would hide
       * the one thing an operator can act on.
       */
      throw new ProviderContractError(
        PROVIDER,
        `unexpected /v3/virtual-account-numbers response for ${currency}: ` +
          `${parsed.success ? (parsed.data.message ?? 'no data') : parsed.error.message}`,
      );
    }

    const data = parsed.data.data;
    return {
      provider: PROVIDER,
      providerAccountId: data.order_ref ?? data.flw_ref ?? data.account_number,
      /*
       * OUR `tx_ref`, NOT THE EMAIL ADDRESS. It used to be the email, on the
       * reasoning that their transaction list is a customer-level query — but
       * every payment into a permanent account is echoed back under the
       * reference the account was opened with, and an email address is shared
       * with every checkout the same person ever paid. The reference names
       * this account and nothing else.
       */
      providerCustomerRef: request.idempotencyKey,
      accountNumber: data.account_number,
      bankName: data.bank_name ?? 'Flutterwave',
      accountName: `${customer.firstName} ${customer.lastName}`.trim(),
      currency,
      active: true,
    };
  }

  async getVirtualAccount(providerAccountId: string): Promise<VirtualAccount> {
    const body = await this.#client.request(
      'GET',
      FLUTTERWAVE_ENDPOINTS.virtualAccount(providerAccountId),
    );
    const parsed = accountResponse.safeParse(body);
    if (!parsed.success || parsed.data.data === undefined) {
      throw new ProviderRejectedError(
        PROVIDER,
        parsed.success ? (parsed.data.message ?? 'no such account') : parsed.error.message,
        'unknown_account',
      );
    }
    const data = parsed.data.data;
    return {
      provider: PROVIDER,
      providerAccountId,
      providerCustomerRef: undefined,
      accountNumber: data.account_number,
      bankName: data.bank_name ?? 'Flutterwave',
      accountName: '',
      currency: 'NGN',
      active: true,
    };
  }

  /**
   * One deposit, confirmed by Flutterwave itself.
   *
   * ASKED BY THEIR ID, because that is what differs between two payments into
   * one account; and the id they answer about must be the id we asked about,
   * or the answer is about some other money.
   */
  async verifyDeposit(providerReference: string): Promise<VerifiedDeposit | undefined> {
    const body = await this.#client.request(
      'GET',
      FLUTTERWAVE_ENDPOINTS.verifyTransaction(providerReference),
    );
    const parsed = verifyResponse.safeParse(body);
    if (!parsed.success || parsed.data.data === undefined) return undefined;

    const row = parsed.data.data;
    if (String(row.id) !== providerReference) {
      throw new ProviderContractError(
        PROVIDER,
        `asked to verify transaction ${providerReference} and was answered about ${String(row.id)}`,
      );
    }
    /* `successful`, NOT `success` — see the checkout adapter. Anything else is
     * not money that arrived, and a deposit is credited on nothing less. */
    if (row.status !== 'successful') return undefined;
    return toDeposit(row);
  }

  /**
   * WHAT LANDED IN ONE ACCOUNT THAT NO WEBHOOK TOLD US ABOUT.
   *
   * Listed by the account's own `tx_ref`, and then FILTERED BY IT AGAIN, row by
   * row. A server that ignored the query parameter would answer with every
   * transaction on the integration — every checkout, every other customer's
   * deposit — and each would be credited to whichever account was being swept.
   * A filter re-applied on our side costs nothing; trusting theirs costs
   * everybody's money at once.
   */
  async listDeposits(account: DepositLookup): Promise<readonly ProviderDeposit[]> {
    const reference = account.providerCustomerRef;
    // An account opened before this adapter recorded its reference has
    // nothing to be asked about, and saying so is the true answer.
    if (reference === undefined || reference === '' || reference.includes('@')) return [];

    const body = await this.#client.request(
      'GET',
      FLUTTERWAVE_ENDPOINTS.transactionsByReference(reference),
    );
    const parsed = listResponse.safeParse(body);
    if (!parsed.success) {
      throw new ProviderContractError(
        PROVIDER,
        `transaction list does not match the expected shape: ${parsed.error.message}`,
        parsed.error,
      );
    }
    return parsed.data.data
      .filter((row) => row.tx_ref === reference && row.status === 'successful')
      .map(toDeposit);
  }
}

function toDeposit(row: Transaction): VerifiedDeposit {
  if (!isCurrency(row.currency)) {
    throw new ProviderContractError(PROVIDER, `not a currency this platform knows: ${row.currency}`);
  }
  return {
    /*
     * THEIR TRANSACTION ID, and it is what the ledger key is built from —
     * `flutterwave:<id>` on the webhook path and on the sweep alike, so a late
     * webhook after a sweep is a replay and not a second credit. 013's
     * finding 4 cost a double credit by keying the two paths differently.
     */
    providerReference: String(row.id),
    amountMinor: minorFromMajor(row.amount, row.currency),
    currency: row.currency,
    senderName: row.meta?.originatorname ?? undefined,
    senderBank: row.meta?.bankname ?? undefined,
    senderAccount: row.meta?.originatoraccountnumber ?? undefined,
    occurredAt: new Date(row.created_at ?? Date.now()),
    accountReference: row.tx_ref ?? undefined,
    channel: row.payment_type ?? undefined,
  };
}
