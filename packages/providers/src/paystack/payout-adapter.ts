import { z } from 'zod';
import { ProviderContractError, ProviderRejectedError } from '../ports/errors.js';
import { PAYSTACK_ENDPOINTS, type PaystackClient } from './client.js';
import type {
  BeneficiaryLookup,
  PayoutBank,
  PayoutPort,
  PayoutReceipt,
  PayoutRequest,
} from '../ports/payout.js';
import type { Currency } from '@xetral/shared';

const PROVIDER = 'paystack';

/**
 * Paying a Nigerian bank account through Paystack.
 *
 * THE REASON THIS EXISTS is that the bank list had exactly one implementation
 * and it was Bitnob's. A deployment holding only Paystack credentials — which
 * is the shipped default rail — asked for the list, got a provider error, and
 * the Send screen said "the bank list could not be loaded". Nothing was
 * broken except that the only adapter that could answer needed a credential
 * nobody had configured.
 *
 * So the port now has a second implementation on the rail the platform
 * already defaults to. Nothing about the money flow changes: this is Phase
 * 9's shape, `wallet_withdrawal` and `customer_pending`, exactly as the
 * Bitnob adapter uses.
 *
 * ENDPOINTS AND SHAPES ARE FROM PAYSTACK'S OWN PUBLISHED NODE SDK
 * (`paystack-api@2.0.6`): `GET /bank`, `GET /bank/resolve`,
 * `POST /transferrecipient`, `POST /transfer`, `GET /transfer/:id`. This repo
 * has twice shipped a table of plausible constants that passed every test
 * written from the same assumptions and failed on the first live call, so an
 * unsourced constant here is a bug rather than a detail.
 */

const bankListResponse = z.object({
  data: z.array(
    z.object({
      name: z.string().min(1),
      /** Paystack's own clearing code. Opaque to us and passed back verbatim. */
      code: z.string().min(1),
      /** Their catalogue includes mobile money and non-transfer rails. */
      type: z.string().optional(),
      active: z.boolean().optional(),
    }),
  ),
});

const resolveResponse = z.object({
  data: z.object({
    account_number: z.string().min(1),
    account_name: z.string().min(1),
  }),
});

const recipientResponse = z.object({
  data: z.object({ recipient_code: z.string().min(1) }),
});

const transferResponse = z.object({
  data: z.object({
    id: z.union([z.string(), z.number()]),
    transfer_code: z.string().min(1).optional(),
    status: z.string().optional(),
    reason: z.string().optional(),
  }),
});

function issues(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
}

/**
 * ISO 3166 alpha-2 to the slug Paystack's own API wants.
 *
 * Their `country` parameter is a name, not a code — `nigeria`, not `NG` — and
 * sending the code returns an EMPTY list rather than an error, which is the
 * failure this whole adapter exists to stop presenting as "no banks".
 */
const PAYSTACK_COUNTRY: Record<string, string> = {
  NG: 'nigeria',
  GH: 'ghana',
  KE: 'kenya',
  ZA: 'south africa',
};

/** What Paystack settles in, per country. A bank list asked for in the wrong
 *  currency comes back empty for the same silent reason. */
const PAYSTACK_CURRENCY: Record<string, string> = {
  NG: 'NGN',
  GH: 'GHS',
  KE: 'KES',
  ZA: 'ZAR',
};

export interface PaystackPayoutOptions {
  readonly client: PaystackClient;
}

export class PaystackPayoutAdapter implements PayoutPort {
  readonly provider = PROVIDER;

  readonly #client: PaystackClient;

  constructor(options: PaystackPayoutOptions) {
    this.#client = options.client;
  }

  async banks(country: string): Promise<readonly PayoutBank[]> {
    const code = country.toUpperCase();
    const slug = PAYSTACK_COUNTRY[code];
    const currency = PAYSTACK_CURRENCY[code];
    if (slug === undefined || currency === undefined) {
      // A REFUSAL, not an outage. Asking for a country this rail does not
      // serve is a question with an answer, and counting it as ill health
      // would put a customer's dropdown into 037's failure rate.
      throw new ProviderRejectedError(
        PROVIDER,
        `Paystack does not serve payouts in ${country}`,
        'country_not_supported',
      );
    }

    const payload = await this.#client.request('GET', PAYSTACK_ENDPOINTS.banks(slug, currency));
    const parsed = bankListResponse.safeParse(payload);
    if (!parsed.success) {
      throw new ProviderContractError(
        PROVIDER,
        `bank list does not match the expected shape: ${issues(parsed.error)}`,
        parsed.error,
      );
    }

    return (
      parsed.data.data
        /*
         * ONLY WHAT CAN ACTUALLY RECEIVE A TRANSFER.
         *
         * Paystack's catalogue carries mobile money wallets and rails that are
         * not bank accounts, and an inactive entry stays in it. Offering one
         * on a screen headed "Bank account" produces a selection that fails at
         * the lookup — which reads to the customer as their account number
         * being wrong.
         */
        .filter((bank) => bank.active !== false && (bank.type ?? 'nuban') === 'nuban')
        .map((bank) => ({ code: bank.code, name: bank.name }))
    );
  }

