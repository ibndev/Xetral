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
 * THE TELCO CODES `/v3/accounts/resolve` WILL ACCEPT, per country.
 *
 * FLUTTERWAVE'S OWN DOCUMENTATION FOR THAT ENDPOINT LISTS FOUR THINGS IT
 * RESOLVES: Nigerian bank accounts, Ghanaian bank accounts, GHANAIAN MOBILE
 * MONEY NUMBERS, and Flutterwave merchant IDs. For a wallet you pass the
 * TELCO as `account_bank` and the phone number as `account_number`:
 *
 *     { "account_number": "0551234987", "account_bank": "MTN",
 *       "country": "GH" }
 *
 * WHY THIS IS A LIST RATHER THAN ONE STRING. AirtelTigo has been rebranding
 * — Telecel took over Vodafone Ghana — and Flutterwave's own surfaces are
 * inconsistent about which spelling they accept. `MTN`, `VODAFONE`, `TIGO`
 * and `AIRTEL` are the documented four; the codes this platform holds in
 * `FLUTTERWAVE_MOBILE_MONEY_NETWORKS` are what a TRANSFER takes. Where those
 * differ the resolve must use the resolver's spelling, and a wrong one is a
 * refusal that reads to a customer as their own number being wrong.
 *
 * AND THE LIVE BANK LIST IS CONSULTED FIRST. `GET /v3/banks/GH` is the only
 * thing that can settle this against the account actually being used, which
 * is why `#telcoCandidates` reads it before falling back to this table. A
 * constant here is a starting point; their answer is the authority.
 */
const RESOLVE_TELCO_ALIASES: Readonly<Record<string, readonly string[]>> = {
  MTN: ['MTN'],
  /* Vodafone Ghana is Telecel now. Both spellings are tried because the
     rebrand has not reached every one of their surfaces. */
  VOD: ['VODAFONE', 'TELECEL', 'VOD'],
  /* AirtelTigo, from the Airtel and Tigo merger — hence two documented
     codes for one network. */
  ATL: ['AIRTELTIGO', 'TIGO', 'AIRTEL', 'ATL'],
};

/**
 * A COUNTRY'S DIALLING CODE, because the two calls want the number written
 * DIFFERENTLY and that difference is a documented source of "invalid
 * account".
 *
 * `/v3/accounts/resolve` takes the LOCAL form — `0551234987`, how a number is
 * written in Accra. `/v3/transfers` takes the INTERNATIONAL digits —
 * `233551234987`. Copying one string between the two calls is exactly the
 * mistake this table exists to stop, and 067 already records the transfer
 * half: a trunk zero reaches their transfers API as a sentence about an
 * invalid account, which reads to the customer as their own number.
 *
 * Only countries whose wallets this platform resolves need an entry; a
 * missing one means the number is tried as it arrived, which is the same
 * behaviour as before this existed.
 */
const DIAL_CODES: Readonly<Record<string, string>> = { GH: '233', KE: '254', NG: '234' };

/**
 * The LOCAL form of an international number, for the resolver.
 *
 * Returns undefined rather than guessing when the number does not begin with
 * the country's dialling code — a number already in local form, or one from
 * somewhere else, must be tried as it arrived rather than mangled. 067's
 * rule, pointed the other way: a number that cannot be converted is passed
 * through, never invented.
 */
function localForm(iso: string, digits: string): string | undefined {
  const dial = DIAL_CODES[iso];
  if (dial === undefined || !digits.startsWith(dial)) return undefined;
  return `0${digits.slice(dial.length)}`;
}

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

/**
 * A failure, in a few words, for the trail.
 *
 * NEVER THE WHOLE ERROR. A provider's own sentence names our integration —
 * 006's rule — and this string reaches `name_enquiry_refusals`, which an
 * operator reads and a customer never does. The class name plus the message
 * is what says "timeout" against "their API changed", which is the only
 * distinction anybody acts on here.
 */
function describeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return 'unknown failure';
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

