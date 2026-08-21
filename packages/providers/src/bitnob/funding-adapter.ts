import { z } from 'zod';
import type { Currency } from '@xetral/shared';
import { ProviderContractError } from '../ports/errors.js';
import type { BitnobClient } from './client.js';
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
 * CONFIRM BEFORE GO-LIVE, and it resolves with the same approval that gates
 * cards: the paths below follow the conventions verified for the card
 * endpoints in Phase 3 — a flat verb path under a base URL that already
 * contains `/api/v1`, camelCase request bodies — but the virtual-account
 * routes themselves could not be verified from this repository.
 *
 * The blast radius is deliberately small. Every path is in this one table, the
 * response shape is validated by a schema rather than read field-by-field at
 * call sites, and a wrong path fails loudly on the first call rather than
 * silently returning something plausible.
 */
export const BITNOB_FUNDING_ENDPOINTS = {
  createVirtualAccount: '/addresses/generate-naira-account',
  getVirtualAccount: (id: string) => `/addresses/naira-account/${id}`,
  listDeposits: (id: string) => `/addresses/naira-account/${id}/transactions`,
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

    const payload = await this.#client.request(
      'POST',
      BITNOB_FUNDING_ENDPOINTS.createVirtualAccount,
      {
        customerId: request.providerCustomerId,
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
      providerAccountId: data.id,
      accountNumber: data.account_number,
      bankName: data.bank_name,
      accountName: data.account_name,
      currency: (data.currency ?? 'NGN') as Currency,
      active: data.status === undefined || data.status.toLowerCase() === 'active',
    };
  }
}
