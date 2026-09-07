import { z } from 'zod';
import { ProviderContractError, ProviderRejectedError } from '../ports/errors.js';
import type {
  CreateVirtualAccountRequest,
  FundingPort,
  ProviderDeposit,
  VirtualAccount,
} from '../ports/funding.js';
import { type FlutterwaveClient } from './client.js';

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

export class FlutterwaveFundingAdapter implements FundingPort {
  readonly provider = PROVIDER;
  readonly #client: FlutterwaveClient;

  constructor(client: FlutterwaveClient) {
    this.#client = client;
  }

  async createVirtualAccount(request: CreateVirtualAccountRequest): Promise<VirtualAccount> {
    const { customer, currency } = request;

    const body = await this.#client.request('POST', '/v3/virtual-account-numbers', {
      email: customer.email,
      /* OURS AND STABLE ACROSS RETRIES. Without it a timeout followed by a
       * retry issues a SECOND number to one customer — and the first is
       * already saved in somebody's banking app, still receiving money that
       * nothing is watching. */
      tx_ref: request.idempotencyKey,
      /* A PERMANENT number rather than one that expires with a single
       * charge: a customer saves this as a beneficiary and pays into it for
       * years, which is the whole product. */
      is_permanent: true,
      currency,
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
      // Their transaction list is queried by customer, not by account, so the
      // reconciliation sweep needs something to key on — the same reason
      // `provider_customer_ref` exists for Paystack.
      providerCustomerRef: customer.email,
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
      `/v3/virtual-account-numbers/${encodeURIComponent(providerAccountId)}`,
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
   * WHAT LANDED THAT NO WEBHOOK TOLD US ABOUT.
   *
   * DELIBERATELY EMPTY, and that is a claim rather than a gap: every credit
   * on this rail is verified against Flutterwave by OUR OWN reference before
   * a posting exists — `PaymentLinkService.settle` — so there is no second
   * source of deposits for a sweep to find. Returning nothing is the true
   * answer; inventing a query whose shape has not been confirmed would put
   * unverified constants on the one path that creates money.
   */
  async listDeposits(): Promise<readonly ProviderDeposit[]> {
    return [];
  }
}
