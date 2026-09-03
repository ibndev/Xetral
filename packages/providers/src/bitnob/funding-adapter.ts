import { z } from 'zod';
import type { Currency } from '@xetral/shared';
import { ProviderContractError, ProviderRejectedError } from '../ports/errors.js';
import { BITNOB_ENDPOINTS, type BitnobClient } from './client.js';
import type {
  CreateVirtualAccountRequest,
  FundingPort,
  ProviderDeposit,
  VirtualAccount,
} from '../ports/funding.js';
import { depositToKobo } from './ngn-amounts.js';
import type { NgnAmountUnit } from './ngn-amounts.js';

const PROVIDER = 'bitnob';

/**
 * Bitnob dedicated Nigerian virtual accounts.
 *
 * THE PREVIOUS PATHS WERE A GUESS AND THEY WERE WRONG. This table used to say
 * so in its own header — "the virtual-account routes themselves could not be
 * verified from this repository" — and shipped anyway, following the naming
 * conventions of the card endpoints. `/addresses/generate-naira-account` does
 * not exist. It is `/api/virtual-accounts`, a resource of its own, verified
 * against `bitnob/stealthdocs` (`docs/virtual-accounts/overview.mdx`,
 * `docs.json`).
 *
 * The honest header was worth something and was not worth much: it named the
 * risk and left the guess in the money path, where "confirm before go-live"
 * competes with everything else on a go-live day.
 *
 * The blast radius was at least kept small, and that part held. Every path is
 * in this one table, the response shape is validated by a schema rather than
 * read field-by-field at call sites, and a wrong path fails loudly on the
 * first call rather than silently returning something plausible.
 */
export const BITNOB_FUNDING_ENDPOINTS = {
  createVirtualAccount: BITNOB_ENDPOINTS.createVirtualAccount,
  getVirtualAccount: BITNOB_ENDPOINTS.getVirtualAccount,
  listDeposits: BITNOB_ENDPOINTS.virtualAccountTransactions,
} as const;

/**
 * Bitnob's payloads are snake_case on the way out and camelCase on the way in
 * — verified against their Node SDK in Phase 3 and unchanged here. Getting
 * that backwards produces `undefined` amounts, and `undefined` in a money path
 * is how a posting of zero gets written.
 */
const virtualAccountResponse = z.object({
  data: z.object({
    id: z.string().min(1),
    account_number: z.string().min(1),
    bank_name: z.string().min(1),
    account_name: z.string().min(1),
    currency: z.string().min(1).optional(),
    // Some providers report activation asynchronously; absent means active.
    status: z.string().optional(),
  }),
});

const depositListResponse = z.object({
  data: z.array(
    z.object({
      id: z.string().min(1),
      /** Left `unknown` and narrowed by `depositToKobo`, exactly as card
       *  amounts are left to `parseMicro`. A `z.number()` here would accept a
       *  value JSON.parse has already rounded and hand it over looking valid. */
      amount: z.unknown(),
      currency: z.string().min(1).optional(),
      sender_name: z.string().optional(),
      sender_bank: z.string().optional(),
      sender_account_number: z.string().optional(),
      created_at: z.string().optional(),
    }),
  ),
});

export interface BitnobFundingOptions {
  readonly client: BitnobClient;
  /** How Bitnob expresses an NGN amount. See ngn-amounts.ts — this is a stated
   *  deployment value, guarded by a ceiling, rather than a guess in code. */
  readonly amountUnit: NgnAmountUnit;
}

export class BitnobFundingAdapter implements FundingPort {
  readonly provider = PROVIDER;

  readonly #client: BitnobClient;
  readonly #amountUnit: NgnAmountUnit;