/**
 * v4'S OWN LIST OF NETWORKS, which is how `mobile_network` stops being a guess.
 *
 * Every field is optional because the only thing this adapter needs from a row
 * is a value to send, and a row that carries one of the two is still useful. A
 * list that parses to nothing is not a contract error either: it means the
 * translation is unavailable, which falls back to the code we already hold.
 */
interface MobileNetworkRow {
  readonly code?: string;
  readonly id?: string;
  readonly name?: string;
}

const mobileNetworkList = z.object({
  data: z
    .array(
      z.object({
        id: z.union([z.number(), z.string()]).optional(),
        code: z.string().min(1).optional(),
        name: z.string().min(1).optional(),
      }),
    )
    .optional(),
});

/**
 * WHICH v4 REFUSALS ARE THE RAIL'S VERDICT ABOUT A WALLET, and which are ours.
 *
 * THIS DISTINCTION IS THE WHOLE FIX, and its absence is what the last round
 * shipped. `lookup` answering `unknown_account` makes the Send screen REFUSE
 * to continue — which is correct for "that wallet belongs to nobody" and is an
 * OUTAGE for "our client id is wrong". Collapsed together, pasting a v4
 * credential that does not work turned Ghana from a corridor that sent with a
 * label into one that could not send at all, and told every customer their own
 * number was the problem.
 *
 *   404, 422, or a 200 naming nobody   the resolver understood and could not
 *                                      name this wallet. THE RAIL'S VERDICT.
 *   anything else                      400 malformed, 401/403 credentials,
 *                                      5xx, a timeout, a non-JSON body, or no
 *                                      credentials at all. WE COULD NOT ASK.
 *
 * A 400 is the borderline one and it is deliberately on the "ours" side: it
 * means the request was malformed, and the request is the part we wrote.
 */
