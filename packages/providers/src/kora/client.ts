import {
  ProviderContractError,
  ProviderRejectedError,
  ProviderTimeoutError,
  ProviderUnavailableError,
  ProviderNotSentError,
  neverConnected,
} from '../ports/errors.js';

const PROVIDER = 'kora';

/**
 * The HTTP boundary for Kora (Korapay).
 *
 * WRITTEN FROM developers.korapay.com, read 3 October 2026 — a source AND a
 * date, because this package has twice carried a table of plausible
 * constants that decayed into a description of an API that no longer
 * answered. The guides cited beside each path below are where it came from;
 * the API reference at docs.korapay.com was NOT reachable when this was
 * written, so nothing here was taken from it, and a path no guide states is
 * not in this file.
 *
 * ONE HOST FOR TEST AND LIVE. "The API keys in test mode are different from
 * the API keys in Live mode" (API Keys guide) — the KEY selects the
 * environment, exactly as Bitnob's secret does, so a staging guard cannot be
 * a test on the URL. `config.ts` reads the key's prefix instead.
 *
 * A BEARER TOKEN, LIKE PAYSTACK. "Authorization: Bearer {SECRET_KEY}"
 * (Checkout Redirect guide). The same secret key also signs every webhook —
 * "an HMAC SHA256 signature of ONLY the data object ... signed using your
 * secret key" (Webhooks guide) — so ONE credential both authorises calls and
 * verifies events, and a separate webhook-secret box would be a value
 * nothing reads.
 */
export type KoraFetch = (url: string, init: RequestInit) => Promise<Response>;

/** A value, or a function that resolves one per request. */
export type KoraCredential = string | (() => Promise<string | undefined>);

export interface KoraClientOptions {
  /**
   * `https://api.korapay.com/merchant`. Every guide writes its paths as
   * `{{baseurl}}/api/v1/...` or, in full, `https://api.korapay.com/merchant/api/v1/...`,
   * so the base is the host plus `/merchant` and each path below carries its
   * own `/api/v1` — a misconfigured base is then a wrong HOST rather than a
   * doubled segment, 042's lesson about `/api/v1/api/cards`.
   */
  readonly baseUrl: string;
  /** The SECRET key, resolved PER REQUEST so a key pasted on
   *  `/admin/credentials` reaches a port constructed at boot. */
  readonly secretKey: KoraCredential;
  readonly fetch?: KoraFetch;
  readonly timeoutMs?: number;
  /** What was sent and what came back — see `KoraTraceEvent`. */
  readonly onTrace?: KoraTrace;
}

/** What `onTrace` is handed. `body` is the object as serialised. */
export interface KoraTraceEvent {
  readonly method: 'GET' | 'POST';
  readonly path: string;
  readonly body: unknown;
  readonly httpStatus?: number;
  readonly message?: string | undefined;
  readonly outcome: 'sent' | 'accepted' | 'refused' | 'unreachable';
}

export type KoraTrace = (event: KoraTraceEvent) => void;

/** The default host, the only one the guides name. */
export const KORA_DEFAULT_BASE_URL = 'https://api.korapay.com/merchant';

/**
 * Every Kora path this platform touches, each with the guide that states it.
 */
export const KORA_ENDPOINTS = {
  /** Checkout Redirect guide: "initialize charge endpoint". */
  initializeCharge: '/api/v1/charges/initialize',
  /** NGN Virtual Bank Accounts guide: "Charge Query API". Verifies a checkout
   *  AND a deposit into a virtual account, by the reference the webhook named. */
  charge: (reference: string) => `/api/v1/charges/${encodeURIComponent(reference)}`,
  /** NGN/KES Virtual Bank Accounts guides: create, and query by OUR reference. */
  virtualAccounts: '/api/v1/virtual-bank-account',
  virtualAccount: (accountReference: string) =>
    `/api/v1/virtual-bank-account/${encodeURIComponent(accountReference)}`,
  /** NGN Virtual Bank Accounts guide: "Fetching the Transactions on an NGN
   *  Virtual Bank Account", a GET with the account number as a query. */
  virtualAccountTransactions: (accountNumber: string) =>
    `/api/v1/virtual-bank-account/transactions?account_number=${encodeURIComponent(accountNumber)}`,
  /** Payout API guide, step 1. `countryCode` is NG, KE, ZA for banks. */
  banks: (country: string) => `/api/v1/misc/banks?countryCode=${encodeURIComponent(country)}`,
  /** Payout API guide, step 1. KE and GH are the documented examples. */
  mobileMoneyOperators: (country: string) =>
    `/api/v1/misc/mobile-money?countryCode=${encodeURIComponent(country)}`,
  /** Payout API guide, step 2: "Bank account verification for Nigerian and
   *  Kenyan Banks". */
  resolveBank: '/api/v1/misc/banks/resolve',
  /** Payout API guide, step 2: "Mobile Money account verification for
   *  Ghanaian mobile money networks". */
  resolveMobileMoney: '/api/v1/misc/mobile-money/resolve',
  /** Payout API guide, step 4a. */
  disburse: '/api/v1/transactions/disburse',
  /** Bulk Payouts guide, "Fetch Payout Transaction": a payout BY OUR
   *  REFERENCE — Kora has no separate payout id. */
  transaction: (reference: string) => `/api/v1/transactions/${encodeURIComponent(reference)}`,
  /** Balance API guide. */
  balances: '/api/v1/balances',
} as const;

