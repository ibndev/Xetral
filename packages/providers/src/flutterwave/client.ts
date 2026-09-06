import {
  ProviderContractError,
  ProviderRejectedError,
  ProviderTimeoutError,
  ProviderUnavailableError,
} from '../ports/errors.js';

const PROVIDER = 'flutterwave';

/**
 * The HTTP boundary for Flutterwave.
 *
 * WRITTEN FROM Flutterwave's published v3 REST API, September 2026 — a source
 * AND a date, because the Bitnob table in this package carried a source
 * without one and decayed into a description of an API that no longer
 * answered. `scripts/verify-flutterwave-sandbox.mjs` is what settles it
 * against a real key, and the rule this repo records twice is that an
 * unsourced constant here is a bug rather than a detail.
 *
 * A BEARER TOKEN IS CORRECT HERE, like Paystack and unlike Bitnob. Three
 * providers in this package now, three auth schemes, and copying one onto
 * another produces a 401 that reads as a bad key — which is exactly what
 * `bitnob/signing.ts` exists because of.
 *
 * TWO CREDENTIALS, AND ONLY ONE AUTHORISES. The secret key signs nothing and
 * is borne on every call. The WEBHOOK HASH is a separate value an operator
 * types into Flutterwave's dashboard, sent back verbatim in `verif-hash` on
 * every inbound event. Paystack reuses its one secret for both, so the
 * instinct built one directory away is wrong here: a deployment holding only
 * the key authorises every outbound call correctly and rejects every webhook,
 * which from inside the app is indistinguishable from a broken integration.
 */
export type FlutterwaveFetch = (url: string, init: RequestInit) => Promise<Response>;

/** A value, or a function that resolves one per request. */
export type FlutterwaveCredential = string | (() => Promise<string | undefined>);

export interface FlutterwaveClientOptions {
  /** The bare host: `https://api.flutterwave.com`. Paths below carry `/v3`. */
  readonly baseUrl: string;
  /**
   * The SECRET key (`FLWSECK-…`), resolved PER REQUEST.
   *
   * A function rather than a string for the reason `BitnobClient` and
   * `PaystackClient` both record: a key pasted on `/admin/credentials` must
   * reach a port constructed at boot, and a rotation during an incident must
   * take effect within the credential cache rather than at the next restart.
   */
  readonly secretKey: FlutterwaveCredential;
  readonly fetch?: FlutterwaveFetch;
  readonly timeoutMs?: number;
}

/**
 * Every Flutterwave path this platform touches.
 *
 * The `/v3` prefix is ON THE PATH, not on the base URL, and that is
 * deliberate: `042` records a Bitnob deployment where a base ending in
 * `/api/v1` produced `/api/v1/api/cards`, because the version lived in two
 * places and only one of them was reviewed. Here the base is the bare host
 * and every path says its own version, so a misconfigured base URL is a
 * wrong HOST rather than a doubled segment.
 */
export const FLUTTERWAVE_ENDPOINTS = {
  /**
   * The hosted checkout — a redirect, not an inline widget.
   *
   * Their inline JavaScript needs the PUBLIC key in the page. This platform
   * does not have a public key slot on purpose: a redirect keeps every card
   * detail off our origin, which is the same reason the Paystack checkout is
   * a redirect.
   */
  payments: '/v3/payments',
  /**
   * VERIFY BY *OUR* REFERENCE, not by their transaction id.
   *
   * The id is minted by Flutterwave and only reaches us through the redirect
   * or the webhook — the two things this platform must not have to trust. Our
   * `tx_ref` names a row written before the payer left, so verification asks
   * about a payment WE recorded rather than about whatever the caller
   * mentioned. That is the rule 058 states for the Paystack checkout and it
   * is the same rule.
   */
  verifyByReference: (txRef: string) =>
    `/v3/transactions/verify_by_reference?tx_ref=${encodeURIComponent(txRef)}`,

  /** Paying out. `country` is an ISO code here — NG, GH, KE — unlike
   *  Paystack, whose `country` is the lowercase NAME. */
  banks: (country: string) => `/v3/banks/${encodeURIComponent(country)}`,
  resolveAccount: '/v3/accounts/resolve',
  transfers: '/v3/transfers',
  getTransfer: (id: string) => `/v3/transfers/${encodeURIComponent(id)}`,
} as const;

export class FlutterwaveClient {
  readonly #baseUrl: string;
  readonly #secretKey: FlutterwaveCredential;
  readonly #fetch: FlutterwaveFetch;
  readonly #timeoutMs: number;

  constructor(options: FlutterwaveClientOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.#secretKey = options.secretKey;
    this.#fetch = options.fetch ?? ((url, init) => fetch(url, init));
    this.#timeoutMs = options.timeoutMs ?? 15_000;
  }

  async request(method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown> {
    // Asked BEFORE the timer starts, so a slow credential read cannot eat the
    // provider's own budget — and refused here rather than sent as
    // `Bearer undefined`, which reads as a wrong key when the truth is that
    // there is no key.
    const secretKey =
      typeof this.#secretKey === 'string' ? this.#secretKey : await this.#secretKey();
    if (secretKey === undefined || secretKey === '') {
      throw new ProviderUnavailableError(
        PROVIDER,
        'no Flutterwave secret key is configured. Paste one on the Provider ' +
          'keys screen, or set FLUTTERWAVE_SECRET_KEY.',
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
          authorization: `Bearer ${secretKey}`,
          'content-type': 'application/json',
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (cause) {
      if (cause instanceof Error && cause.name === 'AbortError') {
        throw new ProviderTimeoutError(
          PROVIDER,
          `${method} ${path} did not answer within ${this.#timeoutMs}ms; whether it ` +
            `was applied is unknown, so reconcile rather than retry`,
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

    /*
     * FLUTTERWAVE CAN SAY NO WITH A 200, and its envelope is a STRING where
     * Paystack's is a boolean.
     *
     * `{ status: "success" | "error", message, data }`. Reading it as truthy
     * — the shape one file away in `paystack/client.ts` — makes `"error"`
     * pass, because a non-empty string is truthy. That is not a hypothetical
     * tidy-up: it is the single most likely way for a refusal to be recorded
     * here as a successful collection, so the test is an equality against
     * `'success'` and everything else is a rejection.
     */
    const envelope = payload as { status?: unknown; message?: unknown };
    if (!response.ok || envelope.status !== 'success') {
      throw new ProviderRejectedError(
        PROVIDER,
        typeof envelope.message === 'string'
          ? envelope.message
          : `${method} ${path} returned ${response.status}`,
        undefined,
        text,
      );
    }

    return payload;
  }
}