  constructor(options: BitnobFundingOptions) {
    this.#client = options.client;
    this.#amountUnit = options.amountUnit;
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

    /*
     * BITNOB'S PREREQUISITE, STATED HERE RATHER THAN IN THE PORT.
     *
     * Their virtual-account endpoint requires a customer already carrying a
     * BVN — their docs are explicit that the BVN lives on the customer and
     * that the name and date of birth must match the national registry. So
     * this adapter genuinely cannot issue an account to somebody unverified.
     *
     * That is a fact about BITNOB, not about the rail: the same account under
     * CBN tier 1 needs a name and a phone number. Keeping the requirement in
     * the adapter is what lets a second provider have a different one, which
     * is the whole point of the port.
     */
    const providerCustomerId = request.customer.providerCustomerId;
    if (providerCustomerId === undefined || providerCustomerId === '') {
      throw new ProviderRejectedError(
        PROVIDER,
        'Bitnob issues a naira account only to a customer it already holds a ' +
          'verified BVN for. Complete identity verification first, or use a ' +
          'funding provider that opens a tier 1 account.',
        'kyc_required',
      );
    }

    const payload = await this.#client.request(
      'POST',
      BITNOB_FUNDING_ENDPOINTS.createVirtualAccount,
      {
        /*
         * snake_case, and the currency is REQUIRED.
         *
         * NGN is the only currency this endpoint supports today, and naming
         * it is not redundant: their docs say so as a statement about today,
         * and a request that omits it is relying on that staying true.
         */
        customer_id: providerCustomerId,
        currency: request.currency,
        // Their side de-duplicates on this, ours on the virtual_accounts
        // unique constraint. A retry needs both: without theirs we get a
        // second account number, and the first is already in the customer's
        // app receiving money nobody is watching.
        reference: request.idempotencyKey,
      },
    );

    return this.#toAccount(payload);
  }

  async getVirtualAccount(providerAccountId: string): Promise<VirtualAccount> {
    const payload = await this.#client.request(
      'GET',
      BITNOB_FUNDING_ENDPOINTS.getVirtualAccount(providerAccountId),
    );
    return this.#toAccount(payload);
  }

  async listDeposits(providerAccountId: string): Promise<readonly ProviderDeposit[]> {
    const payload = await this.#client.request(
      'GET',
      BITNOB_FUNDING_ENDPOINTS.listDeposits(providerAccountId),
    );

    const parsed = depositListResponse.safeParse(payload);
    if (!parsed.success) {
      throw new ProviderContractError(
        PROVIDER,
        `deposit list does not match the expected shape: ${parsed.error.issues
          .map((i) => i.path.join('.'))
          .join(', ')}`,
        parsed.error,
      );
    }

    return parsed.data.data.map((row) => ({
      providerReference: row.id,
      amountMinor: depositToKobo(row.amount, this.#amountUnit),
      currency: 'NGN' as Currency,
      senderName: row.sender_name,
      senderBank: row.sender_bank,
      senderAccount: row.sender_account_number,
      occurredAt: row.created_at === undefined ? new Date() : new Date(row.created_at),
    }));
  }

  #toAccount(payload: unknown): VirtualAccount {
    const parsed = virtualAccountResponse.safeParse(payload);
    if (!parsed.success) {
      throw new ProviderContractError(
        PROVIDER,
        `virtual account response does not match the expected shape: ${parsed.error.issues
          .map((i) => i.path.join('.'))
          .join(', ')}`,
        parsed.error,
      );
    }

    const data = parsed.data.data;

    // The NUBAN is checked HERE, at the boundary, not only by the database.
    // An account number we print in a customer's app and they type into their
    // bank has to be right, and a provider returning a truncated one would
    // otherwise reach the customer before it reached a constraint.
    if (!/^[0-9]{10}$/.test(data.account_number)) {
      throw new ProviderContractError(
        PROVIDER,
        `'${data.account_number}' is not a ten-digit NUBAN`,
      );
    }

    return {
      provider: PROVIDER,
      // Bitnob's virtual-account routes are addressed by the ACCOUNT id, so
      // there is nothing customer-level for the sweep to key on.
      providerCustomerRef: undefined,
      providerAccountId: data.id,
      accountNumber: data.account_number,
      bankName: data.bank_name,
      accountName: data.account_name,
      currency: (data.currency ?? 'NGN') as Currency,
      active: data.status === undefined || data.status.toLowerCase() === 'active',
    };
  }
}
