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
  /**
   * A TRACE OF WHAT WAS ACTUALLY SENT, and what came back.
   *
   * WHY IT IS ON THE CLIENT AND NOT IN EACH ADAPTER. Three of them build
   * bodies for this rail — a checkout, a transfer, a name enquiry — and the
   * question an operator asks is the same every time: what did we send, and
   * what did they say about it. A hook per adapter would be three copies that
   * drift, which is the argument the fulfilment port makes about three
   * contract suites, and the one this file already makes about `/v3` living
   * in two places.
   *
   * THE FAILURE IT EXISTS FOR: a Ghanaian checkout answered
   * `checkout_unavailable` and a Nigerian one worked, and nothing anywhere
   * could say whether the currency we sent was literally `GHS`, whether
   * `payment_options` reached them at all, or whether Flutterwave had refused
   * for a reason of their own. Three plausible causes, one message, and no
   * way to tell them apart without a redeploy carrying a `console.log`.
   *
   * IT IS OPTIONAL AND THIS PACKAGE NEVER LOGS. A port that wrote to a logger
   * would decide the format, the level and the redaction for every caller;
   * the API passes one in, and that is where `redactPayload` runs — the
   * payer's address and number are not what a diagnostic needs, and a log
   * line is copied into tickets.
   */
  readonly onTrace?: FlutterwaveTrace;
}

/** What `onTrace` is handed. `body` is the object as serialised, not a
 *  string, so the observer decides how to redact and render it. */
export interface FlutterwaveTraceEvent {
  readonly method: 'GET' | 'POST';
  readonly path: string;
  readonly body: unknown;
  /** Absent until the call has answered. */
  readonly httpStatus?: number;
  /** Flutterwave's own `status`/`message` envelope, where one came back. */
  readonly envelopeStatus?: string | undefined;
  readonly message?: string | undefined;
  readonly outcome: 'sent' | 'accepted' | 'refused' | 'unreachable';
}

export type FlutterwaveTrace = (event: FlutterwaveTraceEvent) => void;

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

  /**
   * DEDICATED ACCOUNT NUMBERS, and the two reads a deposit into one needs.
   *
   * A permanent account is one `tx_ref` that many payments arrive under, so
   * `verifyByReference` — which answers ONE transaction — cannot confirm a
   * deposit into it. A deposit is verified by THEIR transaction id instead,
   * and the account's history is listed by OUR `tx_ref`. Both are published v3
   * paths (`/v3/transactions/:id/verify`, `/v3/transactions?tx_ref=`),
   * September 2026; the list's filter is additionally re-checked row by row
   * in the adapter, because a filter a server ignores returns everybody's
   * money.
   */
  virtualAccounts: '/v3/virtual-account-numbers',
  virtualAccount: (orderRef: string) =>
    `/v3/virtual-account-numbers/${encodeURIComponent(orderRef)}`,
  verifyTransaction: (id: string) => `/v3/transactions/${encodeURIComponent(id)}/verify`,
  transactionsByReference: (txRef: string) =>
    `/v3/transactions?tx_ref=${encodeURIComponent(txRef)}&status=successful`,

  /** Paying out. `country` is an ISO code here — NG, GH, KE — unlike
   *  Paystack, whose `country` is the lowercase NAME. */
  banks: (country: string) => `/v3/banks/${encodeURIComponent(country)}`,
  /**
   * THE BRANCHES OF ONE BANK, keyed by the bank's ID rather than its code.
   *
   * Their bank list answers `{ id, code, name }` and these two are different
   * values — `id: 280`, `code: "GH280100"`. Passing the code here answers
   * nothing, which on the Ghanaian bank rail is a transfer that cannot be
   * built rather than a list that is short.
   */
  branches: (bankId: string) => `/v3/banks/${encodeURIComponent(bankId)}/branches`,
  resolveAccount: '/v3/accounts/resolve',
  transfers: '/v3/transfers',
  getTransfer: (id: string) => `/v3/transfers/${encodeURIComponent(id)}`,
} as const;

export class FlutterwaveClient {
  readonly #baseUrl: string;
  readonly #secretKey: FlutterwaveCredential;
  readonly #fetch: FlutterwaveFetch;
  readonly #timeoutMs: number;
  readonly #trace: FlutterwaveTrace;

  constructor(options: FlutterwaveClientOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.#secretKey = options.secretKey;
    this.#fetch = options.fetch ?? ((url, init) => fetch(url, init));
    this.#timeoutMs = options.timeoutMs ?? 15_000;
    /*
     * A NO-OP RATHER THAN AN `undefined` CHECK AT FOUR CALL SITES, and it can
     * never fail the call it describes — 037's rule about recording a
     * provider's health, which is the same rule: a diagnostic that can take
     * down the thing it observes is worse than no diagnostic.
     */
    const given = options.onTrace;
    this.#trace =
      given === undefined
        ? () => {}
        : (event) => {
            try {
              given(event);
            } catch {
              /* observing must never break the observed */
            }
          };
  }

  /**
   * TEST KEY OR LIVE KEY, read off the key itself.
   *
   * FLUTTERWAVE'S SANDBOX CANNOT VERIFY A REAL ACCOUNT. Their own
   * documentation says only test accounts resolve in test mode, and a real
   * one returns an error — so a deployment holding `FLWSECK_TEST-…` gets
   * every genuine Ghanaian mobile money number refused by
   * `/v3/accounts/resolve`, correctly, for a reason that has nothing to do
   * with the number.
   *
   * FROM INSIDE THE APP THAT IS INDISTINGUISHABLE FROM A WRONG NUMBER, which
   * is why this exists: the refusal is recorded with the key's mode beside
   * it, so an operator reading `/admin/providers` sees "test key" rather than
   * three rounds of customers being told to check digits that were correct.
   * It is a claim about the KEY'S PREFIX and never about its value — nothing
   * here returns, logs or stores the key.
   */
  async keyMode(): Promise<'test' | 'live' | 'unset' | 'unknown'> {
    const key = typeof this.#secretKey === 'string' ? this.#secretKey : await this.#secretKey();
    if (key === undefined || key === '') return 'unset';
    if (/^FLWSECK_TEST-/i.test(key)) return 'test';
    if (/^FLWSECK-/i.test(key)) return 'live';
    return 'unknown';
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

    /*
     * EMITTED BEFORE THE CALL, not after it. A request that times out or
     * never connects produces no response to log beside, and that is exactly
     * the case somebody is trying to diagnose.
     */
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
    const envelopeStatus = typeof envelope.status === 'string' ? envelope.status : undefined;
    const message = typeof envelope.message === 'string' ? envelope.message : undefined;

    if (!response.ok || envelope.status !== 'success') {
      /*
       * THEIR SENTENCE, ALONGSIDE OUR REQUEST, in one line. Apart, an operator
       * has a refusal in one place and no way to see what it was about; this
       * is what turns "the Ghana link says try again later" into "they
       * refused `account` because the account is not enabled for it".
       */
      this.#trace({
        method,
        path,
        body,
        httpStatus: response.status,
        envelopeStatus,
        message,
        outcome: 'refused',
      });
      throw new ProviderRejectedError(
        PROVIDER,
        typeof envelope.message === 'string'
          ? envelope.message
          : `${method} ${path} returned ${response.status}`,
        undefined,
        text,
      );
    }

    this.#trace({
      method,
      path,
      body,
      httpStatus: response.status,
      envelopeStatus,
      message,
      outcome: 'accepted',
    });

    return payload;
  }
}