  async lookup(
    country: string,
    bankCode: string,
    accountNumber: string,
  ): Promise<BeneficiaryLookup> {
    const payload = await this.#client.request(
      'GET',
      PAYSTACK_ENDPOINTS.resolveAccount(accountNumber, bankCode),
    );
    const parsed = resolveResponse.safeParse(payload);
    if (!parsed.success) {
      throw new ProviderContractError(
        PROVIDER,
        `account lookup does not match the expected shape: ${issues(parsed.error)}`,
        parsed.error,
      );
    }

    return {
      accountNumber: parsed.data.data.account_number,
      bankCode,
      // THE BANK'S ANSWER, never the sender's claim — the port's whole reason
      // for having a lookup at all.
      accountName: parsed.data.data.account_name,
    };
  }

  /**
   * Sending is TWO calls, and the first is not the money.
   *
   * Paystack pays a RECIPIENT rather than an account number, so the account
   * has to be registered first. That is bookkeeping on their side and moves
   * nothing; only `POST /transfer` does. The two are separated here for the
   * same reason the Bitnob adapter's quote and finalize are: a process that
   * dies between them must be able to say which one it got through.
   */
  async send<C extends Currency>(request: PayoutRequest<C>): Promise<PayoutReceipt> {
    const recipient = await this.#client.request(
      'POST',
      PAYSTACK_ENDPOINTS.createTransferRecipient,
      {
        type: 'nuban',
        // The name the LOOKUP returned, carried through unchanged. Sending
        // the customer's own text here would defeat the lookup.
        name: request.accountName,
        account_number: request.accountNumber,
        bank_code: request.bankCode,
        currency: request.amount.currency,
      },
    );

    const parsedRecipient = recipientResponse.safeParse(recipient);
    if (!parsedRecipient.success) {
      throw new ProviderContractError(
        PROVIDER,
        `transfer recipient does not match the expected shape: ${issues(parsedRecipient.error)}`,
        parsedRecipient.error,
      );
    }

    const payload = await this.#client.request('POST', PAYSTACK_ENDPOINTS.createTransfer, {
      source: 'balance',
      // MINOR UNITS, which is what Paystack takes and what the ledger holds.
      // Serialised as a string so a large bigint cannot be rounded on the way
      // out by `JSON.stringify`.
      amount: request.amount.amount.toString(),
      recipient: parsedRecipient.data.data.recipient_code,
      // OURS, derived from the customer's key. Paystack de-duplicates on it,
      // so a retry after a timeout is one payout at their end as well as ours
      // — the one operation where a duplicate cannot be clawed back.
      reference: request.reference,
      ...(request.narration === undefined ? {} : { reason: request.narration }),
    });

    return this.#toReceipt(payload);
  }

  async status(providerPayoutId: string): Promise<PayoutReceipt> {
    return this.#toReceipt(
      await this.#client.request('GET', PAYSTACK_ENDPOINTS.getTransfer(providerPayoutId)),
    );
  }

  #toReceipt(payload: unknown): PayoutReceipt {
    const parsed = transferResponse.safeParse(payload);
    if (!parsed.success) {
      throw new ProviderContractError(
        PROVIDER,
        `transfer does not match the expected shape: ${issues(parsed.error)}`,
        parsed.error,
      );
    }

    const row = parsed.data.data;
    const state = row.status ?? 'pending';

    /*
     * AN UNRECOGNISED STATUS THROWS rather than defaulting, the rule Phase 9
     * records for crypto and for the same reason: one default reverses money
     * already on its way to somebody, the other tells a customer money left
     * when it did not. Neither is a safe guess.
     */
    const mapped: PayoutReceipt['state'] | undefined =
      state === 'success'
        ? 'completed'
        : state === 'failed' || state === 'reversed' || state === 'abandoned'
          ? 'failed'
          : state === 'pending' || state === 'otp' || state === 'processing' || state === 'received'
            ? 'sent'
            : undefined;

    if (mapped === undefined) {
      throw new ProviderContractError(
        PROVIDER,
        `unrecognised transfer status '${state}'. Guessing would either reverse a ` +
          `payout already on its way or report one that never left.`,
      );
    }

    return {
      providerPayoutId: String(row.id),
      state: mapped,
      ...(row.reason === undefined ? {} : { failureReason: row.reason }),
    };
  }
}
