import { z } from 'zod';
import { isCurrency, money } from '@xetral/shared';
import type { Currency, Money } from '@xetral/shared';
import { NETWORK_NAME_HINTS } from '../ports/mobile-money.js';
import { NO_SUCH_TRANSFER, ProviderContractError, ProviderRejectedError } from '../ports/errors.js';
import type {
  BeneficiaryLookup,
  PayoutBank,
  PayoutBranch,
  PayoutMethod,
  PayoutPort,
  PayoutReceipt,
  PayoutRequest,
} from '../ports/payout.js';
import { KORA_ENDPOINTS, type KoraClient } from './client.js';
import { koraMajor, koraMinor } from './amounts.js';

const PROVIDER = 'kora';

/**
 * Paying out through Kora — the Payout API guide (developers.korapay.com,
 * read 3 October 2026):
 *
 *   1  GET  /api/v1/misc/banks?countryCode=NG|KE|ZA        bank codes
 *      GET  /api/v1/misc/mobile-money?countryCode=KE|GH    operator slugs
 *   2  POST /api/v1/misc/banks/resolve                     NG and KE banks
 *      POST /api/v1/misc/mobile-money/resolve              GHANAIAN networks
 *   3  POST /api/v1/transactions/disburse
 *   4  GET  /api/v1/transactions/:reference                (Bulk Payouts guide)
 *
 * PREFUNDED: "Kora will directly disburse from your positive balance". A cedi
 * payout spends cedis we put there, which is what 073's guard and the
 * provider-liquidity read exist for.
 *
 * THERE IS NO PAYOUT ID OF THEIRS. Kora identifies a payout by the reference
 * WE sent and is asked about it by that reference, so `providerPayoutId` is
 * our reference echoed back — the property that makes a send that timed out
 * askable at all.
 */

/**
 * OUR network codes, per country — the picker both apps draw. They never
 * reach the wire: the operator is found by NAME in Kora's own list and THAT
 * row's slug is sent (`NETWORK_NAME_HINTS`), so a stale hint costs a match
 * and can never invent a destination.
 */
export const KORA_MOBILE_MONEY_NETWORKS: Readonly<Record<string, readonly PayoutBank[]>> = {
  GH: [
    { code: 'MTN', name: 'MTN Mobile Money' },
    { code: 'VOD', name: 'Telecel Cash' },
    { code: 'ATL', name: 'AirtelTigo Money' },
  ],
  KE: [{ code: 'MPS', name: 'M-PESA' }],
};

/** Where Kora documents a BANK list for payouts: "Nigeria, Kenya and South
 *  Africa". Ghana is not among them, and a Ghanaian bank payout is refused
 *  here rather than sent to a list nobody documented. */
const BANK_COUNTRIES: ReadonlySet<string> = new Set(['NG', 'KE', 'ZA']);

/** Where Kora documents resolving a WALLET to a name: "Mobile Money account
 *  verification for Ghanaian mobile money networks". Kenya is absent, so a
 *  Kenyan wallet has no name enquiry here — 043's rule where it applies. */
const RESOLVES_MOBILE_MONEY: ReadonlySet<string> = new Set(['GH']);

/** Where Kora documents resolving a BANK account: "Nigerian and Kenyan Banks". */
const RESOLVES_BANKS: ReadonlySet<string> = new Set(['NG', 'KE']);

const institutionList = z.object({
  status: z.literal(true),
  data: z.array(
    z.object({
      name: z.string().min(1),
      slug: z.string().nullish(),
      code: z.string().min(1),
      country: z.string().nullish(),
    }),
  ),
});

type Institution = z.infer<typeof institutionList>['data'][number];

const resolveResponse = z.object({
  status: z.literal(true),
  data: z.object({ account_name: z.string().nullish() }).partial(),
});

const transferResponse = z.object({
  status: z.literal(true),
  data: z.object({
    reference: z.string().nullish(),
    /** `processing`, `success`, `failed`, `pending`. */
    status: z.string().min(1),
    message: z.string().nullish(),
  }),
});

