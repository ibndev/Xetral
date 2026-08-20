import { createHmac } from 'node:crypto';
import { z } from 'zod';
import {
  ProviderContractError,
  ProviderRejectedError,
  ProviderTimeoutError,
  ProviderUnavailableError,
} from '../ports/errors.js';
import type {
  CatalogueItem,
  CatalogueQuery,
  FulfilmentPort,
  PurchaseLookup,
  PurchaseRequest,
  PurchaseResult,
  ServiceKind,
} from '../ports/fulfilment.js';

const PROVIDER = 'airalo';

/**
 * Airalo — eSIM data packages, priced in USD.
 *
 * VERIFIED against Airalo's official PHP SDK (`Constants/ApiConstants.php`,
 * `Services/OAuthService.php`, `Helpers/Signature.php`): the
 * `https://partners-api.airalo.com/v2/` base, the token/packages/orders slugs
 * below, the form-encoded client_credentials token exchange, and the
 * `airalo-signature` HMAC-SHA512 header.
 */
export const AIRALO_ENDPOINTS = {
  token: '/v2/token',
  packages: '/v2/packages',
  orders: '/v2/orders',
  order: (reference: string) => `/v2/orders?filter[code]=${encodeURIComponent(reference)}`,
} as const;

export interface AiraloOptions {
  readonly baseUrl: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly fetch?: (url: string, init: RequestInit) => Promise<Response>;
  readonly timeoutMs?: number;
  /** Injected so token expiry is testable without waiting. */
  readonly nowMs?: () => number;
}

const tokenResponse = z.object({
  data: z.object({
    access_token: z.string().min(1),
    expires_in: z.number(),
  }),
});

const packagesResponse = z.object({
  data: z.array(
    z.object({
      slug: z.string().min(1),
      operators: z.array(
        z.object({
          packages: z.array(
            z.object({
              id: z.string().min(1),
              title: z.string().min(1),
              // Airalo prices are USD as a JSON number, e.g. 4.5. Converted at
              // one place, through text, never by multiplying a float.
              price: z.union([z.string(), z.number()]),
            }),
          ),
        }),
      ),
    }),
  ),
});

const orderResponse = z.object({
  data: z.object({
    id: z.union([z.string(), z.number()]),
    code: z.string().optional(),
    status: z.string().optional(),
    sims: z
      .array(
        z.object({
          iccid: z.string().optional(),
          qrcode: z.string().optional(),
          lpa: z.string().optional(),
        }),
      )
      .optional(),
  }),
});

export class AiraloAdapter implements FulfilmentPort {
  readonly provider = PROVIDER;
  readonly service: ServiceKind = 'esim';

  readonly #options: AiraloOptions;
  readonly #fetch: (url: string, init: RequestInit) => Promise<Response>;
  readonly #now: () => number;

  /** Cached because Airalo's tokens are short-lived and every call needs one.
   *  Re-fetched a minute early, so a request never starts with a token that
   *  expires mid-flight. */
  #token: { value: string; expiresAtMs: number } | undefined;

  constructor(options: AiraloOptions) {
    this.#options = options;
    this.#fetch = options.fetch ?? ((url, init) => fetch(url, init));
    this.#now = options.nowMs ?? (() => Date.now());
  }

  async catalogue(query: CatalogueQuery): Promise<readonly CatalogueItem[]> {
    const suffix = query.group === undefined ? '' : `?filter[country]=${encodeURIComponent(query.group)}`;
    const payload = await this.#request('GET', `${AIRALO_ENDPOINTS.packages}${suffix}`);

    const parsed = packagesResponse.safeParse(payload);
    if (!parsed.success) {
      throw new ProviderContractError(PROVIDER, 'unexpected packages shape', parsed.error);
    }

    return parsed.data.data.flatMap((country) =>
      country.operators.flatMap((operator) =>
        operator.packages.map((pkg) => ({
          code: pkg.id,
          name: pkg.title,
          priceMinor: usdToCents(pkg.price),
          currency: 'USD' as const,
          metadata: { country: country.slug },
        })),
      ),
    );
  }

