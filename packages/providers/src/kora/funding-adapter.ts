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
import { KORA_ENDPOINTS, type KoraClient } from './client.js';
import { koraMinor } from './amounts.js';

const PROVIDER = 'kora';

/**
 * A FIXED VIRTUAL BANK ACCOUNT, ONE PER CUSTOMER, through Kora.
 *
 * FROM "Accepting payments with NGN Virtual Bank Accounts" (developers.korapay.com,
 * read 3 October 2026):
 *
 *   POST /api/v1/virtual-bank-account
 *     account_name, account_reference (ours, unique), permanent: true,
 *     bank_code, customer { name, email }, kyc { bvn, nin? }
 *   GET  /api/v1/virtual-bank-account/:accountReference
 *   GET  /api/v1/virtual-bank-account/transactions?account_number=
 *   GET  /api/v1/charges/:reference          — a payment INTO the account
 *
 * PERMANENT, AND ONLY PERMANENT. "This can only be set to `true` for now",
 * and it is what the product needs anyway: a customer saves this number as a
 * beneficiary and pays into it for years. Kora's pool accounts and its
 * merchant's own reserved account are NOT this — a pool account is shared
 * between customers and the reserved account funds OUR balance, so neither
 * may ever be handed to a customer as theirs.
 *
 * THE BVN IS MANDATORY ON KORA: "kyc ... This is a mandatory requirement
 * starting from the 26th of January, 2024", and `kyc.bvn` is marked required.
 * So on this rail an account number is a VERIFIED customer's product, and the
 * refusal is ours, `kyc_required`, raised before anything is sent. The BVN is
 * unsealed only here and only then — see `FundingCustomer.bvn`.
 *
 * NAIRA ONLY. Kora also documents KES and USD accounts, and both are a
 * different product: a KES account is created PENDING and its number arrives
 * later on an `account_number.creation` webhook, and a USD account goes
 * through account holders and supporting documents. Neither is built here,
 * and an adapter that sent the NGN body for them would be guessing.
 */

const accountData = z.object({
  account_name: z.string().nullish(),
  account_number: z.string().nullish(),
  bank_name: z.string().nullish(),
  account_reference: z.string().nullish(),
  unique_id: z.string().nullish(),
  account_status: z.string().nullish(),
  currency: z.string().nullish(),
});

const accountResponse = z.object({ status: z.literal(true), data: accountData });

const payer = z
  .object({
    account_name: z.string().nullish(),
    account_number: z.string().nullish(),
    bank_name: z.string().nullish(),
  })
  .partial()
  .nullish();

const chargeResponse = z.object({
  status: z.literal(true),
  data: z.object({
    reference: z.string().nullish(),
    status: z.string().min(1),
    amount: z.unknown(),
    amount_paid: z.unknown().optional(),
    currency: z.string().min(1),
    transaction_date: z.string().nullish(),
    payment_method: z.string().nullish(),
    virtual_bank_account: z
      .object({
        account_number: z.string().nullish(),
        account_reference: z.string().nullish(),
        payer_bank_account: payer,
      })
      .partial()
      .nullish(),
  }),
});

const transactionsResponse = z.object({
  status: z.literal(true),
  data: z.object({
    account_number: z.string().nullish(),
    transactions: z.array(
      z.object({
        reference: z.string().min(1),
        status: z.string().min(1),
        amount: z.unknown(),
        currency: z.string().min(1),
        transaction_date: z.string().nullish(),
        payer_bank_account: payer,
      }),
    ),
  }),
});

export interface KoraFundingOptions {
  /**
   * The bank Kora opens the account at — REQUIRED by Kora on every request.
   * The NGN guide's table, as at January 2026: Wema `035`, Fidelity `070`,
   * Globus `103`, UBA `033`, Moniepoint `090405`, Optimus `107`, Parallex
   * `104`, FCMB `214`; and "Use `000` to create a virtual bank account in the
   * sandbox environment". An operator's choice, so it arrives from config.
   */
  readonly bankCode: string;
}

export class KoraFundingAdapter implements FundingPort, DepositVerifier {
  readonly provider = PROVIDER;
  readonly #client: KoraClient;
  readonly #bankCode: string;

  constructor(client: KoraClient, options: KoraFundingOptions) {
    this.#client = client;
    this.#bankCode = options.bankCode;
  }

