import { z } from 'zod';
import { isCurrency, money, toMajor } from '@xetral/shared';
import type { Currency } from '@xetral/shared';
import { ProviderContractError, ProviderRejectedError } from '../ports/errors.js';
import type {
  BeneficiaryLookup,
  PayoutBank,
  PayoutMethod,
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
    { code: 'VOD', name: 'Telecel Cash' },
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

interface Attempt {
  readonly account_bank: string;
  readonly account_number: string;
}

/**
 * The national spelling of a stored E.164 number — `233553921133` becomes
 * `0553921133`.
 *
 * NOT A CONVERSION FOR ANYTHING THAT MOVES MONEY. `bank_payouts.account_number`
 * is immutable and is what a transfer carries (067), and this never touches
 * it: it exists only so a READ can be asked a second way when the provider
 * refuses the first. Undefined where the number does not start with the
 * country's dialling code, because then it is already national.
 */
const DIAL_CODES: Readonly<Record<string, string>> = { GH: '233', KE: '254', NG: '234' };

function nationalForm(digits: string, iso: string): string | undefined {
  const code = DIAL_CODES[iso];
  if (code === undefined || !digits.startsWith(code)) return undefined;
  const rest = digits.slice(code.length);
  return rest === '' ? undefined : `0${rest}`;
}

/**
 * A number's SHAPE, for the trail — never the number.
 *
 * `233…1133` says which spelling was tried and identifies nobody. A refusals
 * table holding whole mobile numbers would be a list of customers' contacts,
 * which is the thing 016 records about storing less rather than guarding more.
 */
function shape(digits: string): string {
  return digits.length <= 8 ? `${digits.length} digits` : `${digits.slice(0, 3)}…${digits.slice(-4)}`;
}

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
  /** Their catalogue, per country, for the life of the process. */
  readonly #listedBanks = new Map<string, readonly PayoutBank[]>();

  constructor(client: FlutterwaveClient) {
    this.#client = client;
  }

  async banks(country: string, method?: PayoutMethod): Promise<readonly PayoutBank[]> {
    const iso = country.trim().toUpperCase();

    /*
     * THE NETWORKS ARE THE ANSWER WHERE THE CALLER ASKED FOR A WALLET.
     *
     * It used to be "where there ARE networks", full stop — which meant a
     * country with a mobile money rail could never be asked for its banks at
     * all, and Ghana's and Kenya's bank lists were unreachable through this
     * adapter. Returning banks to somebody choosing a wallet is 046's failure;
     * returning WALLETS to somebody who asked for a bank is the same failure
     * with the sides swapped, and one of the two had to be a parameter.
     *
     * Undefined still means the wallet list where one exists, because that is
     * what every caller written before 070 meant.
     */
    const networks = FLUTTERWAVE_MOBILE_MONEY_NETWORKS[iso];
    if (networks !== undefined && method !== 'bank') return networks;

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
     * A LOOKUP IS A READ, SO IT MAY BE ASKED MORE THAN ONE WAY — and that is
     * the difference between this and every other call in this package.
     *
     * ROUND FOUR ON ONE COMPLAINT, and the reason it kept coming back is that
     * ONE payload shape was ASSERTED and its refusal was thrown away. The
     * previous round fixed the adapter's refusal to ask; a Ghanaian number
     * then reached `/v3/accounts/resolve`, Flutterwave said no, and the
     * sentence it said no WITH reached no log line, no table and no screen.
     * Three rounds of "it cannot find the momo details" with no recorded
     * evidence anywhere of what the provider actually answered.
     *
     * So this stops asserting a shape. It tries the ones that can be true,
     * in order, and CARRIES EVERY REFUSAL OUT on the error so the caller can
     * write them down:
     *
     *   1. the number as stored — E.164 digits, `233553921133`, which is what
     *      `phone.ts` produces and what a transfer carries;
     *   2. the NATIONAL form, `0553921133` — how the number is written in
     *      Accra, and the shape their own Ghanaian examples use;
     *   3. the operator's code AS FLUTTERWAVE LISTS IT, if `/v3/banks/GH`
     *      names it differently from the code a TRANSFER takes. A transfer
     *      code and a resolve code being the same string is an assumption,
     *      and it is exactly the class of assumption this file has now been
     *      wrong about twice.
     *
     * Bounded at four calls, none of which moves money, and only reached on a
     * path that is otherwise refusing every customer. A TRANSFER would never
     * be retried this way — one is how a payout becomes two.
     */
    const attempts: Attempt[] = [{ account_bank: bankCode, account_number: accountNumber }];
    const national = nationalForm(accountNumber, iso);
    if (isWallet && national !== undefined) {
      attempts.push({ account_bank: bankCode, account_number: national });
    }

    const tried: string[] = [];
    let lastMessage = 'could not resolve that account';

    for (let index = 0; index < attempts.length; index += 1) {
      const attempt = attempts[index]!;
      try {
        const body = await this.#client.request(
          'POST',
          FLUTTERWAVE_ENDPOINTS.resolveAccount,
          attempt,
        );
        const parsed = resolveResponse.safeParse(body);
        if (parsed.success && parsed.data.data !== undefined) {
          return {
            accountNumber,
            bankCode,
            accountName: parsed.data.data.account_name,
          };
        }
        lastMessage = parsed.success
          ? (parsed.data.message ?? lastMessage)
          : `unexpected /v3/accounts/resolve response: ${parsed.error.message}`;
      } catch (error) {
        // A refusal is an answer and the next shape may be accepted. Anything
        // else — unreachable, timed out, a broken contract — is not about the
        // shape at all and must not be re-sent under another spelling.
        if (!(error instanceof ProviderRejectedError)) throw error;
        lastMessage = error.message;
      }
      tried.push(`${attempt.account_bank}/${shape(attempt.account_number)}: ${lastMessage}`);

      /*
       * ASK FLUTTERWAVE WHAT THEY CALL THIS OPERATOR, once, after their own
       * answer has ruled out the code we hold. Their list is data from the
       * provider rather than another constant of ours — which is the whole
       * lesson this package records twice about plausible tables.
       */
      if (isWallet && index === attempts.length - 1 && !tried.some((t) => t.startsWith('listed:'))) {
        const listed = await this.#listedCodeFor(iso, bankCode);
        if (listed !== undefined && listed !== bankCode) {
          attempts.push({ account_bank: listed, account_number: accountNumber });
          tried.push(`listed: ${iso} names this operator ${listed}`);
        }
      }
    }

    /*
     * An unknown account and an unreachable bank answer the SAME WAY to the
     * customer — 043's rule, and distinguishing them maps which numbers are
     * live where. What changes here is that the detail no longer evaporates:
     * `cause` carries every shape tried and what the provider said to each,
     * and the payout service writes that to `name_enquiry_refusals` where an
     * operator can read it. The customer still gets a code.
     */
    throw new ProviderRejectedError(PROVIDER, lastMessage, 'unknown_account', {
      keyMode: await this.#client.keyMode(),
      tried,
    });
  }

  /**
   * The code Flutterwave's OWN `/v3/banks/:country` list gives this operator.
   *
   * Cached for the life of the process: it is a catalogue, it changes rarely,
   * and this is reached only after a refusal. `undefined` when their list does
   * not name the operator at all — in which case the code we hold is the only
   * one there is, and saying so in the trail is worth more than another guess.
   */
  async #listedCodeFor(iso: string, networkCode: string): Promise<string | undefined> {
    const network = FLUTTERWAVE_MOBILE_MONEY_NETWORKS[iso]?.find((n) => n.code === networkCode);
    if (network === undefined) return undefined;
    try {
      let listed = this.#listedBanks.get(iso);
      if (listed === undefined) {
        const body = await this.#client.request('GET', FLUTTERWAVE_ENDPOINTS.banks(iso));
        const parsed = banksResponse.safeParse(body);
        listed = parsed.success ? (parsed.data.data ?? []) : [];
        this.#listedBanks.set(iso, listed);
      }
      // Matched on the FIRST WORD of the operator's name — "MTN Mobile Money"
      // against "MTN MOBILE MONEY GHANA" — because a catalogue string is
      // never the name in our table and an equality match would find nothing.
      const first = (network.name.split(/\s+/)[0] ?? '').toLowerCase();
      return listed.find((bank) => bank.name.toLowerCase().startsWith(first))?.code;
    } catch {
      // Learning the code is a courtesy on a path that is already failing; a
      // second failure must not replace the provider's own sentence about the
      // lookup with one about a bank list.
      return undefined;
    }
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
