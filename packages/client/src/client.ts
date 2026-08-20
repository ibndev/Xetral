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

  async transactions(currency: string, before?: string): Promise<readonly Transaction[]> {
    const query = new URLSearchParams({ currency });
    if (before !== undefined) query.set('before', before);
    const body = await this.#get<{ transactions: Transaction[] }>(
      `/v1/wallets/transactions?${query.toString()}`,
    );
    return body.transactions;
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

  async withdrawCrypto(input: {
    asset: string;
    network: string;
    destination: string;
    amount: string;
    maxFee?: string;
    pin: string;
    idempotencyKey: string;
  }): Promise<unknown> {
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
