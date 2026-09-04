import {
  ProviderContractError,
  ProviderRejectedError,
  ProviderTimeoutError,
  ProviderUnavailableError,
} from '../ports/errors.js';

const PROVIDER = 'paystack';

/**
 * The HTTP boundary for Paystack.
 *
 * VERIFIED against Paystack's own published Node client (npm `paystack-api`,
 * `resources/*.js` and `index.js`), September 2026 — a source AND a date,
 * because the Bitnob table in this package carried a source without one and
 * decayed.
 *
 * A BEARER TOKEN IS CORRECT HERE, and it is worth saying out loud one file
 * away from `bitnob/signing.ts`, which exists because a bearer token was
 * wrong there. Paystack authenticates with `Authorization: Bearer <secret
 * key>` and signs nothing on the request; Bitnob v2 signs every request and
 * bears nothing. Two providers, two schemes, and copying either onto the
 * other produces a 401 that reads as a bad key.
 */
export type PaystackFetch = (url: string, init: RequestInit) => Promise<Response>;

/** A value, or a function that resolves one per request. */
export type PaystackCredential = string | (() => Promise<string | undefined>);

export interface PaystackClientOptions {
  /** The bare host: `https://api.paystack.co`. Paths below carry no prefix. */
  readonly baseUrl: string;
  /**
   * The SECRET key, resolved PER REQUEST.
   *
   * A function rather than a string for the reason `BitnobClient` records: a
   * key pasted on `/admin/credentials` must reach a port that was constructed
   * at boot, and a rotation during an incident must take effect within the
   * credential cache rather than at the next restart.
   */
  readonly secretKey: PaystackCredential;
  readonly fetch?: PaystackFetch;
  readonly timeoutMs?: number;
}

/**
 * Every Paystack path this platform touches.
 *
 * `POST /customer` is NOT a KYC step and that is the whole reason Paystack is
 * the default rail. It takes a name, an email address and a phone number —
 * what signup already collects — and returns a customer code. Bitnob's
 * equivalent requires a verified BVN before it will do anything.
 *
 * `POST /customer/:code/identification` is where a BVN goes when one is
 * needed, which under CBN tiering is at the point a customer wants more than
 * a tier 1 ceiling — not at the point they want somewhere to receive money.
 */
export const PAYSTACK_ENDPOINTS = {
  createCustomer: '/customer',
  getCustomer: (code: string) => `/customer/${code}`,
  /** BVN or NIN, for lifting a customer past tier 1. */
  validateCustomer: (code: string) => `/customer/${code}/identification`,

  createDedicatedAccount: '/dedicated_account',
  /*
   * WHICH NUBAN PROVIDERS THIS INTEGRATION MAY NAME.
   *
   * The single most useful call for an operator, and the one nothing made.
   * `preferred_bank` is a SLUG — `wema-bank`, `titan-paystack`, `test-bank` —
   * and a business is approved for a subset. Naming one outside that subset
   * is refused with a message about the bank, which is indistinguishable on
   * screen from "dedicated accounts are not enabled for you at all". This
   * endpoint separates the two: it answers the list when the product is
   * enabled, and refuses when it is not.
   */
  dedicatedAccountProviders: '/dedicated_account/available_providers',
  getDedicatedAccount: (id: string) => `/dedicated_account/${id}`,
  /*
   * `active` AND `currency` ARE REQUIRED, and omitting them is not a lenient
   * default — it is a refusal.
   *
   * Paystack's own SDK marks both with a `*` (`args: ["active*", "currency*",
   * …]`), and this sent only `customer`. The refusal is swallowed by the
   * caller, which is why it did not surface as an outage; the cost was
   * quieter and worse. The look-before-create guard silently never found an
   * existing account, so every retry after a timeout went on to CREATE — and
   * `POST /dedicated_account` has no idempotency key, so the second live
   * account number is one nobody is watching.
   */
  listDedicatedAccounts: (customerCode: string) =>
    `/dedicated_account?active=true&currency=NGN&customer=${encodeURIComponent(customerCode)}`,

  /** Reconciliation: what Paystack recorded that no webhook told us about. */
  transactions: (customerCode: string) =>
    `/transaction?customer=${encodeURIComponent(customerCode)}&status=success`,

  /*
   * PAYING OUT. Verified against Paystack's own published Node SDK
   * (`paystack-api@2.0.6`, resources/misc.js, verification.js,
   * transfer_recipient.js, transfer.js) rather than guessed — the rule this
   * repo records twice about Bitnob, where a table of plausible constants
   * passed every test written from the same assumptions and failed on the
   * first live call.
   *
   * `country` is Paystack's own slug ("nigeria"), not an ISO code.
   */
  banks: (country: string, currency: string) =>
    `/bank?country=${encodeURIComponent(country)}&currency=${encodeURIComponent(currency)}&perPage=100`,
  resolveAccount: (accountNumber: string, bankCode: string) =>
    `/bank/resolve?account_number=${encodeURIComponent(accountNumber)}` +
    `&bank_code=${encodeURIComponent(bankCode)}`,
  createTransferRecipient: '/transferrecipient',
  createTransfer: '/transfer',
  getTransfer: (id: string) => `/transfer/${encodeURIComponent(id)}`,
} as const;

