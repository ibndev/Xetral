import { z } from 'zod';
import type { Currency } from '@xetral/shared';
import { ProviderContractError } from '../ports/errors.js';
import type { BitnobClient } from './client.js';
import type {
  BeneficiaryLookup,
  PayoutBank,
  PayoutPort,
  PayoutReceipt,
  PayoutRequest,
} from '../ports/payout.js';

const PROVIDER = 'bitnob';

/**
 * Bitnob for bank payouts.
 *
 * VERIFIED against `bitnob/stealthdocs` (`docs.json`,
 * `docs/payouts/send-your-first-payout.mdx`,
 * `api-reference/payouts/usage-example.mdx`, `api-reference/payouts/swift-payouts.mdx`),
 * September 2026. Every path here carries a source and a date, because the
 * previous Bitnob tables in this package carried a source and no date and one
 * of them decayed.
 *
 * A PAYOUT IS THREE CALLS, and that is the shape worth understanding before
 * reading the code:
 *
 *    POST /api/payouts/quotes            -> { quote_id }   prices it
 *    POST /api/payouts/:quoteId/initialize  <- the beneficiary goes HERE
 *    POST /api/payouts/:quoteId/finalize    <- no body; THIS is irreversible
 *
 * The gaps between them are real states. A quote taken and not initialized
 * has cost nothing. A payout initialized and not finalized has moved no money
 * at their end. Only `finalize` sends it — which is why the adapter treats a
 * failure before that point as a plain rejection, and a timeout ON finalize
 * as the one thing the caller must not resolve either way.
 */
export const BITNOB_PAYOUT_ENDPOINTS = {
  banks: (country: string) => `/api/payouts/banks/${country}`,
  accountLookup: (country: string, bankCode: string, accountNumber: string) =>
    `/api/payouts/account-lookup?country=${encodeURIComponent(country)}` +
    `&bank_code=${encodeURIComponent(bankCode)}` +
    `&account_number=${encodeURIComponent(accountNumber)}`,
  quote: '/api/payouts/quotes',
  initialize: (quoteId: string) => `/api/payouts/${quoteId}/initialize`,
  finalize: (quoteId: string) => `/api/payouts/${quoteId}/finalize`,
  get: (payoutId: string) => `/api/payouts/${payoutId}`,
} as const;

const bankListResponse = z.object({
  data: z.array(
    z.object({
      code: z.string().min(1),
      name: z.string().min(1),
    }),
  ),
});

const lookupResponse = z.object({
  data: z.object({
    account_name: z.string().min(1),
    account_number: z.string().min(1),
    bank_code: z.string().min(1),
  }),
});

const quoteResponse = z.object({
  data: z.object({
    quote_id: z.string().min(1),
  }),
});

const payoutResponse = z.object({
  data: z.object({
    id: z.string().min(1),
    status: z.string().min(1),
    /** Present only on a failure, and the wording is theirs. */
    reason: z.string().nullish(),
  }),
});

/**
 * Their vocabulary, mapped to ours ONCE.
 *
 * Their own troubleshooting page warns that the webhook vocabulary and the
 * REST vocabulary do not match and says to map both explicitly rather than
 * assume they agree. So this map is exhaustive and an unrecognised status
 * THROWS rather than defaulting — the rule Phase 9 records for crypto, and
 * the reason is identical: one default reverses money that has already left,
 * the other tells a customer money left when it did not.
 */
function toState(status: string): PayoutReceipt['state'] {
  switch (status.toLowerCase()) {
    case 'success':
    case 'successful':
    case 'completed':
      return 'completed';
    case 'pending':
    case 'processing':
    case 'initiated':
      return 'sent';
    case 'failed':
    case 'reversed':
    case 'cancelled':
      return 'failed';
    default:
      throw new ProviderContractError(
        PROVIDER,
        `unrecognised payout status ${JSON.stringify(status)}: refusing to guess, ` +
          `because one guess reverses money that has left and the other reports ` +
          `money as sent that never did`,
      );
  }
}

export interface BitnobPayoutOptions {
  readonly client: BitnobClient;
}

export class BitnobPayoutAdapter implements PayoutPort {
  readonly provider = PROVIDER;

  readonly #client: BitnobClient;

  constructor(options: BitnobPayoutOptions) {
    this.#client = options.client;
  }