  async purchase(request: PurchaseRequest): Promise<PurchaseResult> {
    if (request.currency !== 'USD') {
      throw new ProviderContractError(PROVIDER, `Airalo settles in USD; got ${request.currency}`);
    }

    const payload = await this.#request('POST', AIRALO_ENDPOINTS.orders, {
      package_id: request.itemCode,
      quantity: 1,
      // Our reference travels as the order code, which is also how `status`
      // finds it again after a timeout.
      code: request.reference,
      description: `xetral:${request.reference}`,
    });

    return this.#toResult(payload, request.reference);
  }

  async status(lookup: PurchaseLookup): Promise<PurchaseResult> {
    const reference = lookup.reference;
    const payload = await this.#request('GET', AIRALO_ENDPOINTS.order(reference));
    return this.#toResult(payload, reference);
  }

  #toResult(payload: unknown, reference: string): PurchaseResult {
    const parsed = orderResponse.safeParse(payload);
    if (!parsed.success) {
      throw new ProviderContractError(PROVIDER, 'unexpected order shape', parsed.error);
    }

    const order = parsed.data.data;
    const providerReference = String(order.id);
    const sim = order.sims?.[0];

    // The activation payload IS the product. An order marked complete with no
    // SIM attached is not something to report as delivered.
    const delivery: Record<string, string> = {};
    if (sim?.iccid !== undefined) delivery['iccid'] = sim.iccid;
    if (sim?.qrcode !== undefined) delivery['qr_code'] = sim.qrcode;
    if (sim?.lpa !== undefined) delivery['lpa'] = sim.lpa;

    const status = order.status?.toLowerCase();
    if (status === 'failed' || status === 'cancelled') {
      return {
        status: 'failed',
        providerReference,
        delivery,
        failureReason: `order ${status}`,
      };
    }

    if (Object.keys(delivery).length === 0) {
      return { status: 'pending', providerReference: providerReference || reference, delivery };
    }

    return { status: 'delivered', providerReference, delivery };
  }

  /** Fetches and caches a bearer token, refreshing a minute before expiry. */
  async #accessToken(): Promise<string> {
    const cached = this.#token;
    if (cached !== undefined && cached.expiresAtMs > this.#now()) return cached.value;

    const credentials = {
      client_id: this.#options.clientId,
      client_secret: this.#options.clientSecret,
      grant_type: 'client_credentials',
    } as const;

    // Form-encoded, and unauthenticated — this call is what produces the token
    // every other call carries.
    const response = await this.#send(
      'POST',
      AIRALO_ENDPOINTS.token,
      undefined,
      undefined,
      credentials,
    );

    const parsed = tokenResponse.safeParse(response);
    if (!parsed.success) {
      throw new ProviderContractError(PROVIDER, 'unexpected token shape', parsed.error);
    }

    const { access_token, expires_in } = parsed.data.data;
    this.#token = {
      value: access_token,
      expiresAtMs: this.#now() + Math.max(0, expires_in - 60) * 1000,
    };
    return access_token;
  }

  async #request(method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown> {
    return this.#send(method, path, body, await this.#accessToken());
  }

  /**
   * `airalo-signature`: HMAC-SHA512 of the JSON payload, keyed by the client
   * secret, hex encoded.
   *
   * Required on every request that carries a body, including the token
   * exchange — which is the awkward one, because that body goes over the wire
   * FORM-encoded while the signature is computed over its JSON form. Signing
   * the form-encoded string instead produces a 401 that looks like bad
   * credentials. Verified against Airalo's official PHP SDK
   * (`Helpers/Signature.php`, `Services/OAuthService.php`).
   */
  #signature(serialisedPayload: string): string {
    return createHmac('sha512', this.#options.clientSecret)
      .update(serialisedPayload, 'utf8')
      .digest('hex');
  }

  async #send(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    token?: string,
    /** Token exchange only: Airalo wants that one form-encoded. */
    form?: Readonly<Record<string, string>>,
  ): Promise<unknown> {
    // Serialised ONCE, and the same string is both signed and sent. Computing
    // them separately is how a signature ends up covering a payload that
    // differs from the bytes on the wire — which Airalo rejects as a bad
    // signature and which is invisible in a diff.
    const serialised = body === undefined ? undefined : JSON.stringify(body);
    const signed = form !== undefined ? JSON.stringify(form) : serialised;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#options.timeoutMs ?? 20_000);

    let response: Response;
    try {
      response = await this.#fetch(`${this.#options.baseUrl.replace(/\/+$/, '')}${path}`, {
        method,
        signal: controller.signal,
        headers: {
          accept: 'application/json',
          'content-type':
            form === undefined ? 'application/json' : 'application/x-www-form-urlencoded',
          ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
          ...(signed === undefined ? {} : { 'airalo-signature': this.#signature(signed) }),
        },
        ...(form !== undefined
          ? { body: new URLSearchParams(form).toString() }
          : serialised === undefined
            ? {}
            : { body: serialised }),
      });
    } catch (cause) {
      if (cause instanceof Error && cause.name === 'AbortError') {
        throw new ProviderTimeoutError(
          PROVIDER,
          `${method} ${path} timed out; re-read the order rather than ordering again`,
          cause,
        );
      }
      throw new ProviderUnavailableError(PROVIDER, `${method} ${path} failed`, cause);
    } finally {
      clearTimeout(timeout);
    }

    const text = await response.text();

    if (response.status === 401) {
      // The cached token is dead. Dropped so the next call re-authenticates
      // rather than looping on a credential we already know is stale.
      this.#token = undefined;
    }
    if (response.status >= 500) {
      throw new ProviderUnavailableError(PROVIDER, `${method} ${path} returned ${response.status}`, text);
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

    if (!response.ok) {
      const detail = payload as { message?: unknown };
      throw new ProviderRejectedError(
        PROVIDER,
        typeof detail.message === 'string' ? detail.message : `${method} ${path} returned ${response.status}`,
        String(response.status),
        text,
      );
    }

    return payload;
  }
}

/** USD to cents without a float multiply. "4.5" and 4.5 both become 450n. */
export function usdToCents(value: string | number): bigint {
  const text = typeof value === 'number' ? value.toFixed(2) : value.trim();
  const match = /^(-)?(\d+)(?:\.(\d{1,2}))?$/.exec(text);
  if (match === null) {
    throw new ProviderContractError(PROVIDER, `not a USD amount: '${String(value)}'`);
  }
  const [, sign, whole = '0', fraction = ''] = match;
  const cents = BigInt(`${whole}${fraction.padEnd(2, '0')}`);
  return sign === '-' ? -cents : cents;
}

