import { ApiError, toApiError } from './errors.js';
import { Session } from './session.js';

/**
 * The typed HTTP surface.
 *
 * Every response type here mirrors what the API actually returns, and every
 * money field is a STRING because that is what the API sends. There is no
 * mapping step that turns one into a number for convenience — the convenience
 * is the whole problem.
 */

/**
 * A country a customer may sign up from.
 *
 * `currency` is what their home screen leads with and what their activity
 * rail starts from. It is one of the currencies the money registry holds —
 * an operator cannot invent one, for the reasons in 040's header.
 */
export interface XetralCountry {
  readonly code: string;
  readonly name: string;
  /** E.164 calling code WITHOUT the plus: '234', '233', '1'. */
  readonly dial_code: string;
  readonly currency: string;
  readonly enabled: boolean;
  /**
   * HOW MONEY LEAVES HERE — 'bank' or 'mobile_money'.
   *
   * The Send screen asks a different question in each: a bank code and a
   * ten-digit account number in Nigeria, a wallet on a phone number in Ghana
   * and Kenya. Optional so an app built against an API that predates 046 does
   * not break; callers fall back to 'bank', which is the conservative answer.
   */
  readonly payout_method?: string;
  /**
   * HOW SOMEBODY HERE PUTS MONEY IN — `virtual_account`, `mobile_money`, or
   * both. Optional so an app built against an API predating 051 does not
   * break; callers fall back to offering nothing rather than offering a
   * Nigerian account number to a customer in Accra, which is the failure
   * this column exists because of.
   */
  readonly funding_methods?: readonly string[];
}

/**
 * NIGERIA, KNOWN LOCALLY, SO THE FIRST PAINT IS NOT EMPTY.
 *
 * `/v1/countries` decides what may be signed up from — that is 040's whole
 * argument, and this constant does not change it. What it fixes is the gap
 * before the answer arrives: the signup form's country control renders its
 * flag and its dialling code from the selected option, and until the fetch
 * resolved there WAS no option, so the field showed a placeholder and an
 * empty `+` on the screen every new customer opens. A Nigerian handset user
 * was being asked to find their own country in a list that had not loaded.
 *
 * It is also what happens when the call FAILS. Before, an unreachable list
 * left a form that could not be submitted at all; now it falls back to the
 * country this platform was built for, and the server still refuses a
 * registration naming a country it is not open in — the check that matters
 * has not moved.
 *
 * The moment the real list arrives it replaces this entirely, including
 * Nigeria's own row, so a dialling code corrected in the database is the one
 * on screen.
 */
export const FALLBACK_COUNTRY: XetralCountry = {
  code: 'NG',
  name: 'Nigeria',
  dial_code: '234',
  currency: 'NGN',
  enabled: true,
  payout_method: 'bank',
  funding_methods: ['virtual_account'],
};

/**
 * A PHONE NUMBER IN THE ONE SHAPE THE SERVER STORES.
 *
 * `users.phone` is E.164 — the country's dialling code and the national
 * digits, with the trunk zero dropped — because a plain unique index on text
 * cannot see that `+2348031234567`, `2348031234567` and `08031234567` are one
 * person. Registration builds it that way server-side.
 *
 * PAYING SOMEBODY BY PHONE HAS TO BUILD THE SAME STRING, and this is the one
 * place either app does it. A Xetral-to-Xetral transfer resolves the
 * recipient by an exact match on that column, so a sender typing the number
 * the way they have it saved — with the leading zero, the way every Nigerian
 * writes it — was being told there was no such customer. The dial code comes
 * from the picker in front of the field, which is also what says which
 * COUNTRY the money is going to.
 *
 * Everything that is not a digit goes: a pasted number carries spaces,
 * brackets and dashes from a contact card, and none of that is the sender's
 * mistake to fix.
 */
export function e164(dialCode: string, national: string): string {
  const digits = national.replace(/[^0-9]/g, '').replace(/^0+/, '');
  const code = dialCode.replace(/[^0-9]/g, '');
  return digits === '' || code === '' ? '' : `+${code}${digits}`;
}

/**
 * A PHONE NUMBER AS SOMEBODY WOULD READ IT ALOUD, without the country.
 *
 * `users.phone` is E.164 — `+2348031234567` — which is the one shape the
 * server can match on and the wrong shape to show a customer their own
 * number in. A Nigerian says "0803 123 4567" and a Ghanaian says "055 …";
 * neither reads their own country code back to themselves, and a screen that
 * shows one invites them to send it to somebody who then types it whole.
 *
 * The dialling code comes OFF and the national trunk zero does not go back
 * on: what is shown is the significant digits, grouped, which is what fits on
 * a line and what somebody recognises.
 *
 * IT IS FOR DISPLAY ONLY. Anything that resolves a recipient uses the E.164
 * string — see `e164()` — because a national number has no country in it and
 * matching on one across borders would pay a stranger who shares the digits.
 */