/**
 * KORA'S OWN SENTENCES FOR "WE DO NOT KNOW", which must never read as "no".
 *
 * The Errors guide: "Internal Server Error — This response does not indicate
 * any error with your request, so you can requery the transaction", and
 * "Invalid authorization key — This response does not indicate any error with
 * your request. Requery the transaction to get the final status." And a
 * duplicate reference means a transaction under it already EXISTS.
 *
 * Each arrives as `status: false`, which the envelope would otherwise turn
 * into a `ProviderRejectedError` — and a rejection is what `providerDidNothing`
 * reads as "nothing left, give the money back". On a payout that would refund
 * a transfer Kora may have made. So these are UNAVAILABLE: the money stays
 * held and the payout is asked about by its reference, which is what the
 * guide says to do.
 */
const UNKNOWN_OUTCOME = /internal server error|invalid authorization key|duplicate/i;

export class KoraClient {
  readonly #baseUrl: string;
  readonly #secretKey: KoraCredential;
  readonly #fetch: KoraFetch;
  readonly #timeoutMs: number;
  readonly #trace: KoraTrace;

  constructor(options: KoraClientOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.#secretKey = options.secretKey;
    this.#fetch = options.fetch ?? ((url, init) => fetch(url, init));
    this.#timeoutMs = options.timeoutMs ?? 15_000;
    const given = options.onTrace;
    // Observing must never break the observed — 037's rule.
    this.#trace =
      given === undefined
        ? () => {}
        : (event) => {
            try {
              given(event);
            } catch {
              /* swallowed */
            }
          };
  }

  /** The current secret, for verifying a webhook. Never logged or returned
   *  over HTTP; the webhook service is its only reader. */
  async secret(): Promise<string | undefined> {
    const key = typeof this.#secretKey === 'string' ? this.#secretKey : await this.#secretKey();
    return key === undefined || key === '' ? undefined : key;
  }

  /**
   * TEST KEY OR LIVE KEY, from the key's prefix and never from its value.
   *
   * `sk_live_` is the prefix the Webhooks guide's own samples carry
   * (`const secretKey = sk_live_******`). A test key's prefix is not stated
   * in any guide, so anything that is not `sk_live_` reads as `unknown`
   * rather than as `test` — a claim this file could not source.
   */
  async keyMode(): Promise<'live' | 'unset' | 'unknown'> {
    const key = await this.secret();
    if (key === undefined) return 'unset';
    return key.startsWith('sk_live_') ? 'live' : 'unknown';
  }

  async request(method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown> {
    const secretKey = await this.secret();
    if (secretKey === undefined) {
      throw new ProviderNotSentError(
        PROVIDER,
        'no Kora secret key is configured. Paste one on the Provider keys screen, ' +
          'or set KORA_SECRET_KEY.',
      );
    }

    // Emitted BEFORE the call: a request that never answers leaves nothing
    // else to log beside, and that is the case somebody is diagnosing.
    this.#trace({ method, path, body, outcome: 'sent' });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);

    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}${path}`, {
        method,
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${secretKey}`,
          'content-type': 'application/json',
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (cause) {
      this.#trace({ method, path, body, outcome: 'unreachable' });
      if (cause instanceof Error && cause.name === 'AbortError') {
        throw new ProviderTimeoutError(
          PROVIDER,
          `${method} ${path} did not answer within ${this.#timeoutMs}ms; whether it ` +
            `was applied is unknown, so reconcile rather than retry`,
          cause,
        );
      }
      if (neverConnected(cause)) {
        throw new ProviderNotSentError(PROVIDER, `${method} ${path} could not connect`, cause);
      }
      throw new ProviderUnavailableError(PROVIDER, `${method} ${path} failed`, cause);
    } finally {
      clearTimeout(timer);
    }

    const text = await response.text();

    /*
     * A 5XX IS NOT A FAILED PAYOUT. The Payout API guide, verbatim: "DO NOT
     * treat request errors such as 502 Bad Gateway, 504 Gateway Timeout, 503
     * Service Unavailable, 500 Internal Server Error, etc, as failed payout."
     */
    if (response.status >= 500) {
      this.#trace({ method, path, body, httpStatus: response.status, outcome: 'refused' });
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
      throw new ProviderContractError(
        PROVIDER,
        `${method} ${path} returned ${response.status} with a non-JSON body`,
        cause,
      );
    }

    /*
     * THE ENVELOPE IS A BOOLEAN — `{ "status": true, "message", "data" }` in
     * every guide's sample — and it is tested as `=== true`, not as truthy.
     * A string `"false"` is truthy, and a refusal read as a success is a
     * collection recorded that never happened.
     */
    const envelope = payload as { status?: unknown; message?: unknown };
    const message = typeof envelope.message === 'string' ? envelope.message : undefined;

    if (!response.ok || envelope.status !== true) {
      this.#trace({
        method,
        path,
        body,
        httpStatus: response.status,
        message,
        outcome: 'refused',
      });
      const said = message ?? `${method} ${path} returned ${response.status}`;
      if (message !== undefined && UNKNOWN_OUTCOME.test(message)) {
        throw new ProviderUnavailableError(PROVIDER, said, text);
      }
      throw new ProviderRejectedError(PROVIDER, said, `http_${response.status}`, text);
    }

    this.#trace({ method, path, body, httpStatus: response.status, message, outcome: 'accepted' });
    return payload;
  }
}
