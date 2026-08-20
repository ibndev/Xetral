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
  readonly apiKey: string;
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
 * CONFIRM BEFORE GO-LIVE — these paths and the webhook signature header in
 * webhooks.ts are the two things in this adapter that could not be verified
 * from the repository. They are collected here, in one place, precisely so that
 * confirming them is a single small diff against Bitnob's live documentation
 * rather than a hunt through the module.
 */
export const BITNOB_ENDPOINTS = {
  issueCard: '/api/v1/virtualcards',
  fundCard: (cardId: string) => `/api/v1/virtualcards/${cardId}/topup`,
  freezeCard: (cardId: string) => `/api/v1/virtualcards/${cardId}/freeze`,
  unfreezeCard: (cardId: string) => `/api/v1/virtualcards/${cardId}/unfreeze`,
  terminateCard: (cardId: string) => `/api/v1/virtualcards/${cardId}/terminate`,
  getCard: (cardId: string) => `/api/v1/virtualcards/${cardId}`,
} as const;

export class BitnobClient {
  readonly #baseUrl: string;
  readonly #apiKey: string;
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
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);

    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}${path}`, {
        method,
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${this.#apiKey}`,
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