export function nationalPhone(phone: string | null | undefined, dialCode?: string): string {
  if (phone === null || phone === undefined || phone === '') return '';
  const digits = phone.replace(/[^0-9]/g, '');
  const code = (dialCode ?? '').replace(/[^0-9]/g, '');
  const national = code !== '' && digits.startsWith(code) ? digits.slice(code.length) : digits;
  // Grouped in threes from the left, which is how a mobile number is written
  // across all three of this platform's countries. Not `Intl`: that formats
  // NUMBERS, and a phone number is a string of digits that happens to look
  // like one.
  return (national.match(/.{1,3}/g) ?? []).join(' ');
}

export interface Balance {
  readonly currency: string;
  readonly spendable: string;
  readonly pending: string;
  readonly total: string;
  /**
   * Fiat or crypto, as the API classifies it.
   *
   * Optional because a client can be talking to an older API, and a screen
   * that crashed on a missing field would be a screen that breaks during a
   * rolling deploy rather than one that degrades.
   */
  readonly kind?: 'fiat' | 'crypto';
}

export interface Transaction {
  readonly id: string;
  readonly kind: string;
  readonly description: string;
  readonly amount: string;
  readonly currency: string;
  readonly occurred_at: string;
}

export interface VirtualAccount {
  readonly account_number: string;
  readonly bank_name: string;
  readonly account_name: string;
  readonly currency: string;
  readonly status: string;
}

export interface CatalogueItem {
  readonly code: string;
  readonly name: string;
  readonly price: string | null;
  readonly currency: string;
}

export interface Purchase {
  readonly id: string;
  readonly service: string;
  readonly status: string;
  readonly amount: string;
  readonly currency: string;
  readonly target: string;
  readonly delivery: Record<string, string> | null;
  readonly failure_reason: string | null;
}

export interface FxQuote {
  readonly from: string;
  readonly to: string;
  readonly amount: string;
  readonly receives: string;
  readonly spread: string;
  readonly rate: string;
  readonly expires_at: string;
}

export interface FxTrade {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly amount: string;
  readonly received: string;
  readonly spread: string;
  readonly recipient: string | null;
  readonly created_at: string;
}

export interface CryptoAddress {
  readonly asset: string;
  readonly network: string;
  readonly address: string;
  readonly memo: string | null;
}

/**
 * The finishes a card can have, offered by both apps from ONE list.
 *
 * The API's zod enum and the database CHECK are the two places that DECIDE;
 * this is what the apps OFFER, and it is here rather than in each app for the
 * reason the currency catalogue is: two copies drift, and the one that drifts
 * offers a customer a choice the server refuses.
 */
export const CARD_COLOURS = [
  { value: 'graphite', label: 'Graphite' },
  { value: 'sapphire', label: 'Sapphire' },
  { value: 'emerald', label: 'Emerald' },
] as const;

export type CardColour = (typeof CARD_COLOURS)[number]['value'];

export interface Card {
  readonly id: string;
  readonly status: string;
  readonly currency: string;
  readonly last4: string | null;
  readonly expiry_month: number | null;
  readonly expiry_year: number | null;
  readonly balance: string;
  /** What the CUSTOMER calls this card, or null. Not the name on the card,
   *  which is their legal name and is not theirs to set. Null is the resting
   *  state; render the last four digits instead of a blank. */
  readonly label?: string | null;
  /** The finish. Always present from the API; optional here so an older
   *  response cannot fail to parse into this type. */
  readonly colour?: string;
}

/**
 * What a reveal returns. A SEPARATE type from `Card`, deliberately.
 *
 * If these were optional members of `Card`, every list render, every cached
 * response and every debug log that stringifies a card would carry a PAN
 * whenever one happened to be present — and nothing would fail on the day it
 * was. Two types means a card number can only reach code that named it.
 *
 * Nothing in this package stores one. It is returned from the call and that is
 * the end of its life here; a caller that puts it in state is making that
 * decision visibly.
 */
export interface CardSecrets {
  readonly pan: string;
  readonly cvv: string;
  readonly expiry_month: number;
  readonly expiry_year: number;
  readonly name_on_card?: string;
}

export interface Deposit {
  readonly id: string;
  readonly amount: string;
  readonly currency: string;
  readonly sender_name: string | null;
  readonly sender_bank: string | null;
  readonly created_at: string;
}

export interface Withdrawal {
  readonly id: string;
  readonly asset: string;
  readonly network: string;
  readonly destination: string;
  readonly amount: string;
  readonly fee: string;
  readonly status: string;
  readonly tx_hash: string | null;
  readonly failure_reason: string | null;
}

