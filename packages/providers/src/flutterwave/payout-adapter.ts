import { z } from 'zod';
import { isCurrency, money, toMajor } from '@xetral/shared';
import type { Currency } from '@xetral/shared';
import { ProviderContractError, ProviderRejectedError } from '../ports/errors.js';
import type {
  BeneficiaryLookup,
  PayoutBank,
  PayoutPort,
  PayoutReceipt,
  PayoutRequest,
} from '../ports/payout.js';
import { FLUTTERWAVE_ENDPOINTS, type FlutterwaveClient } from './client.js';

const PROVIDER = 'flutterwave';

/**
 * MOBILE MONEY NETWORKS, per country, as data.
 *
 * WHY THIS IS A TABLE HERE RATHER THAN A CALL. `GET /v3/banks/:country`
 * answers BANKS. In Ghana and Kenya money does not move to a bank account for
 * most people, it moves to a wallet on a phone number, and the "bank code" a
 * transfer to one carries is a NETWORK code that their bank list does not
 * contain. A Ghanaian offered that list would be choosing a bank in order to
 * pay an MTN wallet.
 *
 * The codes are Flutterwave's own and are what `account_bank` takes on a
 * mobile money transfer. They are few, they change rarely, and a wrong one is
 * a loud refusal rather than money in the wrong place — which is why a small
 * verified table beats a call that answers the wrong question.
 */
export const FLUTTERWAVE_MOBILE_MONEY_NETWORKS: Readonly<Record<string, readonly PayoutBank[]>> = {
  GH: [
    { code: 'MTN', name: 'MTN Mobile Money' },
    { code: 'VOD', name: 'Telecel Cash (formerly Vodafone Cash)' },
    { code: 'ATL', name: 'AirtelTigo Money' },
  ],
  KE: [{ code: 'MPS', name: 'M-PESA' }],
};

const banksResponse = z.object({
  status: z.string().optional(),
  data: z.array(z.object({ code: z.string().min(1), name: z.string().min(1) })).optional(),
});

const resolveResponse = z.object({
  status: z.string().optional(),
  message: z.string().optional(),
  data: z.object({ account_number: z.string().optional(), account_name: z.string().min(1) }).optional(),
});

const transferResponse = z.object({
  status: z.string().optional(),
  message: z.string().optional(),
  data: z
    .object({
      id: z.union([z.number(), z.string()]),
      /** `NEW`, `PENDING`, `SUCCESSFUL`, `FAILED`. */
      status: z.string().min(1),
      complete_message: z.string().nullish(),
    })
    .optional(),
});

/**
 * Paying a bank account or a mobile money wallet through Flutterwave.
 *
 * THE UNIT IS MAJOR, like their checkout and unlike Paystack's payouts. Same
 * factor-of-a-hundred trap, same single conversion through `toMajor`, and it
 * is worth the repetition: this is the direction that sends a customer's
 * money away and cannot be recalled.
 *
 * A MOBILE MONEY WALLET HAS NO INDEPENDENT NAME TO FETCH, and this adapter
 * says so rather than inventing one. `lookup` asks their resolver, which
 * answers for bank accounts; where it cannot, the refusal is `name_unavailable`
 * rather than "no such account", because the two mean opposite things to the
 * customer standing in front of it — one is "check the number", the other is
 * "we cannot confirm who this is". The rule 043 states — the name is the
 * BANK'S, never the sender's — is unchanged: what this adapter will not do is
 * echo back a name the sender typed.
 */
export class FlutterwavePayoutAdapter implements PayoutPort {
  readonly provider = PROVIDER;
  readonly #client: FlutterwaveClient;

  constructor(client: FlutterwaveClient) {
    this.#client = client;
  }

  async banks(country: string): Promise<readonly PayoutBank[]> {
    const iso = country.trim().toUpperCase();

    /*
     * THE NETWORKS ARE THE ANSWER WHERE THERE ARE NETWORKS.
     *
     * Returning banks in Accra is the exact failure 046 records about
     * offering a Nigerian bank list everywhere: a selection the customer's
     * money cannot reach, which then fails at the transfer and reads to them
     * as their own number being wrong.
     */
    const networks = FLUTTERWAVE_MOBILE_MONEY_NETWORKS[iso];
    if (networks !== undefined) return networks;

    const body = await this.#client.request('GET', FLUTTERWAVE_ENDPOINTS.banks(iso));
    const parsed = banksResponse.safeParse(body);
    if (!parsed.success || parsed.data.data === undefined) {
      throw new ProviderContractError(PROVIDER, `unexpected /v3/banks/${iso} response`);
    }
    return parsed.data.data.map((bank) => ({ code: bank.code, name: bank.name }));
  }

