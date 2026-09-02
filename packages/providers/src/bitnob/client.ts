import {
  ProviderContractError,
  ProviderRejectedError,
  ProviderTimeoutError,
  ProviderUnavailableError,
} from '../ports/errors.js';

const PROVIDER = 'bitnob';

/**
 * The HTTP boundary.
 *
 * `fetch` is injected rather than reached for globally, so tests drive real
 * adapter code against scripted responses instead of asserting against a mock
 * of the adapter itself.
 */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface BitnobClientOptions {
  readonly baseUrl: string;
  /**
   * The key, or a function that resolves one PER REQUEST.
   *
   * A FUNCTION IS THE POINT, and a plain string was the bug. Every Bitnob
   * port was built once at module construction from an environment variable,
   * so a key pasted into `/admin/credentials` — stored, hinted, audited and
   * rotation-logged — was read by nothing at all. The dashboard said the
   * credential was set and every card, quote and address still refused.
   *
   * `026_provider_credentials.sql` says the database is authoritative and the
   * environment is the fallback, and the five-second cache on
   * `ProviderCredentialsService` exists precisely so this can be asked on
   * every call. It was true of the service and false of every caller.
   *
   * Resolving per request is also what makes a rotation take effect without a
   * deploy: a key replaced during an incident is live within five seconds
   * rather than at the next restart.
   */
  readonly apiKey: string | (() => Promise<string | undefined>);
  readonly fetch?: FetchLike;
  /**
   * A request that has not answered in this long is abandoned.
   *
   * Abandoning is not the same as knowing it did not happen, which is why
   * ProviderTimeoutError is deliberately not retryable — see errors.ts.
   */
  readonly timeoutMs?: number;
}

/**
 * Bitnob's virtual-card endpoints, verified against their official Node SDK
 * (npm `bitnob`, `lib/virtual_card.ts`) rather than inferred.
 *
 * Two things about the shape are worth stating, because both are the opposite
 * of what a REST-shaped guess produces — and this table WAS such a guess until
 * it was checked:
 *
 *  1. There are no per-card sub-resources. Every operation is a flat POST to
 *     its own verb path with `cardId` in the BODY. `/virtualcards/{id}/freeze`
 *     does not exist.
 *  2. The paths live under `/api/v1` on the host, so `baseUrl` is
 *     `https://api.bitnob.co/api/v1` (sandbox: `https://sandboxapi.bitnob.co/api/v1`)
 *     and the paths here are relative to that.
 */
export const BITNOB_ENDPOINTS = {
  /** KYC registration. A prerequisite for issuing, never a side effect of it. */
  registerCardUser: '/virtualcards/registercarduser',
  issueCard: '/virtualcards/create',
  /** "credit", not "topup". */
  fundCard: '/virtualcards/credit',
  freezeCard: '/virtualcards/freeze',
  unfreezeCard: '/virtualcards/unfreeze',
  terminateCard: '/virtualcards/terminate',
  getCard: (cardId: string) => `/virtualcards/card/${cardId}`,
  /**
   * The company wallet, and what Bitnob says it holds for us.
   *
   * VERIFIED against their own Node SDK (npm `bitnob`, `lib/wallet.ts`):
   * `walletDetails()` issues `GET /wallets`. Not a guess — every path in this
   * table was wrong the first time it was one.
   */
  wallets: '/wallets',
} as const;

export class BitnobClient {
  readonly #baseUrl: string;
  readonly #apiKey: string | (() => Promise<string | undefined>);
  readonly #fetch: FetchLike;
  readonly #timeoutMs: number;

  constructor(options: BitnobClientOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.#apiKey = options.apiKey;
    this.#fetch = options.fetch ?? ((url, init) => fetch(url, init));
    this.#timeoutMs = options.timeoutMs ?? 15_000;
  }

  async request(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    idempotencyKey?: string,
  ): Promise<unknown> {
    /*
     * ASKED BEFORE THE TIMER STARTS, so a slow credential read cannot eat the
     * provider's own budget — and refused HERE rather than sent as
     * `Bearer undefined`, which Bitnob answers 401 to and which presents as
     * "the key is wrong" when the truth is that there is no key.
     */
    const apiKey =
      typeof this.#apiKey === 'string' ? this.#apiKey : await this.#apiKey();
    if (apiKey === undefined || apiKey === '') {
      throw new ProviderUnavailableError(
        'bitnob',
        'no API key is configured. Paste one on the Provider keys screen, or ' +
          'set BITNOB_API_KEY.',
      );
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);

    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}${path}`, {
        method,
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
          // Sent so a retry of a money-moving call cannot be applied twice on
          // their side either. Ours is enforced by the ledger's UNIQUE
          // constraint; this is the other half of the same guarantee.
          ...(idempotencyKey === undefined ? {} : { 'idempotency-key': idempotencyKey }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (cause) {
      if (cause instanceof Error && cause.name === 'AbortError') {
        throw new ProviderTimeoutError(
          PROVIDER,
          `${method} ${path} did not answer within ${this.#timeoutMs}ms; whether it was ` +
            `applied is unknown, so reconcile rather than retry`,
          cause,
        );
      }
      throw new ProviderUnavailableError(PROVIDER, `${method} ${path} failed`, cause);
    } finally {
      clearTimeout(timer);
    }

    const text = await response.text();

    if (response.status >= 500) {
      throw new ProviderUnavailableError(
        PROVIDER,
        `${method} ${path} returned ${response.status}`,
        text,
      );
    }

    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch (cause) {
      // A gateway's HTML error page reaching here means we are not talking to
      // the API we think we are.
      throw new ProviderContractError(
        PROVIDER,
        `${method} ${path} returned ${response.status} with a non-JSON body`,
        cause,
      );
    }

    if (!response.ok) {
      const detail = payload as { message?: unknown; code?: unknown };
      throw new ProviderRejectedError(
        PROVIDER,
        typeof detail.message === 'string'
          ? detail.message
          : `${method} ${path} returned ${response.status}`,
        typeof detail.code === 'string' ? detail.code : undefined,
        text,
      );
    }

    return payload;
  }
}
