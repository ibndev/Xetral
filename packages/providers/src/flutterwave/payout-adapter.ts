import { z } from 'zod';
import { isCurrency, money, toMajor } from '@xetral/shared';
import type { Currency } from '@xetral/shared';
import { ProviderContractError, ProviderRejectedError } from '../ports/errors.js';
import type {
  BeneficiaryLookup,
  PayoutBank,
  PayoutBranch,
  PayoutMethod,
  PayoutPort,
  PayoutReceipt,
  PayoutRequest,
} from '../ports/payout.js';
import { FLUTTERWAVE_ENDPOINTS, type FlutterwaveClient } from './client.js';
import { FLUTTERWAVE_V4_ENDPOINTS, type FlutterwaveV4Client } from './v4-client.js';

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
 * WHERE A WALLET NUMBER CAN BE RESOLVED TO A NAME, AND ON WHICH API VERSION.
 *
 * THIS FILE HAS NOW BEEN WRONG ABOUT THIS TWICE, IN OPPOSITE DIRECTIONS.
 *
 * First it asserted that NO mobile money wallet has a name enquiry, and threw
 * without calling anything. Then — two rounds ago, on the strength of a
 * SEARCH SNIPPET rather than a specification — it asserted that v3's
 * `/accounts/resolve` accepts Ghanaian mobile money numbers, and called it.
 * Both were guesses and the second replaced one wrong belief with another.
 *
 * FLUTTERWAVE'S OWN v3 SPECIFICATION SETTLES IT. `POST /v3/accounts/resolve`
 * is described as: "Resolve a BANK ACCOUNT number ... Requires account_number
 * (10 digits) and account_bank (bank code). account_bank: Bank code (3
 * DIGITS)." We were sending `MTN` and a twelve-digit phone number. THERE IS
 * NO MOBILE MONEY IN v3'S RESOLVER AT ALL, so no spelling of either field was
 * ever going to work — which is why the previous round's careful two-shape
 * retry changed nothing.
 *
 * THE WALLET RESOLVER IS IN v4: `POST /wallet-account/resolve`, taking
 * `{ account_number, mobile_network, country }`, beside a separate
 * `/bank-account/resolve`. Two endpoints, because they are two questions.
 * `FlutterwaveV4Client` is how this adapter asks it; money still moves on v3.
 *
 * SO THIS SET IS NOW ABOUT THE PRODUCT, NOT THE ENDPOINT: which countries'
 * wallets Flutterwave will name at all. Kenya's M-PESA is absent from what
 * they resolve, so `name_unavailable` remains the true answer there — 043's
 * rule holds where it applies, and what was wrong was applying it everywhere.
 */
const RESOLVES_MOBILE_MONEY: ReadonlySet<string> = new Set(['GH']);

/**
 * WHERE A TRANSFER CARRIES A BRANCH CODE.
 *
 * FLUTTERWAVE, VERBATIM: "When transferring to Ghanaian bank accounts and
 * mobile money wallets, you need to pass the branch code of the institution or
 * telco in your Initiate Transfer request as destination_branch_code."
 *
 * A TABLE RATHER THAN A RULE, for the reason this file has now relearned
 * twice: the countries that need one are a fact about Flutterwave's Ghanaian
 * integration, not something derivable from anything else here. Nigeria and
 * Kenya do not, and sending an empty one would be a field their API has to
 * decide what to do with.
 */
const REQUIRES_BRANCH_CODE: ReadonlySet<string> = new Set(['GH']);

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
  data: z
    .array(
      z.object({
        /* THE BANK'S OWN ID, which is NOT its code and is what the branches
           call takes as a path parameter. Dropping it — which this schema did
           — made Ghanaian branch codes unreachable, and a Ghanaian transfer
           without one is refused. */
        id: z.union([z.number(), z.string()]).optional(),
        code: z.string().min(1),
        name: z.string().min(1),
      }),
    )
    .optional(),
});

const branchesResponse = z.object({
  status: z.string().optional(),
  data: z
    .array(
      z.object({
        branch_code: z.string().min(1),
        branch_name: z.string().min(1),
      }),
    )
    .optional(),
});

/**
 * v4'S WALLET RESOLVER, AND WHY THE READ IS TOLERANT.
 *
 * Their published schema answers `{ account_number, account_name,
 * mobile_network, country }` at the top level; several of their surfaces wrap
 * a payload in `data`. Accepting both costs nothing on a READ and being wrong
 * costs every Ghanaian send — the call `card-adapter.ts` already makes about
 * Bitnob's two card shapes.
 */