  async lookup(
    country: string,
    bankCode: string,
    accountNumber: string,
  ): Promise<BeneficiaryLookup> {
    const iso = country.trim().toUpperCase();
    const networks = FLUTTERWAVE_MOBILE_MONEY_NETWORKS[iso];

    if (networks?.some((n) => n.code === bankCode) === true) {
      /*
       * NO NAME ENQUIRY EXISTS FOR A WALLET, and pretending otherwise is the
       * one thing this must not do. A resolver that answered the sender's own
       * text would turn the confirmation screen into a mirror, which is worse
       * than no confirmation because it looks like one.
       */
      throw new ProviderRejectedError(
        PROVIDER,
        'a mobile money wallet has no name enquiry; confirm the network and the number',
        'name_unavailable',
      );
    }

    const body = await this.#client.request('POST', FLUTTERWAVE_ENDPOINTS.resolveAccount, {
      account_number: accountNumber,
      account_bank: bankCode,
    });
    const parsed = resolveResponse.safeParse(body);
    if (!parsed.success || parsed.data.data === undefined) {
      // An unknown account and an unreachable bank answer the same way, which
      // is 043's rule: distinguishing them maps which numbers are live where.
      throw new ProviderRejectedError(
        PROVIDER,
        parsed.success ? (parsed.data.message ?? 'could not resolve that account') : parsed.error.message,
        'unknown_account',
      );
    }
    return {
      accountNumber,
      bankCode,
      accountName: parsed.data.data.account_name,
    };
  }

  async send<C extends Currency>(request: PayoutRequest<C>): Promise<PayoutReceipt> {
    const body = await this.#client.request('POST', FLUTTERWAVE_ENDPOINTS.transfers, {
      account_bank: request.bankCode,
      account_number: request.accountNumber,
      amount: majorText(request.amount.amount, request.amount.currency),
      currency: request.amount.currency,
      /*
       * WHAT WE ARE DEBITED IN, stated rather than inferred.
       *
       * Left out, Flutterwave picks a balance — and on a multi-currency
       * account that can mean funding a cedi payout from the naira balance at
       * a rate nobody chose. That is the same silent conversion this whole
       * migration exists because of, in the outbound direction.
       */
      debit_currency: request.amount.currency,
      ...(request.narration === undefined ? {} : { narration: request.narration }),
      /* OURS, derived from the customer's key. Their side de-duplicates on
       * it, so a retry after a timeout is one payout at their end too — and
       * on this operation a duplicate cannot be clawed back. */
      reference: request.reference,
      /*
       * OMITTED ENTIRELY WHERE THERE IS NO NAME, rather than sent empty.
       *
       * A mobile money wallet has no name enquiry on any network, so there is
       * nothing to send — and the one thing this adapter must never do is put
       * the sender's own text in this field, which would appear on the
       * recipient's side as a confirmed name that nobody confirmed.
       */
      ...(request.accountName === undefined || request.accountName.trim() === ''
        ? {}
        : { beneficiary_name: request.accountName }),
    });

    const parsed = transferResponse.safeParse(body);
    if (!parsed.success || parsed.data.data === undefined) {
      throw new ProviderContractError(PROVIDER, 'unexpected /v3/transfers response');
    }
    return receiptOf(parsed.data.data);
  }

  async status(providerPayoutId: string): Promise<PayoutReceipt> {
    const body = await this.#client.request(
      'GET',
      FLUTTERWAVE_ENDPOINTS.getTransfer(providerPayoutId),
    );
    const parsed = transferResponse.safeParse(body);
    if (!parsed.success || parsed.data.data === undefined) {
      throw new ProviderContractError(PROVIDER, 'unexpected /v3/transfers/:id response');
    }
    return receiptOf(parsed.data.data);
  }
}

/**
 * Their transfer state, as the port's three.
 *
 * AN UNRECOGNISED STATE IS `sent`, NOT `failed`, and that asymmetry is
 * deliberate. Reading an unknown word as failed reverses a payout that may
 * already be in somebody's wallet; reading it as still-in-flight leaves the
 * money held and `bank_payouts_stuck` counting it until a person looks. One
 * of those is recoverable.
 */
function receiptOf(data: {
  id: number | string;
  status: string;
  complete_message?: string | null | undefined;
}): PayoutReceipt {
  const state = data.status.trim().toUpperCase();
  const failureReason = data.complete_message ?? undefined;
  if (state === 'SUCCESSFUL') return { providerPayoutId: String(data.id), state: 'completed' };
  if (state === 'FAILED') {
    return {
      providerPayoutId: String(data.id),
      state: 'failed',
      ...(failureReason === undefined ? {} : { failureReason }),
    };
  }
  return { providerPayoutId: String(data.id), state: 'sent' };
}

function majorText(amountMinor: bigint, currency: string): string {
  if (!isCurrency(currency)) {
    throw new ProviderContractError(PROVIDER, `not a currency this platform knows: ${currency}`);
  }
  return toMajor(money(amountMinor, currency));
}
