import {
  ProviderContractError,
  ProviderRejectedError,
  ProviderTimeoutError,
  ProviderUnavailableError,
} from '../ports/errors.js';
import { signedHeaders } from './signing.js';

const PROVIDER = 'bitnob';

/**
 * The HTTP boundary.
 *
 * `fetch` is injected rather than reached for globally, so tests drive real
 * adapter code against scripted responses instead of asserting against a mock
 * of the adapter itself.
 */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** A value, or a function that resolves one per request. */
export type BitnobCredential = string | (() => Promise<string | undefined>);

export interface BitnobClientOptions {
  readonly baseUrl: string;
  /**
   * The client id, or a function that resolves one PER REQUEST.
   *
   * A FUNCTION IS THE POINT, and a plain string was the bug. Every Bitnob
   * port was built once at module construction from an environment variable,
   * so a credential pasted into `/admin/credentials` — stored, hinted,
   * audited and rotation-logged — was read by nothing at all. The dashboard
   * said the credential was set and every card, quote and address still
   * refused.
   *
   * `026_provider_credentials.sql` says the database is authoritative and the
   * environment is the fallback, and the five-second cache on
   * `ProviderCredentialsService` exists precisely so this can be asked on
   * every call. It was true of the service and false of every caller.
   *
   * Resolving per request is also what makes a rotation take effect without a
   * deploy: a credential replaced during an incident is live within five
   * seconds rather than at the next restart.
   */
  readonly clientId: BitnobCredential;
  /**
   * The signing key. NEVER TRANSMITTED — see `signing.ts`.
   *
   * Two credentials rather than one, because that is what Bitnob v2 needs:
   * the id says who is calling and the secret proves it. A deployment
   * carrying only the old v1 API key cannot sign at all, which is why it is
   * not silently reused here under a new name.
   */
  readonly clientSecret: BitnobCredential;
  readonly fetch?: FetchLike;
  /**
   * Refuse to talk to a LIVE Bitnob account.
   *
   * Set on staging, and the whole reason it exists is that the base URL can
   * no longer answer the question. Bitnob v2 serves sandbox and production
   * from one host and the SECRET selects the environment, so
   * `assertProviderSandbox` in `apps/api/src/config.ts` — which matched on
   * the URL — became a check that could not see the thing it guarded.
   *
   * Asked ONCE PER CLIENT, lazily, at that client's first request, and
   * cached. Not at boot: a provider call during startup is a new way for the
   * API to fail to start, which is the reason `/v1/admin/readiness` reports
   * rather than refuses.
   *
   * Once per client, not once per process — each port builds its own
   * `BitnobClient`, so a staging deployment pays this on the first card
   * request, the first FX request and so on. That is a handful of round trips
   * over the life of the process, and the alternative — one shared check —
   * would mean a client constructed later inheriting an answer nothing asked
   * on its behalf.
   */
  readonly requireSandbox?: boolean;
  /**
   * A request that has not answered in this long is abandoned.
   *
   * Abandoning is not the same as knowing it did not happen, which is why
   * ProviderTimeoutError is deliberately not retryable — see errors.ts.
   */
  readonly timeoutMs?: number;
}

/**
 * Bitnob's v2 endpoints, VERIFIED against their own documentation repository
 * (`bitnob/stealthdocs`: `docs.json`, `docs/card-issuing/*`).
 *
 * THIS TABLE WAS WRONG IN EVERY ENTRY, twice over, and the second time is the
 * one worth recording. Phase 3 replaced a REST-shaped guess with the paths in
 * their published Node SDK, which was right at the time. Bitnob has since
 * retired that whole surface:
 *
 *     /api/v1/virtualcards/*   ->  /api/cards and /api/customers
 *     implicit card context    ->  explicit :cardId in the PATH
 *     flat verb POSTs          ->  /api/cards/:cardId/status, /balance
 *
 * So the SDK on npm is now a description of an API that no longer answers,
 * and "verified against the vendor's own SDK" bought less than it looked
 * like. The lesson from Phase 3 holds and gets sharper: a table of constants
 * needs a source AND a date, because a correct one decays.
 *
 * The paths carry their own `/api` prefix, so `baseUrl` is the bare host —
 * `https://api.bitnob.com`, for sandbox and production alike. There is no
 * `/api/v1` to append any more, and a base URL still carrying one turns every
 * path into `/api/v1/api/cards`.
 */
export const BITNOB_ENDPOINTS = {
  /**
   * Who the signing secret belongs to, and WHICH ENVIRONMENT it selects.
   *
   * This is the endpoint the staging guard rests on. See
   * `assertSandboxSecret` below for why a URL can no longer answer that.
   */
  whoami: '/api/whoami',

  /** KYC registration. A prerequisite for issuing, never a side effect of it. */
  registerCardUser: '/api/customers',
  issueCard: '/api/cards',
  /** Funding and withdrawing are one endpoint, distinguished by the body. */
  cardBalance: (cardId: string) => `/api/cards/${cardId}/balance`,
  /** Freeze and unfreeze are one endpoint too: `{ status: 'frozen' | 'active' }`. */
  cardStatus: (cardId: string) => `/api/cards/${cardId}/status`,
  terminateCard: (cardId: string) => `/api/cards/${cardId}/terminate`,
  getCard: (cardId: string) => `/api/cards/${cardId}`,

  /**
   * Dedicated Nigerian account numbers.
   *
   * The previous value, `/addresses/generate-naira-account`, was a documented
   * GUESS — its own header comment admitted "the virtual-account routes
   * themselves could not be verified from this repository". It was wrong.
   */
  createVirtualAccount: '/api/virtual-accounts',
  getVirtualAccount: (id: string) => `/api/virtual-accounts/${id}`,
  virtualAccountTransactions: (id: string) => `/api/virtual-accounts/${id}/transactions`,

  /** The company wallet, and what Bitnob says it holds for us. */
  wallets: '/api/balances',
} as const;

