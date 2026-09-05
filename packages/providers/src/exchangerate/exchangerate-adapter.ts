import {
  ProviderContractError,
  ProviderRejectedError,
  ProviderTimeoutError,
  ProviderUnavailableError,
} from '../ports/errors.js';
import type { ReferenceRatePort, ReferenceRates } from '../ports/reference-rate.js';

const PROVIDER = 'exchangerate';

/**
 * `ReferenceRatePort` implemented against ExchangeRate-API.
 *
 * THE WIRE CONTRACT, from their published v6 documentation:
 *
 *   - base URL   `https://v6.exchangerate-api.com`
 *   - latest     `GET /v6/<API KEY>/latest/<BASE>`
 *   - auth       THE KEY IS IN THE PATH. There is no header and no bearer
 *                token, which is unlike every other adapter here.
 *   - success    `{ "result": "success", "base_code": "USD",
 *                   "conversion_rates": { "NGN": 1650.12, ... },
 *                   "time_last_update_unix": 1717977601 }`
 *   - failure    `{ "result": "error", "error-type": "invalid-key" }`
 *
 * THE KEY IN THE PATH IS WHY `#url` IS BUILT IN ONE PLACE AND WHY NOTHING
 * HERE LOGS A URL. Everywhere else the credential is a header, so a logged
 * request line is harmless; here it would BE the credential. The errors below
 * quote `error-type` and never the address they came from.
 *
 * `result` IS CHECKED, NOT JUST THE STATUS. Their error responses come back
 * with a 4xx on most failures and the body is what names the cause — an
 * exhausted quota and a revoked key are different problems with the same
 * status, and an operator reading "quota-reached" knows to wait while
 * "invalid-key" means paste a new one.
 *
 * A FEED FAILURE IS NEVER FATAL TO ANYTHING. The worst outcome of every path
 * here is that rates stay at whatever was last published, which is a real cost
 * — customers are quoted an old price — and is why `stale_reference_rates`
 * exists to see it. What must not happen is a feed outage taking a money flow
 * down with it, so no caller of this port is on a customer's path.
 */
export type ExchangeRateFetchLike = (url: string, init: RequestInit) => Promise<Response>;

export const EXCHANGERATE_BASE_URL = 'https://v6.exchangerate-api.com';

export interface ExchangeRateAdapterOptions {
  /**
   * The v6 API key.
   *
   * A STRING OR A FUNCTION, the shape 026 requires: the database is
   * authoritative and the environment is the fallback, so a key pasted at
   * `/admin/credentials` has to reach an adapter that was built at boot.
   * Resolved PER CALL, which matters here for a specific reason — the free
   * tier has a request quota, and the answer to exhausting one is a new key
   * today rather than a release.
   */
  readonly apiKey: string | (() => Promise<string | undefined>);
  readonly baseUrl?: string;
  readonly fetch?: ExchangeRateFetchLike;
  readonly timeoutMs?: number;
}

export class ExchangeRateAdapter implements ReferenceRatePort {
  readonly provider = PROVIDER;

  readonly #apiKey: string | (() => Promise<string | undefined>);
  readonly #baseUrl: string;
  readonly #fetch: ExchangeRateFetchLike;
  readonly #timeoutMs: number;

  constructor(options: ExchangeRateAdapterOptions) {
    this.#apiKey = options.apiKey;
    this.#baseUrl = (options.baseUrl ?? EXCHANGERATE_BASE_URL).replace(/\/+$/, '');
    this.#fetch = options.fetch ?? ((url, init) => fetch(url, init));
    this.#timeoutMs = options.timeoutMs ?? 15_000;
  }

