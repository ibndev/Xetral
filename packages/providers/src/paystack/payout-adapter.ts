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
    /*
     * A `nuban` RECIPIENT CANNOT BE CREATED WITHOUT A NAME, so an absent one
     * is refused HERE with a sentence rather than sent as `undefined` and
     * refused by Paystack as a validation error about a field.
     *
     * `accountName` became optional so a MOBILE MONEY wallet — which has no
     * name enquiry on any network — could be paid at all. This rail is the
     * other case: it serves bank accounts, where the lookup always answers,
     * and a payout reaching here without a name means the lookup was skipped
     * for a destination that has one. That is worth saying out loud.
     */
    if (request.accountName === undefined || request.accountName.trim() === '') {
      throw new ProviderContractError(
        PROVIDER,
        'a Paystack transfer recipient needs the name the bank returned, and ' +
          'none was looked up for this destination',
      );
    }

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
    /*
     * `otp` IS NOT SENT, AND CALLING IT SENT TOLD CUSTOMERS THEIR MONEY HAD
     * GONE WHEN IT HAD NOT MOVED AT ALL.
     *
     * Paystack's own documentation for Initiate Transfer: a business with
     * Transfers OTP enabled — which is the DEFAULT — gets back
     * `status: "otp"`, and the transfer sits there until somebody submits a
     * one-time code to Finalize Transfer. Nothing is debited, at their end or
     * the beneficiary's. It is a request that has not been authorised.
     *
     * There is no operator standing in the request path to type that code,
     * and there never can be: a payout is made by a customer on a phone. So
     * this rail either has OTP switched off, in which case a transfer is
     * authorised by the API call itself, or it cannot send money at all —
     * and the honest answer to the second is a REFUSAL, which returns the
     * customer's money and records a reason an operator can act on.
     *
     * It is `failed` rather than a thrown error so both callers resolve it
     * the same way: `send()` and the reconciliation sweep both go through
     * `applyReceipt`, and a failed receipt is what reverses the reservation.
     * Nothing is lost by refusing — an unfinalised transfer expires at
     * Paystack, and the alternative is a customer's money held for ever
     * against a code nobody will ever enter.
     */
    const mapped: PayoutReceipt['state'] | undefined =
      state === 'success'
        ? 'completed'
        : state === 'failed' ||
            state === 'reversed' ||
            state === 'abandoned' ||
            state === 'otp'
          ? 'failed'
          : state === 'pending' || state === 'processing' || state === 'received'
            ? 'sent'
            : undefined;

    if (mapped === undefined) {
      throw new ProviderContractError(
        PROVIDER,
        `unrecognised transfer status '${state}'. Guessing would either reverse a ` +
          `payout already on its way or report one that never left.`,
      );
    }

    /*
     * THE REASON NAMES THE SETTING, because the alternative is an operator
     * reading "the transfer failed" against a Paystack dashboard showing a
     * transfer that looks fine. It is a fact about our own integration and
     * carries no credential, so it is safe on a row an operator reads — and
     * `bank_payouts.failure_reason` is exactly where they will look.
     */
    const reason =
      state === 'otp'
        ? 'Paystack is set to require an OTP for transfers, so this one was ' +
          'never authorised. Disable Transfers OTP on the Paystack dashboard.'
        : row.reason;

    return {
      providerPayoutId: String(row.id),
      state: mapped,
      ...(reason === undefined ? {} : { failureReason: reason }),
    };
  }
}