const RAIL_VERDICT_STATUSES: ReadonlySet<string> = new Set(['http_404', 'http_422']);

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
  /**
   * v4's network list per country, fetched once.
   *
   * THE PROMISE IS CACHED, NOT THE RESULT, so two lookups racing on mount make
   * one call — the single-flight rule `Session.refresh()` follows. A failed
   * fetch is cached too and deliberately: the fallback is the code we already
   * hold, and a country whose list cannot be read must not re-ask on every
   * keystroke of a phone number.
   */
  readonly #networks = new Map<string, Promise<readonly MobileNetworkRow[]>>();

  constructor(client: FlutterwaveClient, v4?: FlutterwaveV4Client) {
    this.#client = client;
    this.#v4 = v4;
  }

  /**
   * WHAT TO PUT IN `mobile_network`, ASKED OF FLUTTERWAVE RATHER THAN ASSUMED.
   *
   * Returns the candidates in order, most likely first: the code this platform
   * already holds (`MTN`), then their own list's code and id for the matching
   * network. Duplicates are dropped, so where their code equals ours — the
   * expected case — this is exactly one call.
   *
   * IT NEVER THROWS. A network list that cannot be read is not a reason to
   * refuse a lookup; the code we hold is the fallback, and 059's rule is that
   * a missing route falls through rather than turning one absent row into an
   * outage on the screen customers send money from.
   */
  /**
   * WHICH SPELLING OF THE TELCO `/v3/accounts/resolve` WILL ACCEPT, asked of
   * Flutterwave before it is assumed.
   *
   * `GET /v3/banks/:country` is the list their own resolver is keyed to, so a
   * Ghanaian entry whose NAME contains the network is the authoritative
   * spelling for that account. The documented aliases follow, then the code
   * this platform uses for transfers — most likely last, because a transfer
   * code and a resolve code are not promised to be the same string.
   *
   * IT NEVER THROWS. A bank list that cannot be read is not a reason to
   * refuse a lookup; the aliases are the fallback, and 059's rule is that a
   * missing row falls through rather than turning one outage into another.
   */
  async #telcoCandidates(iso: string, ourCode: string): Promise<readonly string[]> {
    const out: string[] = [];
    const add = (value: string | undefined): void => {
      if (value !== undefined && value !== '' && !out.includes(value)) out.push(value);
    };

    const aliases = RESOLVE_TELCO_ALIASES[ourCode.toUpperCase()] ?? [];
    try {
      const body = await this.#client.request('GET', FLUTTERWAVE_ENDPOINTS.banks(iso));
      const parsed = banksResponse.safeParse(body);
      for (const bank of parsed.success ? (parsed.data.data ?? []) : []) {
        const name = bank.name.toUpperCase();
        /* Matched on the NAME rather than the code, because the whole question
           is what their code for this network is. */
        if (aliases.some((a) => name.includes(a)) || name.includes(ourCode.toUpperCase())) {
          add(bank.code);
        }
      }
    } catch {
      /* Best effort, by design — see the doc comment above. */
    }

    for (const alias of aliases) add(alias);
    add(ourCode);
    return out;
  }

  async #networkValues(iso: string, ourCode: string): Promise<readonly string[]> {
    const listed = await this.#networkList(iso);
    const match = listed.find(
      (n) =>
        n.code?.toUpperCase() === ourCode.toUpperCase() ||
        n.name?.toUpperCase().includes(ourCode.toUpperCase()) === true,
    );
    const out = [ourCode];
    for (const value of [match?.code, match?.id]) {
      if (value !== undefined && value !== '' && !out.includes(value)) out.push(value);
    }
    return out;
  }

  async #networkList(iso: string): Promise<readonly MobileNetworkRow[]> {
    const v4 = this.#v4;
    if (v4 === undefined) return [];

    const cached = this.#networks.get(iso);
    if (cached !== undefined) return cached;

    const pending = (async (): Promise<readonly MobileNetworkRow[]> => {
      try {
        const body = await v4.request('GET', FLUTTERWAVE_V4_ENDPOINTS.mobileNetworks(iso));
        const parsed = mobileNetworkList.safeParse(body);
        if (!parsed.success) return [];
        return (parsed.data.data ?? []).map((n) => ({
          ...(n.code === undefined ? {} : { code: n.code }),
          ...(n.id === undefined ? {} : { id: String(n.id) }),
          ...(n.name === undefined ? {} : { name: n.name }),
        }));
      } catch {
        /* Best effort, by design — see the doc comment above. */
        return [];
      }
    })();
    this.#networks.set(iso, pending);
    return pending;
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
      /*
       * THE WALLET RESOLVER IS `/v3/accounts/resolve`, AND THIS FILE HAS NOW
       * BEEN WRONG ABOUT IT IN BOTH DIRECTIONS.
       *
       * It first asserted that no mobile money wallet has a name enquiry and
       * threw without calling anything. It then read a vendored v3 spec that
       * describes the endpoint as a BANK-account lookup and moved the whole
       * thing to v4. Flutterwave's own documentation for `/v3/accounts/resolve`
       * lists what it resolves and GHANAIAN MOBILE MONEY NUMBERS are on that
       * list: the telco goes in `account_bank`, the phone number in
       * `account_number`, and `country` says GH.
       *
       * SO v3 IS THE PATH AND v4 IS THE FALLBACK, not the other way round.
       * v3 needs only the secret key this deployment already has, which is
       * also why it is tried first: v4 needs a credential pair somebody must
       * go and generate, and a corridor that works should not wait on one.
       *
       * TWO THINGS VARY AND BOTH ARE READ FROM THEM RATHER THAN ASSERTED —
       * the telco's spelling, settled against `GET /v3/banks/GH`, and the
       * number's form, because the resolver takes the LOCAL spelling and the
       * transfer takes the international digits. Every attempt is recorded,
       * so the trail says which pair answered instead of leaving the next
       * round to guess.
       */
      const telcos = await this.#telcoCandidates(iso, bankCode);
      const numbers = [localForm(iso, accountNumber), accountNumber].filter(
        (n): n is string => n !== undefined,
      );
      const tried: string[] = [];
      let verdict = false;

      outer: for (const telco of telcos) {
        for (const number of numbers) {
          try {
            const body = await this.#client.request('POST', FLUTTERWAVE_ENDPOINTS.resolveAccount, {
              account_number: number,
              account_bank: telco,
              country: iso,
            });
            const parsed = resolveResponse.safeParse(body);
            const name = parsed.success ? parsed.data.data?.account_name : undefined;
            if (name !== undefined && name !== '') {
              /* THE NUMBER RETURNED IS THE ONE THE TRANSFER WILL CARRY, never
                 the local spelling that happened to resolve — 067's rule that
                 the row records what the rail was GIVEN. */
              return { accountNumber, bankCode, accountName: name };
            }
            tried.push(`v3 resolve ${telco}/${shape(number)}: 200 with no name`);
          } catch (error) {
            if (!(error instanceof ProviderRejectedError)) {
              /*
               * A TIMEOUT, AN OUTAGE OR A CHANGED CONTRACT IS NOT A STATEMENT
               * ABOUT THE CUSTOMER'S NUMBER. Nothing about waiting or retyping
               * fixes it, so it degrades to the answer Kenya already gives:
               * no name, ask for a label. Reported as a refusal it would stop
               * every Ghanaian send on an outage of ours.
               */
              throw new ProviderRejectedError(
                PROVIDER,
                `the wallet resolver could not be reached (${describeError(error)})`,
                'name_unavailable',
                error,
              );
            }
            tried.push(`v3 resolve ${telco}/${shape(number)}: ${error.message}`);
          }
        }
        /* One telco's every spelling of the number refused. Try the next
           telco rather than concluding anything about the wallet. */
        if (tried.length > 24) break outer;
      }

      /*
       * v4, ONLY IF NOBODY ANSWERED AND ONLY IF IT IS CONFIGURED.
       *
       * `POST /wallet-account/resolve` is a real endpoint on a real API and
       * costs nothing to ask once v3 has said no — but it needs its own
       * OAuth2 pair, so most deployments will never reach this branch.
       */
      if (this.#v4 !== undefined && (await this.#v4.configured())) {
        for (const candidate of await this.#networkValues(iso, bankCode)) {
          try {
            const body = await this.#v4.request('POST', FLUTTERWAVE_V4_ENDPOINTS.resolveWallet, {
              account_number: accountNumber,
              mobile_network: candidate,
              country: iso,
            });
            const parsed = walletResolveResponse.safeParse(body);
            const name = parsed.success
              ? (parsed.data.data?.account_name ?? parsed.data.account_name)
              : undefined;
            if (name !== undefined && name !== '') {
              return { accountNumber, bankCode, accountName: name };
            }
            tried.push(`v4 resolve ${candidate}/${shape(accountNumber)}: 200 with no name`);
            verdict = true;
            break;
          } catch (error) {
            if (!(error instanceof ProviderRejectedError)) break;
            tried.push(
              `v4 resolve ${candidate}/${shape(accountNumber)}: ` +
                `${error.providerCode ?? 'refused'} ${error.message}`,
            );
            if (error.providerCode !== undefined && RAIL_VERDICT_STATUSES.has(error.providerCode)) {
              verdict = true;
              break;
            }
          }
        }
      }

      const cause = { keyMode: await this.#client.keyMode(), tried };

      if (verdict) {
        /*
         * THE RAIL ANSWERED AND COULD NOT NAME THIS WALLET. The send stops
         * here, which is the whole point of asking: a mobile money transfer
         * cannot be recalled, and a number nobody has checked is a number
         * nobody has checked.
         */
        throw new ProviderRejectedError(
          PROVIDER,
          tried[tried.length - 1] ?? 'the wallet resolver could not name that number',
          'unknown_account',
          cause,
        );
      }

      /*
       * WE NEVER GOT AN ANSWER ABOUT THE WALLET, so we must not claim one.
       *
       * Reported as `unknown_account` this is a total outage on the corridor
       * WORDED AS the customer's mistake — which is precisely what pasting a
       * credential produced last round. The refusal is recorded either way:
       * `name_enquiry_refusals` is where an operator reads exactly what was
       * sent and exactly what came back.
       */
      throw new ProviderRejectedError(
        PROVIDER,
        tried.length === 0
          ? 'no telco code could be resolved for this country'
          : `the wallet resolver refused every attempt: ${tried.join('; ')}`,
        'name_unavailable',
        cause,
      );
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