const walletResolveResponse = z.object({
  account_name: z.string().min(1).optional(),
  data: z.object({ account_name: z.string().min(1) }).optional(),
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
  /**
   * v4, FOR ONE READ. Optional because a deployment that has not pasted the
   * v4 credentials still pays out perfectly on v3 — it just cannot name a
   * wallet, which the screen handles by asking for a label.
   */
  readonly #v4: FlutterwaveV4Client | undefined;
  constructor(client: FlutterwaveClient, v4?: FlutterwaveV4Client) {
    this.#client = client;
    this.#v4 = v4;
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
    return parsed.data.data.map((bank) => ({
      code: bank.code,
      name: bank.name,
      ...(bank.id === undefined ? {} : { id: String(bank.id) }),
    }));
  }

  /**
   * THE BRANCHES OF ONE BANK, and Ghana cannot be paid without one.
   *
   * FLUTTERWAVE, VERBATIM: "When transferring to Ghanaian bank accounts and
   * mobile money wallets, you need to pass the branch code of the institution
   * or telco in your Initiate Transfer request as destination_branch_code."
   *
   * 070 gave Ghana a bank rail and every transfer on it would have been
   * refused without this — a whole product added and immediately broken, for a
   * field nothing in this package had ever heard of. Found by reading their
   * specification rather than by a customer reporting it, which is the only
   * part of the last five rounds that went differently.
   *
   * `bankId` IS NOT `bankCode`. Their bank list answers `{ id, code, name }`
   * and the branches path takes the ID; this adapter's schema used to drop it
   * entirely, which is what made the branch codes unreachable.
   */
  async branches(country: string, bankId: string): Promise<readonly PayoutBranch[]> {
    const iso = country.trim().toUpperCase();
    if (!REQUIRES_BRANCH_CODE.has(iso)) return [];

    const body = await this.#client.request(
      'GET',
      FLUTTERWAVE_ENDPOINTS.branches(bankId),
    );
    const parsed = branchesResponse.safeParse(body);
    if (!parsed.success || parsed.data.data === undefined) {
      throw new ProviderContractError(PROVIDER, `unexpected /v3/banks/${bankId}/branches response`);
    }
    return parsed.data.data.map((branch) => ({
      code: branch.branch_code,
      name: branch.branch_name,
    }));
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
     * A WALLET GOES TO v4 AND A BANK ACCOUNT STAYS ON v3, because those are
     * the two endpoints that exist.
     *
     * The previous round tried the number in two spellings against v3 and
     * recorded every refusal, which was a careful answer to the wrong
     * question: v3's resolver is bank-shaped and a mobile money number is not
     * a bank account however it is written. The trail that work built is kept
     * — `cause` still carries what was tried and what was said — because 069's
     * point stands: a refusal nobody can read is a refusal nobody can fix.
     */
    if (isWallet) {
      if (this.#v4 === undefined || !(await this.#v4.configured())) {
        /*
         * NOBODY HAS PASTED THE v4 CREDENTIALS, which is not the same as the
         * rail refusing — and the difference decides whether a customer can
         * send at all. `name_unavailable` means a name was never obtainable,
         * so the screen asks for a label and the send proceeds, exactly as it
         * does in Kenya. Reporting this as `unknown_account` would block every
         * Ghanaian send on a credential the customer cannot paste.
         */
        throw new ProviderRejectedError(
          PROVIDER,
          'this deployment has no Flutterwave v4 client id and secret, so a ' +
            'mobile money wallet cannot be named. Paste both on the Provider ' +
            'keys screen.',
          'name_unavailable',
        );
      }

      let message = 'could not resolve that wallet';
      try {
        const body = await this.#v4.request('POST', FLUTTERWAVE_V4_ENDPOINTS.resolveWallet, {
          account_number: accountNumber,
          mobile_network: bankCode,
          country: iso,
        });
        const parsed = walletResolveResponse.safeParse(body);
        const name = parsed.success ? (parsed.data.data?.account_name ?? parsed.data.account_name) : undefined;
        if (name !== undefined && name !== '') {
          return { accountNumber, bankCode, accountName: name };
        }
        message = parsed.success ? 'the wallet resolver named nobody' : parsed.error.message;
      } catch (error) {
        if (!(error instanceof ProviderRejectedError)) throw error;
        message = error.message;
      }

      throw new ProviderRejectedError(PROVIDER, message, 'unknown_account', {
        keyMode: await this.#client.keyMode(),
        tried: [`v4 /wallet-account/resolve ${iso}/${bankCode}/${shape(accountNumber)}: ${message}`],
      });
    }

    /*
     * A BANK ACCOUNT, ON v3, WHICH IS WHAT THAT ENDPOINT IS FOR. `account_bank`
     * is the bank code from `/v3/banks/:country` and `account_number` is the
     * account exactly as typed — a NUBAN has no dialling code and an account
     * beginning with a zero is an ordinary account.
     */
    let lastMessage = 'could not resolve that account';
    try {
      const body = await this.#client.request('POST', FLUTTERWAVE_ENDPOINTS.resolveAccount, {
        account_number: accountNumber,
        account_bank: bankCode,
      });
      const parsed = resolveResponse.safeParse(body);
      if (parsed.success && parsed.data.data !== undefined) {
        return { accountNumber, bankCode, accountName: parsed.data.data.account_name };
      }
      lastMessage = parsed.success
        ? (parsed.data.message ?? lastMessage)
        : `unexpected /v3/accounts/resolve response: ${parsed.error.message}`;
    } catch (error) {
      if (!(error instanceof ProviderRejectedError)) throw error;
      lastMessage = error.message;
    }

    /*
     * An unknown account and an unreachable bank answer the SAME WAY to the
     * customer — 043's rule, and distinguishing them maps which numbers are
     * live where. The detail does not evaporate: `cause` carries what was
     * tried and what was said, and the payout service writes it to
     * `name_enquiry_refusals` where an operator can read it.
     */
    throw new ProviderRejectedError(PROVIDER, lastMessage, 'unknown_account', {
      keyMode: await this.#client.keyMode(),
      tried: [`v3 /accounts/resolve ${bankCode}/${shape(accountNumber)}: ${lastMessage}`],
    });
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
      /*
       * GHANA REFUSES A TRANSFER WITHOUT ONE, and 070 gave Ghana a bank rail
       * that would have failed on every single send without this line.
       *
       * FLUTTERWAVE, VERBATIM: "When transferring to Ghanaian bank accounts
       * and mobile money wallets, you need to pass the branch code of the
       * institution or telco in your Initiate Transfer request as
       * destination_branch_code."
       *
       * SPREAD RATHER THAN SENT EMPTY. Every other corridor has no branch
       * code, and an empty string is a field their API has to decide what to
       * do with — the same reason `narration` is spread rather than defaulted.
       */
      ...(request.branchCode === undefined || request.branchCode === ''
        ? {}
        : { destination_branch_code: request.branchCode }),
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