  async createVirtualAccount(request: CreateVirtualAccountRequest): Promise<VirtualAccount> {
    const { customer, currency } = request;
    if (currency !== 'NGN') {
      throw new ProviderRejectedError(
        PROVIDER,
        `this platform opens Kora virtual accounts in NGN only, not ${currency}`,
        'account_not_supported_here',
      );
    }

    /* No BVN, nothing sent — not even the lookup below: an account can only
     * have been opened for this reference with one. */
    const bvn = customer.bvn === undefined ? undefined : await customer.bvn();
    if (bvn === undefined || bvn === '') {
      throw new ProviderRejectedError(
        PROVIDER,
        'Kora opens a naira virtual account only with the customer’s BVN, and ' +
          'this customer has no approved identity yet.',
        'kyc_required',
      );
    }

    /*
     * LOOK BEFORE CREATING. `account_reference` is ours and unique on their
     * side, so a retry after a timeout must find the account the first
     * attempt opened rather than ask again and be told it is a duplicate —
     * the first number may already be saved in the customer's banking app.
     */
    const existing = await this.#find(request.idempotencyKey);
    if (existing !== undefined) return existing;

    const name = `${customer.firstName} ${customer.lastName}`.trim();
    const body = await this.#client.request('POST', KORA_ENDPOINTS.virtualAccounts, {
      account_name: name,
      /* OURS AND STABLE ACROSS RETRIES — and what every deposit into the
       * account is echoed back under, which is how a deposit finds its
       * customer. */
      account_reference: request.idempotencyKey,
      permanent: true,
      bank_code: this.#bankCode,
      customer: { name, email: customer.email },
      kyc: { bvn },
    });

    const parsed = accountResponse.safeParse(body);
    const data = parsed.success ? parsed.data.data : undefined;
    if (data?.account_number === undefined || data.account_number === null || data.account_number === '') {
      throw new ProviderContractError(
        PROVIDER,
        `unexpected /virtual-bank-account response: ${
          parsed.success ? 'no account number' : parsed.error.message
        }`,
      );
    }
    return this.#toAccount(request.idempotencyKey, data, name);
  }

  async getVirtualAccount(providerAccountId: string): Promise<VirtualAccount> {
    const found = await this.#find(providerAccountId);
    if (found === undefined) {
      throw new ProviderRejectedError(PROVIDER, 'no such virtual account', 'unknown_account');
    }
    return found;
  }

  /**
   * One payment INTO a virtual account, confirmed by Kora itself, by the
   * reference the webhook named — "verify the payment by making a request to
   * our Transaction Query API" (NGN VBA guide).
   */
  async verifyDeposit(providerReference: string): Promise<VerifiedDeposit | undefined> {
    let body: unknown;
    try {
      body = await this.#client.request('GET', KORA_ENDPOINTS.charge(providerReference));
    } catch (error) {
      if (error instanceof ProviderRejectedError && /charge not found/i.test(error.message)) {
        return undefined;
      }
      throw error;
    }
    const parsed = chargeResponse.safeParse(body);
    if (!parsed.success) {
      throw new ProviderContractError(
        PROVIDER,
        `unexpected /charges/:reference response: ${parsed.error.message}`,
      );
    }
    const row = parsed.data.data;
    /* The answer must be about the money we asked about, or it is about some
     * other money. */
    if (
      row.reference !== undefined &&
      row.reference !== null &&
      row.reference.toLowerCase() !== providerReference.toLowerCase()
    ) {
      throw new ProviderContractError(
        PROVIDER,
        `asked about charge ${providerReference} and was answered about ${row.reference}`,
      );
    }
    if (row.status.trim().toLowerCase() !== 'success') return undefined;
    if (!isCurrency(row.currency)) {
      throw new ProviderContractError(PROVIDER, `not a currency this platform knows: ${row.currency}`);
    }
    const vba = row.virtual_bank_account ?? undefined;
    return {
      /* KORA'S reference, and the ledger key is built from it — `kora:<ref>`
       * on the webhook path and on the sweep alike, so whichever arrives
       * second is a replay and not a second credit. */
      providerReference,
      amountMinor: koraMinor(
        row.amount_paid !== undefined && row.amount_paid !== 0 ? row.amount_paid : row.amount,
        row.currency,
      ),
      currency: row.currency,
      senderName: vba?.payer_bank_account?.account_name ?? undefined,
      senderBank: vba?.payer_bank_account?.bank_name ?? undefined,
      senderAccount: vba?.payer_bank_account?.account_number ?? undefined,
      occurredAt: dateOf(row.transaction_date),
      accountReference: vba?.account_reference ?? undefined,
      channel: row.payment_method ?? 'bank_transfer',
    };
  }

  /**
   * WHAT LANDED IN ONE ACCOUNT THAT NO WEBHOOK TOLD US ABOUT.
   *
   * Kora lists an account's payments by its NUMBER, and the sweep holds our
   * reference — so the account is read first and its number asked about.
   * Only `success` rows are money.
   */
  async listDeposits(account: DepositLookup): Promise<readonly ProviderDeposit[]> {
    const reference = account.providerCustomerRef ?? account.providerAccountId;
    const found = await this.#find(reference);
    if (found === undefined) return [];

    const body = await this.#client.request(
      'GET',
      KORA_ENDPOINTS.virtualAccountTransactions(found.accountNumber),
    );
    const parsed = transactionsResponse.safeParse(body);
    if (!parsed.success) {
      throw new ProviderContractError(
        PROVIDER,
        `virtual account transactions do not match the expected shape: ${parsed.error.message}`,
      );
    }
    /* A filter re-applied on our side: an answer about a different account
     * would credit somebody else's money to this one. */
    const answered = parsed.data.data.account_number;
    if (answered !== undefined && answered !== null && answered !== found.accountNumber) {
      throw new ProviderContractError(
        PROVIDER,
        `asked about account ${found.accountNumber} and was answered about ${answered}`,
      );
    }
    const deposits: ProviderDeposit[] = [];
    for (const row of parsed.data.data.transactions) {
      if (row.status.trim().toLowerCase() !== 'success') continue;
      if (!isCurrency(row.currency)) {
        throw new ProviderContractError(PROVIDER, `not a currency this platform knows: ${row.currency}`);
      }
      deposits.push({
        providerReference: row.reference,
        amountMinor: koraMinor(row.amount, row.currency),
        currency: row.currency,
        senderName: row.payer_bank_account?.account_name ?? undefined,
        senderBank: row.payer_bank_account?.bank_name ?? undefined,
        senderAccount: row.payer_bank_account?.account_number ?? undefined,
        occurredAt: dateOf(row.transaction_date),
      });
    }
    return deposits;
  }

  /** The account opened under OUR reference, or undefined if Kora has none. */
  async #find(accountReference: string): Promise<VirtualAccount | undefined> {
    let body: unknown;
    try {
      body = await this.#client.request('GET', KORA_ENDPOINTS.virtualAccount(accountReference));
    } catch (error) {
      /* Only Kora's plain "no such account" is an answer here; a key that
       * does not authorise, or anything else, is not "none exists" and must
       * not lead to opening a second one. */
      if (
        error instanceof ProviderRejectedError &&
        (error.providerCode === 'http_404' || /not found|does not exist/i.test(error.message))
      ) {
        return undefined;
      }
      throw error;
    }
    const parsed = accountResponse.safeParse(body);
    const data = parsed.success ? parsed.data.data : undefined;
    if (data?.account_number === undefined || data.account_number === null || data.account_number === '') {
      return undefined;
    }
    return this.#toAccount(accountReference, data, data.account_name ?? '');
  }

  #toAccount(
    accountReference: string,
    data: z.infer<typeof accountData>,
    fallbackName: string,
  ): VirtualAccount {
    const currency = data.currency ?? 'NGN';
    if (!isCurrency(currency)) {
      throw new ProviderContractError(PROVIDER, `not a currency this platform knows: ${currency}`);
    }
    return {
      provider: PROVIDER,
      /* OUR reference is what Kora's query takes, so it is the account's id
       * here as well as the reference deposits are echoed back under. */
      providerAccountId: accountReference,
      providerCustomerRef: accountReference,
      accountNumber: data.account_number ?? '',
      bankName: data.bank_name ?? 'Kora',
      accountName: data.account_name ?? fallbackName,
      currency,
      active: (data.account_status ?? 'active').toLowerCase() === 'active',
    };
  }
}

function dateOf(text: string | null | undefined): Date {
  const parsed = text === undefined || text === null ? Number.NaN : Date.parse(text);
  return Number.isNaN(parsed) ? new Date() : new Date(parsed);
}