async function resolve(credential: BitnobCredential): Promise<string | undefined> {
  return typeof credential === 'string' ? credential : await credential();
}

export class BitnobClient {
  readonly #baseUrl: string;
  readonly #clientId: BitnobCredential;
  readonly #clientSecret: BitnobCredential;
  readonly #fetch: FetchLike;
  readonly #timeoutMs: number;
  readonly #requireSandbox: boolean;
  /** The in-flight or settled environment check. Single-flight, so several
   *  concurrent first requests ask once rather than once each — the same
   *  latch the client package puts on a token refresh. */
  #environment: Promise<void> | undefined;

  constructor(options: BitnobClientOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.#clientId = options.clientId;
    this.#clientSecret = options.clientSecret;
    this.#fetch = options.fetch ?? ((url, init) => fetch(url, init));
    this.#timeoutMs = options.timeoutMs ?? 15_000;
    this.#requireSandbox = options.requireSandbox ?? false;
  }

  /**
   * Whose credentials these are, and which environment they select.
   *
   * `GET /api/whoami` answers `environment: 'sandbox' | 'live'`. It is also
   * the endpoint their docs name for confirming that signing works at all,
   * so a failure here is the clearest possible signal on a fresh deployment.
   */
  async whoami(): Promise<unknown> {
    return this.request('GET', BITNOB_ENDPOINTS.whoami);
  }

  async #assertSandbox(): Promise<void> {
    if (!this.#requireSandbox) return;
    this.#environment ??= (async () => {
      const payload = await this.request('GET', BITNOB_ENDPOINTS.whoami, undefined, undefined, {
        skipEnvironmentCheck: true,
      });
      const environment = (payload as { data?: { environment?: unknown } }).data?.environment;

      /*
       * AN UNREADABLE ANSWER IS REFUSED, not tolerated.
       *
       * The tempting reading is that a missing field means "we could not
       * tell, carry on" — and carrying on is issuing real cards from a
       * staging box. The refusal names what it saw so the fix is one step.
       */
      if (environment !== 'sandbox') {
        throw new ProviderContractError(
          PROVIDER,
          `this deployment requires a Bitnob SANDBOX credential and ` +
            `/api/whoami reports ${JSON.stringify(environment)}. A staging ` +
            `instance signing with a live secret issues real cards and spends ` +
            `real money. Replace BITNOB_CLIENT_SECRET with the sandbox one.`,
        );
      }
    })();

    try {
      await this.#environment;
    } catch (cause) {
      // NOT cached as a failure. A network blip on the first request would
      // otherwise poison the client for the life of the process, and the
      // refusal we care about is the one that keeps being made.
      if (cause instanceof ProviderContractError) throw cause;
      this.#environment = undefined;
      throw cause;
    }
  }

  async request(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    idempotencyKey?: string,
    options?: { readonly skipEnvironmentCheck?: boolean },
  ): Promise<unknown> {
    // Before anything is sent, and before the timer starts. `skipEnvironmentCheck`
    // is what stops the check recursing through its own request.
    if (options?.skipEnvironmentCheck !== true) await this.#assertSandbox();

    /*
     * ASKED BEFORE THE TIMER STARTS, so a slow credential read cannot eat the
     * provider's own budget — and refused HERE rather than sent unsigned,
     * which Bitnob answers 401 to and which presents as "the credential is
     * wrong" when the truth is that there is none.
     */
    const [clientId, clientSecret] = await Promise.all([
      resolve(this.#clientId),
      resolve(this.#clientSecret),
    ]);
    const missing: string[] = [];
    if (clientId === undefined || clientId === '') missing.push('client id');
    if (clientSecret === undefined || clientSecret === '') missing.push('client secret');
    if (clientId === undefined || clientId === '' || clientSecret === undefined || clientSecret === '') {
      // Names WHICH is missing, both at once. A deployment upgrading from the
      // v1 bearer key will usually have neither, and being told about one at
      // a time is two incidents.
      throw new ProviderUnavailableError(
        'bitnob',
        `no Bitnob ${missing.join(' and no ')} is configured. Paste one on the ` +
          'Provider keys screen, or set BITNOB_CLIENT_ID and BITNOB_CLIENT_SECRET.',
      );
    }

    /*
     * SERIALISED ONCE, AND THE SAME STRING IS BOTH SIGNED AND SENT.
     *
     * Their docs are explicit that the signature covers the exact bytes
     * transmitted: re-serialising between signing and sending — reordering
     * keys, changing whitespace — produces a signature over a string that
     * never arrives, and the request is refused with nothing to say why. So
     * the body is a string from here down, never an object handed to `fetch`
     * to serialise a second time.
     *
     * A GET signs the empty string, which is also what it sends.
     */
    const requestBody = body === undefined ? '' : JSON.stringify(body);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);

    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}${path}`, {
        method,
        signal: controller.signal,
        headers: {
          ...signedHeaders(clientId, clientSecret, requestBody),
          'content-type': 'application/json',
          // Sent so a retry of a money-moving call cannot be applied twice on
          // their side either. Ours is enforced by the ledger's UNIQUE
          // constraint; this is the other half of the same guarantee.
          ...(idempotencyKey === undefined ? {} : { 'idempotency-key': idempotencyKey }),
        },
        ...(body === undefined ? {} : { body: requestBody }),
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
