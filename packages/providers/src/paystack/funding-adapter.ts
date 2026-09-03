import { z } from 'zod';
import { ProviderContractError, ProviderRejectedError } from '../ports/errors.js';
import { PAYSTACK_ENDPOINTS, type PaystackClient } from './client.js';
import type {
  CreateVirtualAccountRequest,
  FundingPort,
  ProviderDeposit,
  VirtualAccount,
} from '../ports/funding.js';
import { depositToKobo } from '../bitnob/ngn-amounts.js';

const PROVIDER = 'paystack';

/**
 * Paystack dedicated virtual accounts.
 *
 * THE REASON THIS EXISTS is that Bitnob will not open a naira account for
 * anybody it has not already verified a BVN for, and that is the wrong gate
 * on the screen a customer opens in order to put money in. CBN's tiered KYC
 * permits a tier 1 account on a name and a phone number, capped — and
 * `029_kyc_tiers.seed.sql` has capped tier 0 at ₦50,000 a day since it
 * landed. So the policy the platform already enforces and the account it
 * could actually issue had drifted apart, and this closes that.
 *
 * ISSUING IS TWO CALLS, and only the first is about identity:
 *
 *   POST /customer            name, email, phone -> customer_code
 *   POST /dedicated_account   customer_code      -> a NUBAN
 *
 * Neither is a KYC step. `POST /customer/:code/identification` is where a BVN
 * goes when one is needed, which is at the point a customer wants past a tier
 * 1 ceiling rather than at the point they want somewhere to be paid.
 */

/**
 * Paystack's response envelope. Every body carries `status` and `message`
 * alongside `data`, and a refusal arrives as a 200 with `status: false` —
 * handled in the client, so anything reaching here has real `data`.
 */
const customerResponse = z.object({
  data: z.object({
    customer_code: z.string().min(1),
    id: z.union([z.string(), z.number()]).optional(),
  }),
});

const dedicatedAccountResponse = z.object({
  data: z.object({
    id: z.union([z.string(), z.number()]),
    account_number: z.string().min(1),
    account_name: z.string().min(1),
    bank: z.object({ name: z.string().min(1) }),
    active: z.boolean().optional(),
    currency: z.string().optional(),
  }),
});

const dedicatedAccountListResponse = z.object({
  data: z.array(
    z.object({
      id: z.union([z.string(), z.number()]),
      account_number: z.string().min(1),
      account_name: z.string().min(1),
      bank: z.object({ name: z.string().min(1) }),
      active: z.boolean().optional(),
    }),
  ),
});

const transactionListResponse = z.object({
  data: z.array(
    z.object({
      id: z.union([z.string(), z.number()]),
      reference: z.string().min(1),
      /** Left `unknown` and narrowed by `depositToKobo`. A `z.number()` here
       *  would accept a value JSON.parse has already rounded and hand it on
       *  looking valid — and this one becomes a customer's balance. */
      amount: z.unknown(),
      currency: z.string().optional(),
      status: z.string().optional(),
      paid_at: z.string().nullish(),
      created_at: z.string().nullish(),
      authorization: z
        .object({
          sender_bank: z.string().nullish(),
          account_name: z.string().nullish(),
          sender_bank_account_number: z.string().nullish(),
        })
        .nullish(),
    }),
  ),
});

export interface PaystackFundingOptions {
  readonly client: PaystackClient;
  /**
   * Which bank Paystack should issue the NUBAN at.
   *
   * A DEPLOYMENT VALUE, not a constant, because the answer differs by account:
   * Paystack's test integrations issue Titan accounts and live ones are
   * usually Wema, and a business can be enabled for one and not the other.
   * Hardcoding either would make a correct configuration fail with a message
   * about a bank nobody chose.
   */
  readonly preferredBank: string | undefined;
}

export class PaystackFundingAdapter implements FundingPort {
  readonly provider = PROVIDER;

  readonly #client: PaystackClient;
  readonly #preferredBank: string | undefined;

  constructor(options: PaystackFundingOptions) {
    this.#client = options.client;
    this.#preferredBank = options.preferredBank;
  }

  async createVirtualAccount(request: CreateVirtualAccountRequest): Promise<VirtualAccount> {
    if (request.currency !== 'NGN') {
      // The rail is Nigerian. Failing here beats issuing a naira account and
      // labelling it something else.
      throw new ProviderContractError(
        PROVIDER,
        `dedicated accounts on this rail are NGN; got ${request.currency}`,
      );
    }

    const customerCode = await this.#customerCode(request);

    /*
     * ALREADY ISSUED? ASK BEFORE CREATING.
     *
     * Our own unique index on (user, currency) is what actually guarantees one
     * account per customer, and it holds whatever happens here. This is the
     * other half: a retry after a timeout must not leave a SECOND account
     * number live at Paystack, receiving money against a row we never wrote
     * and nobody is watching. `POST /dedicated_account` has no idempotency
     * key, so the only way to be safe is to look.
     */
    const existing = await this.#existingAccount(customerCode);
    if (existing !== undefined) return existing;

    const payload = await this.#client.request(
      'POST',
      PAYSTACK_ENDPOINTS.createDedicatedAccount,
      {
        customer: customerCode,
        ...(this.#preferredBank === undefined ? {} : { preferred_bank: this.#preferredBank }),
      },
    );

    return this.#toAccount(payload, customerCode);
  }