/** A bank a customer may send to. The code is the provider's and opaque. */
export interface PayoutBank {
  readonly code: string;
  readonly name: string;
}

export interface BankPayout {
  readonly id: string;
  readonly status: string;
  readonly currency: string;
  /** Major units, as a string. There is no `toNumber` in this package. */
  readonly amount: string;
  readonly fee: string;
  readonly bank_name: string;
  readonly account_number: string;
  /** THE BANK'S ANSWER, stored on the row at the moment of sending. */
  readonly account_name: string;
  readonly narration: string | null;
  readonly failure_reason: string | null;
  readonly created_at: string;
}

export interface CryptoQuote {
  readonly asset: string;
  readonly network: string;
  readonly amount: string;
  readonly fee: string;
  readonly total: string;
  readonly expires_at: string;
}

/**
 * Identity verification, as the customer sees it.
 *
 * `bvn_last4` and nothing more. The server seals the BVN and never returns it,
 * so there is no field here to hold one even if a future handler were careless
 * — the type is the second half of that guarantee.
 */
export interface KycStatus {
  readonly id: string;
  readonly status: string;
  readonly full_name: string;
  readonly bvn_last4: string;
  readonly rejection_reason: string | null;
  readonly created_at: string;
}

/**
 * What a customer's verification tier allows.
 *
 * `daily_limit` is a MAJOR-UNIT DECIMAL STRING — "0.00", not "0" — like every
 * amount the API sends. A zero here is a real limit, not a missing value: an unverified account may move no crypto at all, because a
 * chain transaction is the one movement nobody can recall.
 */
/** The kinds a customer can be asked about. Only the mailing list can be
 *  withdrawn — refusing the terms is closing the account, which is a
 *  different action with its own path. */
export type ConsentKind = 'terms' | 'privacy' | 'marketing_email';

export interface ConsentRecord {
  readonly kind: string;
  readonly granted: boolean;
  /** WHICH WORDS. A consent that records only "yes" cannot answer the
   *  question that matters once a notice is republished. */
  readonly version: string;
  readonly occurred_at: string;
  readonly covers_current: boolean;
}

export interface ConsentState {
  readonly consents: readonly ConsentRecord[];
  /** What is published now, and whether this customer has agreed to it. */
  readonly documents: readonly {
    readonly kind: string;
    readonly version: string;
    readonly summary: string;
    readonly agreed: boolean;
  }[];
}

export interface DataRequest {
  readonly uuid: string;
  readonly kind: string;
  readonly status: string;
  readonly requested_at: string;
  /** Ours and not movable. A process that can push its own deadline out has
   *  no deadline, and this one is statutory. */
  readonly deadline_at: string;
  readonly completed_at?: string | null;
  /** What was actually done, in words. For an erasure this names what went
   *  AND what had to stay — an answer listing only the deletions would read
   *  as a complete erasure, which it deliberately is not. */
  readonly outcome?: string | null;
}

export interface ErasureScopeRow {
  readonly table_name: string;
  readonly scope: 'erasable' | 'retained';
  readonly rationale: string;
}

export interface KycLimits {
  /** 0 registered, 1 verified, 2 enhanced. */
  readonly tier: number;
  readonly limits: readonly {
    readonly currency: string;
    readonly daily_limit: string;
  }[];
  /** The next tier this customer can reach BY THEIR OWN ACTION, or null.
   *  Enhanced is an administrator's judgement about source of funds, so it is
   *  never offered as something to apply for. */
  readonly next_tier: number | null;
}

export interface XetralClientOptions {
  readonly baseUrl: string;
  readonly session: Session;
  readonly fetch?: typeof fetch;
}

export class XetralClient {
  readonly #baseUrl: string;
  readonly #session: Session;
  readonly #fetch: typeof fetch;

  constructor(options: XetralClientOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.#session = options.session;
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
  }

  get session(): Session {
    return this.#session;
  }

  /* --------------------------- wallet --------------------------- */

  async balances(): Promise<readonly Balance[]> {
    const body = await this.#get<{ balances: Balance[] }>('/v1/wallets');
    return body.balances;
  }

