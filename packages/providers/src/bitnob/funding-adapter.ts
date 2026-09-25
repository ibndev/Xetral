import { z } from 'zod';
import type { Currency } from '@xetral/shared';
import { ProviderContractError, ProviderRejectedError } from '../ports/errors.js';
import { BITNOB_ENDPOINTS, type BitnobClient } from './client.js';
import type {
  DepositLookup,
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
  customers: '/api/customers',
  customerByEmail: (email: string) => `/api/customers?email=${encodeURIComponent(email)}`,
  customer: (id: string) => `/api/customers/${id}`,
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
const virtualAccountBody = z.object({
  id: z.string().min(1),
  account_number: z.string().min(1),
  bank_name: z.string().min(1),
  account_name: z.string().min(1),
  currency: z.string().min(1).optional(),
  // Some providers report activation asynchronously; absent means active.
  status: z.string().optional(),
});

/**
 * NESTED, per their published v2 specification — and the first version read
 * it FLAT.
 *
 * `bitnob-api-v2.openapi.json` answers both `POST /api/virtual-accounts` and
 * `GET /api/virtual-accounts/:id` with `data.virtual_account.{…}`. This
 * schema required `data.id`, so the one call that OPENS AN ACCOUNT would have
 * thrown a contract error after Bitnob had opened it: not a refusal, so no
 * other rail was asked, and the customer read "we could not open your
 * account" about an account number that existed. Both shapes are accepted,
 * because being tolerant on a read costs nothing — 003's lesson about their
 * card response, one resource over.
 */
const virtualAccountResponse = z.object({
  data: z.union([z.object({ virtual_account: virtualAccountBody }), virtualAccountBody]),
});

/** A customer as `GET /api/customers` and `POST /api/customers` return one. */
const customerBody = z.object({
  id: z.string().min(1),
  email: z.string().optional(),
  id_number: z.string().optional().nullable(),
  id_type: z.string().optional().nullable(),
});
const customerResponse = z.object({ data: customerBody });
const customerListResponse = z.object({
  data: z.union([
    z.object({ customers: z.array(customerBody) }),
    z.array(customerBody),
  ]),
});

const depositRow = z.object({
  id: z.string().min(1),
  /** Left `unknown` and narrowed by `depositToKobo`, exactly as card
   *  amounts are left to `parseMicro`. A `z.number()` here would accept a
   *  value JSON.parse has already rounded and hand it over looking valid. */
  amount: z.unknown(),
  currency: z.string().min(1).optional(),
  /** v2 lists debits and pending rows beside credits; absent reads as a
   *  completed credit, which is what the v1 shape only ever carried. */
  type: z.string().optional(),
  status: z.string().optional(),
  sender_name: z.string().optional(),
  sender_bank: z.string().optional(),
  sender_account_number: z.string().optional(),
  created_at: z.string().optional(),
});

/** `data.transactions[]` in v2 (`GET /api/virtual-accounts/:id/transactions`),
 *  a bare array before it. Same reasoning as the account read above. */
const depositListResponse = z.object({
  data: z.union([z.object({ transactions: z.array(depositRow) }), z.array(depositRow)]),
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
     * Their docs are explicit (`docs/virtual-accounts/overview.mdx`): Nigerian
     * regulation puts identity verification behind every naira account, and
     * the BVN — with a date of birth that matches the registry — lives on the
     * Bitnob CUSTOMER. That is a fact about BITNOB, not about the rail: CBN
     * tier 1 needs a name and a phone number, which is what Paystack opens on.
     *
     * SO THE REFUSAL IS DEFINITE AND NOTHING IS SENT, and that is what makes
     * it cost the customer nothing. `providerDidNothing()` reads it as a clean
     * "no", the account opening moves on to the next rail that covers naira,
     * and an unverified customer is issued a tier 1 account without ever being
     * asked for anything — instead of this adapter creating a Bitnob customer
     * it already knows Bitnob will not open an account for.
     */
    const bvn = await request.customer.bvn?.();
    const dateOfBirth = await request.customer.dateOfBirth?.();
    if (bvn === undefined || dateOfBirth === undefined) {
      throw new ProviderRejectedError(
        PROVIDER,
        'Bitnob issues a naira account only to a customer carrying a verified ' +
          'BVN and date of birth; nothing was sent. Another rail can open a ' +
          'tier 1 account.',
        'kyc_required',
      );
    }

    const providerCustomerId = await this.#customerFor(request.customer, bvn, dateOfBirth);

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

  /**
   * THE BITNOB CUSTOMER THIS ACCOUNT IS OPENED FOR — found, or registered.
   *
   * `provider_customers` could never supply one. KYC approval writes that row
   * with an id WE mint (`xetral-<uuid>`) and makes no provider call, so the
   * `customer_id` this adapter used to send was a string Bitnob had never
   * issued, and no naira account could have opened here for anybody. A real
   * Bitnob id (anything not ours) is used as given; otherwise the customer is
   * looked up by email FIRST, because `POST /api/customers` has no
   * idempotency key and a retry after a timeout must not register a second
   * one — the same look-before-create Paystack's adapter does.
   *
   * The BVN goes on the customer because that is where their docs put it.
   * An existing customer without one is completed with a PUT, rather than
   * registered again.
   */
  async #customerFor(
    customer: CreateVirtualAccountRequest['customer'],
    bvn: string,
    dateOfBirth: string,
  ): Promise<string> {
    const given = customer.providerCustomerId;
    if (given !== undefined && given !== '' && !given.startsWith('xetral-')) return given;

    const identity = {
      first_name: customer.firstName,
      last_name: customer.lastName,
      date_of_birth: dateOfBirth,
      id_type: 'bvn',
      id_number: bvn,
      country: 'NGA',
    };

    const listed = customerListResponse.safeParse(
      await this.#client.request('GET', BITNOB_FUNDING_ENDPOINTS.customerByEmail(customer.email)),
    );
    if (listed.success) {
      const rows = Array.isArray(listed.data.data) ? listed.data.data : listed.data.data.customers;
      // Their filter is a query parameter we cannot see being applied, so the
      // match is re-checked here — a server that ignored it would otherwise
      // hand this customer somebody else's record.
      const found = rows.find(
        (c) => (c.email ?? '').toLowerCase() === customer.email.toLowerCase(),
      );
      if (found !== undefined) {
        if ((found.id_number ?? '') === '') {
          await this.#client.request('PUT', BITNOB_FUNDING_ENDPOINTS.customer(found.id), identity);
        }
        return found.id;
      }
    }

    const created = customerResponse.safeParse(
      await this.#client.request('POST', BITNOB_FUNDING_ENDPOINTS.customers, {
        email: customer.email,
        customer_type: 'individual',
        ...(customer.phone === undefined ? {} : { phone_number: customer.phone }),
        reference: `xetral-${customer.reference}`,
        ...identity,
      }),
    );
    if (!created.success) {
      throw new ProviderContractError(
        PROVIDER,
        'customer registration did not return a customer id',
        created.error,
      );
    }
    return created.data.data.id;
  }

  async getVirtualAccount(providerAccountId: string): Promise<VirtualAccount> {
    const payload = await this.#client.request(
      'GET',
      BITNOB_FUNDING_ENDPOINTS.getVirtualAccount(providerAccountId),
    );
    return this.#toAccount(payload);
  }

  /** Keyed on the ACCOUNT: Bitnob lists transactions per virtual account. */
  async listDeposits(account: DepositLookup): Promise<readonly ProviderDeposit[]> {
    const payload = await this.#client.request(
      'GET',
      BITNOB_FUNDING_ENDPOINTS.listDeposits(account.providerAccountId),
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

    const rows = Array.isArray(parsed.data.data) ? parsed.data.data : parsed.data.data.transactions;
    return rows
      // Only money that ARRIVED. v2 lists debits and unsettled rows beside
      // credits, and crediting a pending one is money we may never receive.
      .filter(
        (row) =>
          (row.type === undefined || row.type.toLowerCase() === 'credit') &&
          (row.status === undefined || ['completed', 'successful', 'success'].includes(row.status.toLowerCase())),
      )
      .map((row) => ({
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

    const data = 'virtual_account' in parsed.data.data ? parsed.data.data.virtual_account : parsed.data.data;

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