  async banks(country: string): Promise<readonly PayoutBank[]> {
    const payload = await this.#client.request(
      'GET',
      BITNOB_PAYOUT_ENDPOINTS.banks(country),
    );
    const parsed = bankListResponse.safeParse(payload);
    if (!parsed.success) {
      throw new ProviderContractError(
        PROVIDER,
        `bank list does not match the expected shape: ${issues(parsed.error)}`,
        parsed.error,
      );
    }
    return parsed.data.data.map((bank) => ({ code: bank.code, name: bank.name }));
  }

  async lookup(
    country: string,
    bankCode: string,
    accountNumber: string,
  ): Promise<BeneficiaryLookup> {
    const payload = await this.#client.request(
      'GET',
      BITNOB_PAYOUT_ENDPOINTS.accountLookup(country, bankCode, accountNumber),
    );
    const parsed = lookupResponse.safeParse(payload);
    if (!parsed.success) {
      throw new ProviderContractError(
        PROVIDER,
        `account lookup does not match the expected shape: ${issues(parsed.error)}`,
        parsed.error,
      );
    }
    return {
      accountName: parsed.data.data.account_name,
      accountNumber: parsed.data.data.account_number,
      bankCode: parsed.data.data.bank_code,
    };
  }

  async send<C extends Currency>(request: PayoutRequest<C>): Promise<PayoutReceipt> {
    /*
     * QUOTE, INITIALIZE, FINALIZE — and the order matters more than it looks.
     *
     * Every failure before `finalize` is a payout that did not happen and
     * cost nothing, so it surfaces as an ordinary rejection and the caller
     * reverses its reserve. A failure ON `finalize` is the one case where we
     * cannot say: `ProviderTimeoutError` propagates untouched, the caller
     * settles nothing and reverses nothing, and reconciliation asks later.
     */
    const quotePayload = await this.#client.request(
      'POST',
      BITNOB_PAYOUT_ENDPOINTS.quote,
      {
        source: 'offchain',
        from_currency: request.amount.currency,
        to_currency: request.amount.currency,
        // Minor units as a STRING. A JSON number past 2^53 has already lost
        // precision by the time anything here could object.
        amount: request.amount.amount.toString(),
        country: request.country,
      },
      request.reference,
    );
    const quote = quoteResponse.safeParse(quotePayload);
    if (!quote.success) {
      throw new ProviderContractError(
        PROVIDER,
        `payout quote does not match the expected shape: ${issues(quote.error)}`,
        quote.error,
      );
    }
    const quoteId = quote.data.data.quote_id;

    await this.#client.request(
      'POST',
      BITNOB_PAYOUT_ENDPOINTS.initialize(quoteId),
      {
        // Their docs are explicit that the beneficiary belongs on INITIALIZE
        // and not on the quote — a quote is a price, not a payment.
        beneficiary: {
          account_number: request.accountNumber,
          bank_code: request.bankCode,
          // THE NAME THE BANK GAVE US, carried through from the lookup. The
          // sender's own text would make the confirmation screen a formality.
          account_name: request.accountName,
        },
        reference: request.reference,
        ...(request.narration === undefined ? {} : { narration: request.narration }),
      },
      request.reference,
    );

    // THE IRREVERSIBLE CALL. No body, by their contract.
    const finalPayload = await this.#client.request(
      'POST',
      BITNOB_PAYOUT_ENDPOINTS.finalize(quoteId),
      undefined,
      request.reference,
    );

    return this.#toReceipt(finalPayload);
  }

  async status(providerPayoutId: string): Promise<PayoutReceipt> {
    return this.#toReceipt(
      await this.#client.request('GET', BITNOB_PAYOUT_ENDPOINTS.get(providerPayoutId)),
    );
  }

  #toReceipt(payload: unknown): PayoutReceipt {
    const parsed = payoutResponse.safeParse(payload);
    if (!parsed.success) {
      throw new ProviderContractError(
        PROVIDER,
        `payout response does not match the expected shape: ${issues(parsed.error)}`,
        parsed.error,
      );
    }
    const { id, status, reason } = parsed.data.data;
    const state = toState(status);
    return {
      providerPayoutId: id,
      state,
      // Only carried on a failure, so a completed payout cannot arrive with a
      // reason attached and be shown to a customer as though something went
      // wrong.
      ...(state === 'failed' ? { failureReason: reason ?? 'the provider did not say' } : {}),
    };
  }
}

function issues(error: z.ZodError): string {
  return error.issues.map((i) => i.path.join('.')).join(', ');
}
