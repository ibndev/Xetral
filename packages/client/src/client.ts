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

export interface Balance {
  readonly currency: string;
  readonly spendable: string;
  readonly pending: string;
  readonly total: string;
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

export interface Card {
  readonly id: string;
  readonly status: string;
  readonly currency: string;
  readonly last4: string | null;
  readonly expiry_month: number | null;
  readonly expiry_year: number | null;
  readonly balance: string;
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
 * `daily_limit` is a MINOR-UNIT STRING. A zero here is a real limit, not a
 * missing value: an unverified account may move no crypto at all, because a
 * chain transaction is the one movement nobody can recall.
 */
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
  ): Promise<{ entries: readonly Transaction[]; nextCursor: string | null }> {
    const query = new URLSearchParams({ currency });
    if (before !== undefined) query.set('before', before);

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
  }> {
    return this.#get('/v1/auth/session');
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

  /* --------------------------- funding -------------------------- */

  /** The customer's dedicated NGN account. Creates it on the first call. */
  async fundingAccount(): Promise<VirtualAccount> {
    return this.#post('/v1/funding/account', {});
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

  async convert(input: {
    from: string;
    to: string;
    amount: string;
    minReceived?: string;
    recipient?: string;
    pin: string;
    idempotencyKey: string;
  }): Promise<FxTrade> {
    return this.#post('/v1/fx/convert', {
      from: input.from,
      to: input.to,
      amount: input.amount,
      ...(input.minReceived === undefined ? {} : { min_received: input.minReceived }),
      ...(input.recipient === undefined ? {} : { recipient: input.recipient }),
      transaction_pin: input.pin,
      idempotency_key: input.idempotencyKey,
    });
  }

  /* ---------------------------- crypto -------------------------- */

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
   * `daily_limit` is a MINOR-UNIT STRING, like every amount that crosses this
   * boundary. Format it; never turn it into a number.
   */
  async kycLimits(): Promise<KycLimits> {
    return this.#get<KycLimits>('/v1/kyc/limits');
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
    const body = await this.#get<{ cards: Card[] }>('/v1/cards');
    return body.cards;
  }

  async card(id: string): Promise<Card> {
    return this.#get(`/v1/cards/${encodeURIComponent(id)}`);
  }

  async issueCard(input: {
    nameOnCard: string;
    initialFunding: string;
    pin: string;
    idempotencyKey: string;
  }): Promise<Card> {
    return this.#post('/v1/cards', {
      name_on_card: input.nameOnCard,
      initial_funding: input.initialFunding,
      transaction_pin: input.pin,
      idempotency_key: input.idempotencyKey,
    });
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