  /**
   * History, keyset paginated.
   *
   * `next_cursor` rather than a page number, because the API pages on the
   * posting id: an `OFFSET` shifts under an active account and produces
   * duplicates and gaps. Pass the cursor back as `before` for the next page.
   */
  async transactions(
    currency: string,
    before?: string,
    /**
     * Narrows to particular entry kinds. This is how the "Gift" tab is
     * expressed: gift cards settle in naira, so it is the naira history asked
     * a different question rather than a sixth currency.
     */
    kinds?: readonly string[],
  ): Promise<{ entries: readonly Transaction[]; nextCursor: string | null }> {
    const query = new URLSearchParams({ currency });
    if (before !== undefined) query.set('before', before);
    // Comma-separated, because repeating a key in a query string is ambiguous
    // across HTTP clients and the API parses one string.
    if (kinds !== undefined && kinds.length > 0) query.set('kinds', kinds.join(','));

    const body = await this.#get<{ entries: Transaction[]; next_cursor: string | null }>(
      `/v1/wallets/transactions?${query.toString()}`,
    );
    return { entries: body.entries, nextCursor: body.next_cursor };
  }

  /**
   * Move money to another customer.
   *
   * `idempotencyKey` is REQUIRED, not optional with a generated default. A
   * caller that cannot say what makes two requests "the same transfer" should
   * be made to decide, because the alternative is a retry on a flaky
   * connection sending twice.
   */
  async transfer(input: {
    recipient: string;
    amount: string;
    currency: string;
    pin: string;
    idempotencyKey: string;
  }): Promise<{ amount: string; fee: string; currency: string }> {
    return this.#post('/v1/wallets/transfers', {
      recipient: input.recipient,
      amount: input.amount,
      currency: input.currency,
      transaction_pin: input.pin,
      idempotency_key: input.idempotencyKey,
    });
  }

  /**
   * Sets a transaction PIN, or changes one.
   *
   * `currentPin` is optional here and REQUIRED by the server once a PIN
   * exists, because only the server knows whether one does. Making it required
   * in this signature would mean a first-time caller inventing a value to
   * satisfy the type.
   */
  async setPin(pin: string, currentPin?: string): Promise<void> {
    await this.#post('/v1/auth/pin', {
      pin,
      ...(currentPin === undefined ? {} : { current_pin: currentPin }),
    });
  }

  /**
   * Who this session belongs to, and when it stops working.
   *
   * `currentSession`, not `session`, because `session` is already the accessor
   * returning the `Session` object — and a method that shadowed it would make
   * `client.session` mean two things depending on whether it was called.
   */
  async currentSession(): Promise<{
    session_id: string;
    user_id: string;
    device_id: string;
    expires_at: string;
    /** What to call this customer — what they typed at signup, falling back
     *  to their verified name, and null when there is neither. A screen that
     *  greets them falls back rather than inventing one from an email. */
    first_name: string | null;
    /**
     * The whole name and the phone, both as typed at SIGNUP.
     *
     * They exist so the identity form can PREFILL rather than ask a second
     * time for what the account already holds. Neither is the verified name:
     * that is read off a document by a reviewer, is what a card carries, and
     * is the only one any money decision reads.
     */
    full_name: string | null;
    phone: string | null;
    /**
     * Whether a transaction PIN exists, or NULL when the server could not
     * tell.
     *
     * `boolean | null`, matching the API — it was `boolean` here while the
     * server had already widened it, so a null arrived as a value TypeScript
     * insisted could not exist. Every caller must test `=== false` rather
     * than `!has_pin`: "I do not know" and "there is none" are different
     * claims, and only one of them is safe to send somebody to a PIN form on.
     */
    has_pin: boolean | null;
    /**
     * WHERE THEY ARE, and what their money is in.
     *
     * `home_currency` is what the home screen leads with and what the
     * activity rail starts from. Both null for an account opened before 040;
     * the apps fall back to naira there, which is what those accounts are.
     */
    country: string | null;
    home_currency: string | null;
    /**
     * THE COUNTRY'S NAME AND HOW MONEY LEAVES IT.
     *
     * Both screens personalise on these rather than on the country CODE: a
     * `switch ('NG' | 'GH' | 'KE')` in two apps is the thing 040 exists to
     * prevent, and it needs a release on the day a fourth country opens.
     *
     * `payout_method` is 'bank' or 'mobile_money'. Null — an account whose
     * country row is missing — reads as bank, the conservative answer,
     * because a bank transfer that refuses is recoverable and a send to a
     * number that is not a wallet is not.
     */
    country_name: string | null;
    payout_method: string | null;
    /** Their own payment handle, or null until `profile()` mints one. */
    handle: string | null;
  }> {
    return this.#get('/v1/auth/session');
  }

  /**
   * The customer's own payment handle and the link built from it.
   *
   * Mints one on the first call and returns the same one after that, so it is
   * safe to call whenever a screen wants to show the link.
   */
  async profile(): Promise<{ handle: string; link: string | null }> {
    return this.#get('/v1/auth/profile');
  }

  /**
   * Change it.
   *
   * A handle is never reissued TO SOMEBODY ELSE, so the one being given up
   * cannot be claimed by anybody — every link already pointing at it stays
   * pointing at this customer. They may take it back themselves, which is
   * safe for the same reason: it pays the same person either way.
   *
   * Takes the transaction PIN because the change reaches every link already
   * shared, not because it moves money — it moves none.
   *
   * `handle_taken` covers both a handle somebody else holds now and one
   * somebody else held once, which are the same answer to the person typing.
   */
  async chooseHandle(
    handle: string,
    pin: string,
  ): Promise<{ handle: string; link: string | null }> {
    return this.#post('/v1/auth/profile/handle', { handle, transaction_pin: pin });
  }

  /**
   * Confirms a transaction PIN without moving money.
   *
   * The server's guard does the verifying, so a 204 here means the PIN is
   * right. Used before storing it behind a phone's biometric gate: storing a
   * wrong one means finding out on a real transfer, which spends one of the
   * customer's five attempts.
   */
  async verifyPin(pin: string): Promise<void> {
    await this.#post('/v1/auth/pin/verify', { transaction_pin: pin });
  }

  /* ------------------------ the staff second factor ---------------------- */

  /**
   * Issue an authenticator secret, unconfirmed.
   *
   * THESE TWO CALLS EXISTED ON THE API AND NOWHERE ELSE. Every `/v1/admin/`
   * route refuses with `totp_not_enrolled` until the factor is confirmed, and
   * there was no client method and no screen — so the first operator granted a
   * role found every operations page refusing, with no way to satisfy it short
   * of curl.
   *
   * The secret comes back ONCE and is never returned again: re-reading it
   * would make any stolen session a way to clone the factor.
   */
  async beginTotpEnrolment(): Promise<{ secret: string; otpauth_url: string }> {
    return this.#post('/v1/auth/totp/enrol', {});
  }

  /**
   * Prove the authenticator works, and turn the factor on.
   *
   * Until this succeeds the enrolment is inert — which is the point. Trusting
   * the secret at issue time would lock out somebody who scanned nothing or
   * scanned into an app on a phone they then wiped, and they would find that
   * out during whatever made them need the dashboard.
   */
  async confirmTotpEnrolment(code: string): Promise<void> {
    await this.#post('/v1/auth/totp/confirm', { totp_code: code });
  }

  /**
   * Start a work session on the operations dashboard.
   *
   * WITHOUT THIS THE ACTING SURFACE WAS UNREACHABLE. Elevation is a property
   * of the session and only two things could ever set it: enrolment, which
   * runs once, and an acting request that carried a code — which no client
   * ever sent. So the dashboard worked for ten minutes after somebody
   * enrolled and then refused every action for ever, with a message telling
   * the operator to enter a code into a form that had nowhere to put one.
   *
   * One code buys the whole window rather than one action. Codes are
   * single-use and change every thirty seconds, so a per-action code would
   * refuse a reviewer on their second approval — and the predictable end of
   * that is a shared authenticator on somebody's desk, which looks like
   * control and is not.
   */
  async elevateStaffSession(code: string): Promise<void> {
    await this.#post('/v1/auth/totp/elevate', { totp_code: code });
  }

  /* --------------------------- funding -------------------------- */

  /** The customer's dedicated NGN account. Creates it on the first call. */
  /** ISSUES one, asking Bitnob and refusing an unverified customer. Not a
   *  read — see `existingFundingAccount`. */
  async fundingAccount(): Promise<VirtualAccount> {
    return this.#post('/v1/funding/account', {});
  }

  /** The account this customer already has, or null. Opens nothing. */
  async existingFundingAccount(): Promise<VirtualAccount | null> {
    const body = await this.#get<{ account: VirtualAccount | null }>('/v1/funding/account');
    return body.account;
  }

  /* -------------------------- purchases ------------------------- */

  async catalogue(service: string, group?: string): Promise<readonly CatalogueItem[]> {
    const query = new URLSearchParams({ service });
    if (group !== undefined) query.set('group', group);
    const body = await this.#get<{ items: CatalogueItem[] }>(
      `/v1/purchases/catalogue?${query.toString()}`,
    );
    return body.items;
  }

  async verifyTarget(input: {
    service: string;
    itemCode: string;
    target: string;
  }): Promise<{ target: string; name: string }> {
    return this.#post('/v1/purchases/verify', {
      service: input.service,
      item_code: input.itemCode,
      target: input.target,
    });
  }

  async buy(input: {
    service: string;
    itemCode: string;
    target: string;
    amount: string;
    pin: string;
    idempotencyKey: string;
  }): Promise<Purchase> {
    return this.#post('/v1/purchases', {
      service: input.service,
      item_code: input.itemCode,
      target: input.target,
      amount: input.amount,
      transaction_pin: input.pin,
      idempotency_key: input.idempotencyKey,
    });
  }

  async purchases(): Promise<readonly Purchase[]> {
    const body = await this.#get<{ purchases: Purchase[] }>('/v1/purchases');
    return body.purchases;
  }

  /* ------------------------------ fx ---------------------------- */

  async fxQuote(from: string, to: string, amount: string): Promise<FxQuote> {
    const query = new URLSearchParams({ from, to, amount });
    return this.#get(`/v1/fx/quote?${query.toString()}`);
  }

  /**
   * BETWEEN YOUR OWN WALLETS. No PIN, and no recipient — the API's schema for
   * this route has no such field, because the PIN-free path must not be able
   * to reach somebody else. To send converted money to another customer, call
   * `remit`.
   */
  async convert(input: {
    from: string;
    to: string;
    amount: string;
    minReceived?: string;
    idempotencyKey: string;
  }): Promise<FxTrade> {
    return this.#post('/v1/fx/convert', {
      from: input.from,
      to: input.to,
      amount: input.amount,
      ...(input.minReceived === undefined ? {} : { min_received: input.minReceived }),
      idempotency_key: input.idempotencyKey,
    });
  }

  /** Converting AND sending it to somebody else. A payment, so it takes the
   *  PIN. Same entry as `convert` with one leg pointed elsewhere. */
  async remit(input: {
    from: string;
    to: string;
    amount: string;
    minReceived?: string;
    recipient: string;
    pin: string;
    idempotencyKey: string;
  }): Promise<FxTrade> {
    return this.#post('/v1/fx/remit', {
      from: input.from,
      to: input.to,
      amount: input.amount,
      ...(input.minReceived === undefined ? {} : { min_received: input.minReceived }),
      recipient: input.recipient,
      transaction_pin: input.pin,
      idempotency_key: input.idempotencyKey,
    });
  }

  /* ---------------------------- crypto -------------------------- */

  /* ---------------------------------------------------------------- *
   *  BANK PAYOUTS
   *
   *  Note what is NOT sent on `payToBank`: the beneficiary's name. The
   *  server re-fetches it from the bank rather than accepting one from
   *  here, because anything this client can send is something an attacker
   *  holding a stolen session can send — and the whole value of the lookup
   *  is that it produces a claim the sender did not author. The name this
   *  client shows on a confirmation screen is for the CUSTOMER to read; it
   *  is not evidence.
   * ---------------------------------------------------------------- */

  async payoutBanks(country: string): Promise<readonly PayoutBank[]> {
    const query = new URLSearchParams({ country });
    const body = await this.#get<{ banks: PayoutBank[] }>(
      `/v1/payouts/banks?${query.toString()}`,
    );
    return body.banks;
  }

  async lookupBankAccount(input: {
    country: string;
    bankCode: string;
    accountNumber: string;
  }): Promise<{ account_name: string }> {
    const query = new URLSearchParams({
      country: input.country,
      bank_code: input.bankCode,
      account_number: input.accountNumber,
    });
    return this.#get(`/v1/payouts/lookup?${query.toString()}`);
  }

  async bankPayouts(): Promise<readonly BankPayout[]> {
    const body = await this.#get<{ payouts: BankPayout[] }>('/v1/payouts');
    return body.payouts;
  }

  async payToBank(input: {
    country: string;
    bankCode: string;
    accountNumber: string;
    amount: string;
    currency: string;
    narration?: string;
    pin: string;
    idempotencyKey: string;
  }): Promise<BankPayout> {
    return this.#post('/v1/payouts', {
      country: input.country,
      bank_code: input.bankCode,
      account_number: input.accountNumber,
      amount: input.amount,
      currency: input.currency,
      ...(input.narration === undefined ? {} : { narration: input.narration }),
      transaction_pin: input.pin,
      idempotency_key: input.idempotencyKey,
    });
  }

  async cryptoAddress(asset: string, network: string): Promise<CryptoAddress> {
    return this.#post('/v1/crypto/addresses', { asset, network });
  }

  async cryptoQuote(input: {
    asset: string;
    network: string;
    amount: string;
  }): Promise<CryptoQuote> {
    const query = new URLSearchParams(input);
    return this.#get(`/v1/crypto/withdrawals/quote?${query.toString()}`);
  }

  async withdrawals(): Promise<readonly Withdrawal[]> {
    const body = await this.#get<{ withdrawals: Withdrawal[] }>('/v1/crypto/withdrawals');
    return body.withdrawals;
  }

  async withdrawCrypto(input: {
    asset: string;
    network: string;
    destination: string;
    amount: string;
    maxFee?: string;
    pin: string;
    idempotencyKey: string;
  }): Promise<Withdrawal> {
    return this.#post('/v1/crypto/withdrawals', {
      asset: input.asset,
      network: input.network,
      destination: input.destination,
      amount: input.amount,
      ...(input.maxFee === undefined ? {} : { max_fee: input.maxFee }),
      transaction_pin: input.pin,
      idempotency_key: input.idempotencyKey,
    });
  }

  /* ------------------------------ kyc --------------------------- */

  /** The customer's own verification state, or null if they have never
   *  submitted. Everything gated on KYC reads this to say WHY it is refusing. */
  async kyc(): Promise<KycStatus | null> {
    const body = await this.#get<{ kyc: KycStatus | null }>('/v1/kyc');
    return body.kyc;
  }

  /**
   * What this customer's verification currently allows them to move.
   *
   * The half that makes tiers a product rather than a trap: somebody refused
   * for exceeding a ceiling can be shown what it is and how to raise it,
   * instead of an error code they can do nothing with.
   *
   * `daily_limit` is a MAJOR-UNIT DECIMAL STRING, like every amount that
   * crosses this boundary. Format it; never turn it into a number.
   */
  async kycLimits(): Promise<KycLimits> {
    return this.#get<KycLimits>('/v1/kyc/limits');
  }

  /* ------------------------------ data rights --------------------------- */

  /**
   * A copy of everything held about this customer.
   *
   * TAKES THE TRANSACTION PIN, unlike every other read on this client. It is
   * every balance, every transaction and every place they have signed in from
   * in one document — the single read a stolen session most wants, and the one
   * whose consequence outlives the access token that fetched it.
   */
  async exportMyData(transactionPin: string): Promise<Record<string, unknown>> {
    return this.#post<Record<string, unknown>>('/v1/me/export', {
      transaction_pin: transactionPin,
    });
  }

  /** Asks for a copy or for erasure. NO PIN: the customer most likely to ask
   *  is one who has just found somebody else in their account. */
  async requestMyData(kind: 'export' | 'erasure'): Promise<DataRequest> {
    return this.#post<DataRequest>('/v1/me/requests', { kind });
  }

  async myDataRequests(): Promise<readonly DataRequest[]> {
    const body = await this.#get<{ requests: DataRequest[] }>('/v1/me/requests');
    return body.requests;
  }

  /** What can be erased and what cannot, with the reason. Published to the
   *  customer, because being refused with no way to learn what would change is
   *  what turns a right into a support ticket. */
  async erasureScope(): Promise<readonly ErasureScopeRow[]> {
    const body = await this.#get<{ scope: ErasureScopeRow[] }>('/v1/me/erasure-scope');
    return body.scope;
  }

  /* -------------------------------- consent ----------------------------- */

  /** What this customer has agreed to, and what is currently published. */
  async consents(): Promise<ConsentState> {
    return this.#get<ConsentState>('/v1/consents');
  }

  /**
   * Grants or withdraws.
   *
   * ONE CALL EITHER WAY, and no transaction PIN. Consent that is harder to
   * withdraw than to give is not freely given, so there is deliberately no
   * separate `withdraw` method and no confirmation step for a client to add
   * on one side and not the other.
   */
  async setConsent(kind: ConsentKind, granted: boolean): Promise<ConsentRecord> {
    return this.#post<ConsentRecord>('/v1/consents', { kind, granted });
  }

  async submitKyc(input: {
    fullName: string;
    dateOfBirth: string;
    phone: string;
    bvn: string;
    address: string;
  }): Promise<KycStatus> {
    return this.#post('/v1/kyc', {
      full_name: input.fullName,
      date_of_birth: input.dateOfBirth,
      phone: input.phone,
      bvn: input.bvn,
      address: input.address,
    });
  }

  /* ----------------------------- cards -------------------------- */

  async cards(): Promise<readonly Card[]> {
    return (await this.cardList()).cards;
  }

  /**
   * The cards AND what a new one costs.
   *
   * The price is on this response rather than typed into the onboarding screen
   * because it is a `platform_settings` row an operator can change, and a
   * screen carrying its own copy is a screen that shows the old price the
   * moment one does. It is a major-unit STRING, like every other amount here.
   */
  async cardList(): Promise<{ readonly cards: readonly Card[]; readonly issuance_fee: string }> {
    const body = await this.#get<{ cards: Card[]; issuance_fee?: string }>('/v1/cards');
    return { cards: body.cards, issuance_fee: body.issuance_fee ?? '0.00' };
  }

  async card(id: string): Promise<Card> {
    return this.#get(`/v1/cards/${encodeURIComponent(id)}`);
  }

  /**
   * Buying a card. NO NAME and NO STARTING BALANCE.
   *
   * The name on a card is the customer's verified legal name and the server
   * reads it from the approved KYC record — a field here could disagree with
   * the identity the card was issued against. Money goes on afterwards through
   * `fundCard`, because buying a card and loading it are two decisions.
   *
   * The PIN stays, because this MOVES MONEY: issuing charges the card price.
   */
  async issueCard(input: {
    pin: string;
    idempotencyKey: string;
    colour?: CardColour;
  }): Promise<Card> {
    return this.#post('/v1/cards', {
      transaction_pin: input.pin,
      idempotency_key: input.idempotencyKey,
      ...(input.colour === undefined ? {} : { colour: input.colour }),
    });
  }

  /** Naming a card, or clearing the name with null. No PIN: nothing moves. */
  async nameCard(id: string, label: string | null): Promise<Card> {
    return this.#post(`/v1/cards/${encodeURIComponent(id)}/label`, { label });
  }

  async fundCard(
    id: string,
    input: { amount: string; pin: string; idempotencyKey: string },
  ): Promise<Card> {
    return this.#post(`/v1/cards/${encodeURIComponent(id)}/fund`, {
      amount: input.amount,
      transaction_pin: input.pin,
      idempotency_key: input.idempotencyKey,
    });
  }

  /** No PIN, deliberately — the server does not ask for one either. A customer
   *  watching fraudulent charges land must be able to stop them without first
   *  remembering a PIN. Unfreezing and terminating both ask. */
  async freezeCard(id: string): Promise<Card> {
    return this.#post(`/v1/cards/${encodeURIComponent(id)}/freeze`, {});
  }

  /**
   * The card number, the CVV and the expiry.
   *
   * Takes a PIN because the server does: a number, a CVV and an expiry
   * together are everything needed to spend online, and unlike a transfer
   * there is no ledger entry afterwards for anyone to notice.
   *
   * The result is deliberately not cached anywhere in this client. Every
   * reveal is a fresh call that the server records and counts, which is what
   * makes "when was this number last shown?" answerable — and a cached copy
   * would quietly make the answer wrong.
   */
  async revealCard(id: string, pin: string): Promise<CardSecrets> {
    return this.#post(`/v1/cards/${encodeURIComponent(id)}/reveal`, {
      transaction_pin: pin,
    });
  }

  async unfreezeCard(id: string, pin: string): Promise<Card> {
    return this.#post(`/v1/cards/${encodeURIComponent(id)}/unfreeze`, {
      transaction_pin: pin,
    });
  }

  async terminateCard(id: string, pin: string): Promise<Card> {
    return this.#post(`/v1/cards/${encodeURIComponent(id)}/terminate`, {
      transaction_pin: pin,
    });
  }

  /* ---------------------------- funding ------------------------- */

  async deposits(): Promise<readonly Deposit[]> {
    const body = await this.#get<{ deposits: Deposit[] }>('/v1/funding/deposits');
    return body.deposits;
  }

  /* ------------------------------ fx ---------------------------- */

  async fxTrades(): Promise<readonly FxTrade[]> {
    const body = await this.#get<{ trades: FxTrade[] }>('/v1/fx/trades');
    return body.trades;
  }

  /* ---------------------------- plumbing ------------------------ */

  async #get<T>(path: string): Promise<T> {
    return this.#request<T>('GET', path);
  }



  async #post<T>(path: string, body: unknown): Promise<T> {
    return this.#request<T>('POST', path, body);
  }

  /**
   * One request, with at most ONE retry after a refresh.
   *
   * The retry is capped deliberately. A loop that refreshed on every 401 would
   * hammer the rotation endpoint when a token is rejected for a reason
   * refreshing cannot fix — a frozen account, a revoked device — and every one
   * of those attempts consumes a refresh token.
   */
  async #request<T>(method: string, path: string, body?: unknown, retried = false): Promise<T> {
    const token = await this.#session.accessToken();

    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}${path}`, {
        method,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (cause) {
      // A dropped connection is not an API error and must not be reported as
      // one: "insufficient funds" and "your train went into a tunnel" call for
      // very different words on screen.
      //
      // Constructed directly rather than through `toApiError`, which only
      // recognises codes the SERVER sends — and `network` is ours. Routing it
      // through there would have it fall through to `unknown`.
      throw new ApiError('network', 0, [], String(cause));
    }

    if (response.status === 401 && !retried) {
      // The token was rejected. Refresh ONCE — through the single-flight latch,
      // so ten concurrent requests hitting this line produce one rotation and
      // not ten replays of the same refresh token.
      await this.#session.refresh();
      return this.#request<T>(method, path, body, true);
    }

    const payload: unknown = await response.json().catch(() => undefined);
    if (!response.ok) throw toApiError(response.status, payload);
    return payload as T;
  }
}