const balancesResponse = z.object({
  status: z.literal(true),
  data: z.record(
    z.string(),
    z.object({ available_balance: z.union([z.number(), z.string()]) }).partial(),
  ),
});

export interface KoraPayoutOptions {
  /**
   * `destination.customer.email` is REQUIRED on every Kora payout, and the
   * platform does not hold a beneficiary's email address. The SENDER's would
   * hand a customer's address to the rail for a stranger's payout, so the
   * platform's own operations address goes here instead. Unset, a payout is
   * refused before anything is sent.
   */
  readonly customerEmail: string | undefined;
}

export class KoraPayoutAdapter implements PayoutPort {
  readonly provider = PROVIDER;
  readonly prefunded = true;
  readonly #client: KoraClient;
  readonly #customerEmail: string | undefined;
  /** One read of each list per process — they change rarely, and a payout
   *  must not pay for a catalogue fetch every time. A failed read is
   *  forgotten so the next call asks again. */
  readonly #lists = new Map<string, Promise<readonly Institution[]>>();

  constructor(client: KoraClient, options: KoraPayoutOptions) {
    this.#client = client;
    this.#customerEmail = options.customerEmail;
  }

  async banks(country: string, method?: PayoutMethod): Promise<readonly PayoutBank[]> {
    const iso = country.trim().toUpperCase();
    const networks = KORA_MOBILE_MONEY_NETWORKS[iso];
    if (networks !== undefined && method !== 'bank') return networks;
    if (!BANK_COUNTRIES.has(iso)) {
      throw new ProviderRejectedError(
        PROVIDER,
        `Kora documents no bank payouts to ${iso}`,
        'payout_method_unavailable',
      );
    }
    const rows = await this.#list('banks', iso);
    return rows.map((row) => ({ code: row.code, name: row.name.trim() }));
  }

  /** Kora asks for no branch on any corridor it documents. */
  async branches(_country: string, _bankId: string): Promise<readonly PayoutBranch[]> {
    return [];
  }