  async latest(base: string): Promise<ReferenceRates> {
    const key = typeof this.#apiKey === 'string' ? this.#apiKey : await this.#apiKey();
    if (key === undefined || key === '') {
      // A configuration fault, not an outage. `ProviderRejectedError` is not
      // retryable, so the worker records it and stops rather than spinning on
      // a call that cannot succeed until a person acts.
      throw new ProviderRejectedError(
        PROVIDER,
        'no ExchangeRate-API key is set. Paste one at /admin/credentials, or ' +
          'set EXCHANGERATE_API_KEY. Rates stay at whatever was last published.',
        'no_api_key',
      );
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);

    let response: Response;
    try {
      response = await this.#fetch(
        `${this.#baseUrl}/v6/${encodeURIComponent(key)}/latest/${encodeURIComponent(base)}`,
        { method: 'GET', signal: controller.signal },
      );
    } catch (error: unknown) {
      // A TIMEOUT HERE IS ORDINARY, unlike everywhere else in this codebase.
      // Nothing was asked to happen, so nothing may half-have-happened: the
      // worst case is one sync that did not run.
      if (error instanceof Error && error.name === 'AbortError') {
        throw new ProviderTimeoutError(PROVIDER, `no answer in ${this.#timeoutMs}ms`);
      }
      throw new ProviderUnavailableError(PROVIDER, describe(error));
    } finally {
      clearTimeout(timer);
    }

    const body: unknown = await response.json().catch(() => undefined);
    const result = readString(body, 'result');

    if (result !== 'success') {
      // THE BODY NAMES THE CAUSE AND THE STATUS DOES NOT. An exhausted quota
      // and a revoked key are both a 4xx here, and they need different
      // actions from an operator.
      const cause = readString(body, 'error-type') ?? `http ${response.status}`;
      if (cause === 'quota-reached' || response.status === 429) {
        throw new ProviderUnavailableError(PROVIDER, 'the request quota is exhausted');
      }
      if (response.status >= 500) throw new ProviderUnavailableError(PROVIDER, cause);
      throw new ProviderRejectedError(PROVIDER, cause, cause);
    }

    const rates = (body as { conversion_rates?: unknown }).conversion_rates;
    if (typeof rates !== 'object' || rates === null) {
      throw new ProviderContractError(PROVIDER, 'a success carried no conversion_rates');
    }

    const parsed = new Map<string, string>();
    for (const [code, value] of Object.entries(rates as Record<string, unknown>)) {
      const decimal = decimalFrom(value);
      if (decimal !== undefined) parsed.set(code.toUpperCase(), decimal);
    }
    if (parsed.size === 0) {
      throw new ProviderContractError(PROVIDER, 'conversion_rates held no usable rate');
    }

    const updated = (body as { time_last_update_unix?: unknown }).time_last_update_unix;
    return {
      base: readString(body, 'base_code') ?? base.toUpperCase(),
      rates: parsed,
      ...(typeof updated === 'number' && Number.isFinite(updated)
        ? { asOf: new Date(updated * 1000) }
        : {}),
    };
  }
}

/**
 * A JSON number into a decimal string, and WHAT THIS DOES ABOUT THE FLOAT.
 *
 * The rule in this codebase is that money is never a float, and it holds:
 * nothing here is money. This is a REFERENCE RATE, and the provider publishes
 * it as a JSON number — so by the time `JSON.parse` hands it over, whatever
 * precision was going to be lost is already gone, exactly as `parseMicro`
 * records about micro-units.
 *
 * The difference from `parseMicro` is what the loss COSTS, which is why this
 * converts where that one refuses. There, an unsafe integer is a unit of
 * somebody's money that cannot be recovered. Here it is the seventh decimal
 * place of an indicative rate that the spread on top dwarfs, and refusing it
 * would mean no corridor is priced at all.
 *
 * SIX DECIMAL PLACES, fixed, because that is where these feeds stop being
 * meaningful and because a fixed width makes two syncs comparable as TEXT —
 * which is what decides whether a rate is republished. A varying width would
 * make `1650.1` and `1650.100000` look like a price change.
 */
function decimalFrom(value: unknown): string | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined;
  // Beyond this a rate is not a rate — a currency worth 10^12 of another is a
  // redenomination somebody has to look at, not a number to publish quietly.
  if (value > 1e12) return undefined;
  return value.toFixed(6);
}

function readString(body: unknown, key: string): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const value = (body as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