  async getVirtualAccount(providerAccountId: string): Promise<VirtualAccount> {
    return this.#toAccount(
      await this.#client.request(
        'GET',
        PAYSTACK_ENDPOINTS.getDedicatedAccount(providerAccountId),
      ),
    );
  }

  /**
   * What Paystack recorded that no webhook told us about.
   *
   * Keyed on the CUSTOMER rather than the account, because Paystack's
   * transaction list is a customer-level query — and the account id we hold is
   * not accepted there. `providerAccountId` is therefore the customer code for
   * this adapter, which is stated here rather than assumed at the call site.
   */
  async listDeposits(providerAccountId: string): Promise<readonly ProviderDeposit[]> {
    const payload = await this.#client.request(
      'GET',
      PAYSTACK_ENDPOINTS.transactions(providerAccountId),
    );

    const parsed = transactionListResponse.safeParse(payload);
    if (!parsed.success) {
      throw new ProviderContractError(
        PROVIDER,
        `transaction list does not match the expected shape: ${issues(parsed.error)}`,
        parsed.error,
      );
    }

    return parsed.data.data.map((row) => ({
      // THEIR reference, which is also what the webhook carries — so a late
      // delivery and this sweep produce the SAME ledger idempotency key and
      // the second one is a replay rather than a second credit. 013's
      // finding 4, which cost a double credit before it was understood.
      providerReference: row.reference,
      // Paystack is kobo throughout. Narrowed rather than trusted as a number.
      amountMinor: depositToKobo(row.amount, 'kobo'),
      currency: 'NGN' as const,
      senderName: row.authorization?.account_name ?? undefined,
      senderBank: row.authorization?.sender_bank ?? undefined,
      senderAccount: row.authorization?.sender_bank_account_number ?? undefined,
      occurredAt: new Date(row.paid_at ?? row.created_at ?? Date.now()),
    }));
  }

  /* ------------------------------------------------------------------ */

  /**
   * The customer at Paystack, created from what signup already holds.
   *
   * `providerCustomerId` is used when the platform already has one — a
   * customer who has been through this before, or whose mapping KYC wrote.
   * Otherwise a customer record is created, and that is NOT a regulatory step:
   * it is a name and an email address, and Paystack asks for nothing more.
   */
  async #customerCode(request: CreateVirtualAccountRequest): Promise<string> {
    const known = request.customer.providerCustomerId;
    if (known !== undefined && known !== '') return known;

    const payload = await this.#client.request('POST', PAYSTACK_ENDPOINTS.createCustomer, {
      email: request.customer.email,
      first_name: request.customer.firstName,
      last_name: request.customer.lastName,
      ...(request.customer.phone === undefined ? {} : { phone: request.customer.phone }),
      // Ours, so a Paystack dashboard row can be traced back without a lookup.
      metadata: { xetral_reference: request.customer.reference },
    });

    const parsed = customerResponse.safeParse(payload);
    if (!parsed.success) {
      throw new ProviderContractError(
        PROVIDER,
        `customer response does not match the expected shape: ${issues(parsed.error)}`,
        parsed.error,
      );
    }
    return parsed.data.data.customer_code;
  }

  async #existingAccount(customerCode: string): Promise<VirtualAccount | undefined> {
    let payload: unknown;
    try {
      payload = await this.#client.request(
        'GET',
        PAYSTACK_ENDPOINTS.listDedicatedAccounts(customerCode),
      );
    } catch (error) {
      // A customer with no accounts can answer as a refusal rather than an
      // empty list. Not being able to look is not the same as there being
      // nothing to find, but the safe reading here is "carry on and create":
      // our own unique index still refuses a second row, and refusing to
      // issue because a LOOKUP failed would leave a customer with no way to
      // be paid over a query.
      if (error instanceof ProviderRejectedError) return undefined;
      throw error;
    }

    const parsed = dedicatedAccountListResponse.safeParse(payload);
    if (!parsed.success) return undefined;

    const live = parsed.data.data.find((row) => row.active !== false);
    if (live === undefined) return undefined;

    return {
      provider: PROVIDER,
      providerAccountId: String(live.id),
      providerCustomerRef: customerCode,
      accountNumber: live.account_number,
      bankName: live.bank.name,
      accountName: live.account_name,
      currency: 'NGN',
      active: live.active ?? true,
    };
  }

  #toAccount(payload: unknown, customerCode?: string): VirtualAccount {
    const parsed = dedicatedAccountResponse.safeParse(payload);
    if (!parsed.success) {
      throw new ProviderContractError(
        PROVIDER,
        `dedicated account does not match the expected shape: ${issues(parsed.error)}`,
        parsed.error,
      );
    }
    const account = parsed.data.data;
    return {
      provider: PROVIDER,
      providerAccountId: String(account.id),
      // Paystack keys its transaction list on the CUSTOMER, so the sweep that
      // finds a webhook which never arrived needs this and cannot run from
      // the account id. Absent on a re-read, where the caller already has it.
      providerCustomerRef: customerCode,
      accountNumber: account.account_number,
      bankName: account.bank.name,
      accountName: account.account_name,
      currency: 'NGN',
      // Absent means active: an account Paystack has just created and not
      // described is live, and reading silence as inactive would show a
      // customer a number their app tells them not to use.
      active: account.active ?? true,
    };
  }
}

function issues(error: z.ZodError): string {
  return error.issues.map((i) => i.path.join('.')).join(', ');
}