  async lookup(country: string, bankCode: string, accountNumber: string): Promise<BeneficiaryLookup> {
    const iso = country.trim().toUpperCase();
    const isWallet = KORA_MOBILE_MONEY_NETWORKS[iso]?.some((n) => n.code === bankCode) === true;

    if (isWallet && !RESOLVES_MOBILE_MONEY.has(iso)) {
      throw new ProviderRejectedError(
        PROVIDER,
        `a ${iso} mobile money wallet has no name enquiry on Kora; confirm the network and the number`,
        'name_unavailable',
      );
    }
    if (!isWallet && !RESOLVES_BANKS.has(iso)) {
      throw new ProviderRejectedError(
        PROVIDER,
        `Kora documents no bank account resolve for ${iso}`,
        'name_unavailable',
      );
    }

    const tried: string[] = [];
    try {
      const body = isWallet
        ? await this.#client.request('POST', KORA_ENDPOINTS.resolveMobileMoney, {
            mobileMoneyCode: (await this.#operator(iso, bankCode)).code,
            phoneNumber: accountNumber,
            /* "country currency. E.g, GH." — the guide's own example. */
            currency: iso,
          })
        : await this.#client.request('POST', KORA_ENDPOINTS.resolveBank, {
            bank: bankCode,
            account: accountNumber,
            /* "country currency. E.g, KE, NG." — the guide's own example. */
            currency: iso,
          });
      const parsed = resolveResponse.safeParse(body);
      const name = parsed.success ? parsed.data.data.account_name : undefined;
      if (name !== undefined && name !== null && name.trim() !== '') {
        return { accountNumber, bankCode, accountName: name.trim() };
      }
      tried.push(`${isWallet ? 'wallet' : 'bank'} resolve ${shape(accountNumber)}: no name`);
    } catch (error) {
      if (!(error instanceof ProviderRejectedError)) {
        /* An outage is not a statement about the customer's number; it
         * degrades to "no name, ask for a label" rather than a refusal. */
        throw new ProviderRejectedError(
          PROVIDER,
          `the resolver could not be reached (${error instanceof Error ? error.name : 'error'})`,
          'name_unavailable',
          error,
        );
      }
      tried.push(`${isWallet ? 'wallet' : 'bank'} resolve ${shape(accountNumber)}: ${error.message}`);
    }

    /* An unknown account and an unreachable bank answer alike to the
     * customer (043); `cause` carries the trail for `name_enquiry_refusals`. */
    throw new ProviderRejectedError(
      PROVIDER,
      tried[tried.length - 1] ?? 'could not resolve that account',
      'unknown_account',
      { keyMode: await this.#client.keyMode(), tried },
    );
  }

  async send<C extends Currency>(request: PayoutRequest<C>): Promise<PayoutReceipt> {
    const iso = request.country.trim().toUpperCase();
    const isWallet = KORA_MOBILE_MONEY_NETWORKS[iso]?.some((n) => n.code === request.bankCode) === true;
    const currency = request.amount.currency;

    /*
     * EVERYTHING THAT CAN REFUSE DOES SO BEFORE THE CALL, so a refusal here is
     * a definite "nothing was sent" and the customer's money comes back.
     */
    if (request.debitCurrency !== undefined && request.debitCurrency !== currency) {
      /* Kora's payout has no field naming a different balance to debit; it
       * disburses from the balance in the payout currency. */
      throw new ProviderRejectedError(
        PROVIDER,
        `Kora cannot fund a ${currency} payout from a ${request.debitCurrency} balance`,
        'debit_currency_unsupported',
      );
    }
    if (this.#customerEmail === undefined || this.#customerEmail === '') {
      throw new ProviderRejectedError(
        PROVIDER,
        'Kora requires a customer email on every payout and none is configured: set ' +
          'OPERATIONS_EMAIL.',
        'payout_misconfigured',
      );
    }
    if (!isWallet && !BANK_COUNTRIES.has(iso)) {
      throw new ProviderRejectedError(
        PROVIDER,
        `Kora documents no bank payouts to ${iso}`,
        'payout_method_unavailable',
      );
    }
    const operator = isWallet ? await this.#operator(iso, request.bankCode) : undefined;
    if (isWallet && (operator?.slug === undefined || operator.slug === null || operator.slug === '')) {
      throw new ProviderRejectedError(
        PROVIDER,
        `Kora's operator list for ${iso} has no slug for ${request.bankCode}`,
        'unknown_network',
      );
    }

    const name = request.accountName?.trim();
    const body = await this.#client.request('POST', KORA_ENDPOINTS.disburse, {
      /* OURS, derived from the customer's key; "must be at least 5
       * characters long". Kora refuses a reused one, so a retry is one payout
       * at their end as well as at ours. */
      reference: request.reference,
      destination: {
        type: isWallet ? 'mobile_money' : 'bank_account',
        amount: koraMajor(request.amount.amount, currency),
        currency,
        ...(request.narration === undefined ? {} : { narration: request.narration }),
        ...(isWallet
          ? {
              mobile_money: {
                operator: operator?.slug,
                /* International digits, as their own samples write them
                 * (`233244300001`). */
                mobile_number: request.accountNumber,
              },
            }
          : { bank_account: { bank: request.bankCode, account: request.accountNumber } }),
        customer: {
          /* The rail's answer where there was one — never the sender's text. */
          ...(name === undefined || name === '' ? {} : { name }),
          email: this.#customerEmail,
        },
      },
    });

    const parsed = transferResponse.safeParse(body);
    if (!parsed.success) {
      throw new ProviderContractError(PROVIDER, 'unexpected /transactions/disburse response');
    }
    return receiptOf(parsed.data.data, request.reference);
  }

  /** `status()` takes the rail's id, which on Kora IS our reference. */
  async status(providerPayoutId: string): Promise<PayoutReceipt> {
    return this.statusByReference(providerPayoutId);
  }

  /**
   * "Transaction not found ... This can be treated as a failed transaction"
   * (Errors guide) — Kora's documented answer for a payout reference it does
   * not hold, and the ONLY refusal read as never-sent.
   */
  async statusByReference(reference: string): Promise<PayoutReceipt> {
    let body: unknown;
    try {
      body = await this.#client.request('GET', KORA_ENDPOINTS.transaction(reference));
    } catch (error) {
      if (error instanceof ProviderRejectedError && /transaction not found/i.test(error.message)) {
        throw new ProviderRejectedError(PROVIDER, error.message, NO_SUCH_TRANSFER, error);
      }
      throw error;
    }
    const parsed = transferResponse.safeParse(body);
    if (!parsed.success) {
      throw new ProviderContractError(PROVIDER, 'unexpected /transactions/:reference response');
    }
    return receiptOf(parsed.data.data, reference);
  }

  /**
   * What Kora holds for us, per currency — `available_balance` only, which is
   * what a payout can draw on (Balance API guide).
   */
  async floatBalances(): Promise<readonly Money<Currency>[]> {
    const body = await this.#client.request('GET', KORA_ENDPOINTS.balances);
    const parsed = balancesResponse.safeParse(body);
    if (!parsed.success) {
      throw new ProviderContractError(PROVIDER, 'unexpected /balances response');
    }
    const held: Money<Currency>[] = [];
    for (const [raw, row] of Object.entries(parsed.data.data)) {
      const code = raw.trim().toUpperCase();
      if (!isCurrency(code) || row.available_balance === undefined) continue;
      held.push(money(koraMinor(row.available_balance, code), code));
    }
    return held;
  }

  /** One of OUR network codes, found by NAME in Kora's own operator list. */
  async #operator(iso: string, ourCode: string): Promise<Institution> {
    const hints = NETWORK_NAME_HINTS[ourCode.toUpperCase()] ?? [ourCode.toUpperCase()];
    const rows = await this.#list('mobile-money', iso);
    const found = rows.find((row) => {
      const name = row.name.toUpperCase();
      return hints.some((hint) => name.includes(hint));
    });
    if (found === undefined) {
      throw new ProviderRejectedError(
        PROVIDER,
        `no operator in Kora's ${iso} list matches ${ourCode}`,
        'unknown_network',
      );
    }
    return found;
  }

  #list(kind: 'banks' | 'mobile-money', iso: string): Promise<readonly Institution[]> {
    const key = `${kind}:${iso}`;
    const cached = this.#lists.get(key);
    if (cached !== undefined) return cached;
    const pending = (async () => {
      const body = await this.#client.request(
        'GET',
        kind === 'banks' ? KORA_ENDPOINTS.banks(iso) : KORA_ENDPOINTS.mobileMoneyOperators(iso),
      );
      const parsed = institutionList.safeParse(body);
      if (!parsed.success) {
        throw new ProviderContractError(PROVIDER, `unexpected ${kind} list for ${iso}`);
      }
      return parsed.data.data;
    })();
    this.#lists.set(key, pending);
    pending.catch(() => this.#lists.delete(key));
    return pending;
  }
}

/**
 * Kora's payout state as the port's three. AN UNRECOGNISED STATE IS `sent`,
 * never `failed`: reading an unknown word as failed reverses a payout that
 * may be in somebody's account; reading it as in flight leaves it held until
 * a person or the sweep asks.
 */
function receiptOf(
  data: { reference?: string | null | undefined; status: string; message?: string | null | undefined },
  ourReference: string,
): PayoutReceipt {
  const state = data.status.trim().toLowerCase();
  const reference = data.reference ?? undefined;
  const base = {
    providerPayoutId: reference ?? ourReference,
    ...(reference === undefined ? {} : { reference }),
  };
  if (state === 'success') return { ...base, state: 'completed' };
  if (state === 'failed') {
    const reason = data.message ?? undefined;
    return { ...base, state: 'failed', ...(reason === undefined ? {} : { failureReason: reason }) };
  }
  return { ...base, state: 'sent' };
}

/** A number's SHAPE for the trail, never the number. */
function shape(digits: string): string {
  return digits.length <= 8 ? `${digits.length} digits` : `${digits.slice(0, 3)}…${digits.slice(-4)}`;
}
