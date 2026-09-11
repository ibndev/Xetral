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

/**
 * WHERE A WALLET NUMBER CAN BE RESOLVED TO A NAME, AND WHERE IT CANNOT.
 *
 * THIS FILE SPENT THREE ROUNDS ASSERTING THAT NO MOBILE MONEY WALLET HAS A
 * NAME ENQUIRY. That is false, and it is false in the one country this
 * platform's customers were complaining about. Flutterwave's own
 * documentation for `/v3/accounts/resolve` lists what it accepts: Nigerian
 * bank accounts, Ghanaian bank accounts, GHANAIAN MOBILE MONEY NUMBERS, and a
 * Flutterwave merchant id.
 *
 * So "we cannot find the momo details" was never the provider's answer. The
 * adapter refused to ask: it matched the network code, threw
 * `name_unavailable` and never made the call. Every layer above then did
 * exactly what it was told, correctly, all the way to a screen saying the name
 * could not be found — about a number whose name Flutterwave will return on
 * request. A REFUSAL THIS CODE INVENTED, relayed faithfully by everything
 * downstream, is the hardest kind of fault to see: every component is
 * behaving.
 *
 * KENYA IS NOT ON THAT LIST, and that is the reason this is a table rather
 * than a flag. M-PESA is absent from what resolve accepts, so there
 * `name_unavailable` is the true answer and stays — 043's rule holds where it
 * applies. What was wrong was applying it everywhere.
 */
const RESOLVES_MOBILE_MONEY: ReadonlySet<string> = new Set(['GH']);

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
 * WHETHER A WALLET HAS A NAME TO FETCH IS A TABLE, NOT A RULE — see
 * `RESOLVES_MOBILE_MONEY`. `lookup` ASKS wherever the resolver answers, which
 * includes Ghanaian mobile money numbers, and refuses with `name_unavailable`
 * only where no such call exists. That refusal is told apart from "no such
 * account" because the two mean opposite things to the customer standing in
 * front of it — one is "check the number", the other is "we cannot confirm who
 * this is". The rule 043 states — the name is the RAIL'S, never the sender's —
 * is unchanged: what this adapter will not do is echo back a name the sender
 * typed.
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
    const isWallet = networks?.some((n) => n.code === bankCode) === true;

    if (isWallet && !RESOLVES_MOBILE_MONEY.has(iso)) {
      /*
       * WHERE THERE GENUINELY IS NO CALL TO MAKE. M-PESA is not among what
       * `/v3/accounts/resolve` accepts, so this is the provider's real
       * position rather than this adapter's assumption — and the one thing
       * that must not happen here is answering with the sender's own text,
       * which is a confirmation screen that confirms nothing while looking
       * exactly like one.
       */
      throw new ProviderRejectedError(
        PROVIDER,
        `a ${iso} mobile money wallet has no name enquiry; confirm the network and the number`,
        'name_unavailable',
      );
    }

    /*
     * THE SAME TWO FIELDS FOR BOTH, which is why one call serves both rails.
     * For a bank, `account_bank` is the bank code and `account_number` is the
     * account. For a Ghanaian wallet, `account_bank` is the NETWORK code and
     * `account_number` is the number IN INTERNATIONAL FORM — `233…`, which is
     * what `phone.ts` produces and what the row already records.
     */
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
       * WHICH BALANCE FUNDS THIS, and the comment that used to sit here was
       * backwards in a way that mattered.
       *
       * It said "left out, Flutterwave picks a balance". They do not pick:
       * they DEBIT THE BALANCE MATCHING THE PAYOUT CURRENCY. So echoing the
       * payout currency here is not a safety measure, it is the default
       * written out — and it PINS the transfer to a GHS float this platform
       * may not hold, on a provider that is a prefunded wallet rather than a
       * rail that moves money on demand.
       *
       * Naming a DIFFERENT currency is what the field is actually for: debit
       * naira, pay out cedis, at Flutterwave's own conversion rate. That
       * trades a float for a rate somebody else sets, which is a treasury
       * decision — so it comes from a setting and this file states whatever
       * it is told.
       */
      debit_currency: request.debitCurrency ?? request.amount.currency,
      ...(request.narration === undefined ? {} : { narration: request.narration }),
      /* OURS, derived from the customer's key. Their side de-duplicates on
       * it, so a retry after a timeout is one payout at their end too — and
       * on this operation a duplicate cannot be clawed back. */
      reference: request.reference,
      /*
       * REQUIRED ON EVERY TRANSFER, INCLUDING A WALLET — and omitting it was a
       * rule about our SCREENS applied to their WIRE FORMAT.
       *
       * Flutterwave's mobile money transfer documentation says it plainly: "a
       * beneficiary_name is also required so we can identify this account in
       * your list of beneficiaries", and their own SDK docs quote
       * `beneficiary_name is required` as a FAILED TRANSFER RESPONSE. It is a
       * LABEL on their beneficiary book, not a claim about who holds the
       * wallet.
       *
       * 043's rule is about what a SENDER is shown: never present the sender's
       * own typed name back to them as though a rail confirmed it. Labelling a
       * transfer does not do that. Conflating the two removed a required field
       * and would have had every momo payout refused for validation — which is
       * the opposite of the fault it was meant to fix.
       */
      beneficiary_name: beneficiaryLabel(request),
      /*
       * WHO SENT IT, where the corridor asks. Kenya's M-PESA payout is a
       * cross-border remittance and is refused without the originator named.
       */
      ...(request.sender === undefined
        ? {}
        : {
            meta: {
              sender: request.sender.name,
              sender_country: request.sender.country,
              mobile_number: request.sender.phone,
            },
          }),
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

/**
 * What goes in `beneficiary_name`, which is a required field on every transfer.
 *
 * THE RAIL'S OWN ANSWER WHERE THERE IS ONE. Ghana resolves a wallet number to
 * a name and Nigeria resolves an account number, so on both the value here is
 * a claim the sender did not author — which is the whole point of the lookup.
 *
 * WHERE THE RAIL CANNOT ANSWER — Kenya — the field is still required, and the
 * honest thing to put in it is a LABEL rather than a name: the network and the
 * last four digits identify the destination in Flutterwave's beneficiary book
 * without asserting anything about a person. What must never go here is the
 * sender's own typed text, because that is the value somebody would later be
 * tempted to render back on a confirmation screen.
 */
function beneficiaryLabel<C extends Currency>(request: PayoutRequest<C>): string {
  const given = request.accountName?.trim();
  if (given !== undefined && given !== '') return given;
  const last4 = request.accountNumber.slice(-4);
  return `${request.bankCode} ${last4}`.trim();
}

function majorText(amountMinor: bigint, currency: string): string {
  if (!isCurrency(currency)) {
    throw new ProviderContractError(PROVIDER, `not a currency this platform knows: ${currency}`);
  }
  return toMajor(money(amountMinor, currency));
}