export class PaystackClient {
  readonly #baseUrl: string;
  readonly #secretKey: PaystackCredential;
  readonly #fetch: PaystackFetch;
  readonly #timeoutMs: number;

  constructor(options: PaystackClientOptions) {
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
        'no Paystack secret key is configured. Paste one on the Provider keys ' +
          'screen, or set PAYSTACK_SECRET_KEY.',
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
     * PAYSTACK CAN SAY NO WITH A 200.
     *
     * Every response carries `status: true | false`, and a refusal — an
     * unknown customer, a bank that cannot issue — arrives as `200` with
     * `status: false` and a `message`. Reading only the HTTP code would treat
     * that as success and hand the caller a body with no `data` in it, which
     * then fails a schema somewhere far away from the reason.
     */
    const envelope = payload as { status?: unknown; message?: unknown };
    if (!response.ok || envelope.status === false) {
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

  /**
   * Is the key in use a TEST key?
   *
   * WHY A CLIENT ANSWERS THIS AT ALL, when nothing else in this package cares
   * which environment it is pointed at: Paystack's test and live integrations
   * are not the same integration, and two things differ in ways that produce
   * a refusal rather than a warning.
   *
   * A dedicated account on a TEST key is only ever issued at `test-bank`;
   * naming `wema-bank` there is refused. And a customer code created on one
   * domain is meaningless on the other — Paystack answers "Customer code is
   * invalid for your live domain" — so a stored code has to be discarded when
   * the key it was created under is replaced.
   *
   * Read from the key's own prefix rather than from a setting, because the
   * key IS the environment: `sk_test_…` and `sk_live_…`. A separate
   * "environment" setting would be a second copy of that fact, and the copy
   * that drifts is the one that turns a working configuration into a refusal
   * nobody can explain.
   */
  async isTestKey(): Promise<boolean> {
    const key = typeof this.#secretKey === 'string' ? this.#secretKey : await this.#secretKey();
    return key !== undefined && key.startsWith('sk_test');
  }
}

/**
 * Does this refusal mean "that customer code belongs to the other domain"?
 *
 * PAYSTACK'S TEST AND LIVE DOMAINS DO NOT SHARE CUSTOMERS. A code minted
 * while a `sk_test_…` key was in use is rejected the moment a `sk_live_…` key
 * replaces it, and the refusal is a sentence rather than a code — so the only
 * way to recognise it is to read the message.
 *
 * The consequence if nobody does: a deployment that was set up on test keys
 * and then given live ones refuses to open an account for every customer who
 * had already been through the flow, for ever, with a message an operator
 * reads as "Paystack is rejecting our key". Which it is — for one customer's
 * stored code, not for the credential.
 *
 * Matched loosely on purpose: the exact sentence is theirs to change, and the
 * cost of a false positive is one extra customer record, while the cost of a
 * miss is a customer who can never be paid.
 */
export function isStaleCustomerRefusal(message: string): boolean {
  const text = message.toLowerCase();
  return (
    text.includes('invalid for your live domain') ||
    text.includes('invalid for your test domain') ||
    (text.includes('customer') && text.includes('domain'))
  );
}
