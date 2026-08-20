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
  PurchaseRequest,
  PurchaseResult,
  ServiceKind,
  TargetVerification,
  VerifiedTarget,
} from '../ports/fulfilment.js';

const PROVIDER = 'vtpass';

/**
 * VTpass — airtime, data bundles and utility bills, in NGN.
 *
 * CONFIRM BEFORE GO-LIVE. The endpoint paths, the auth headers and the exact
 * response codes below are collected here, in one place, because they could not
 * be verified from this repository. Confirming them against VTpass's live
 * documentation should be a small diff to this file and nothing else.
 */
export const VTPASS_ENDPOINTS = {
  purchase: '/api/pay',
  status: '/api/requery',
  variations: '/api/service-variations',
  verify: '/api/merchant-verify',
} as const;

/**
 * VTpass's own response codes. `000` is success and `099` is "accepted, still
 * processing" — the distinction that makes `pending` a real state rather than
 * an optimistic guess.
 */
const CODE_SUCCESS = '000';
const CODE_PROCESSING = '099';

export interface VtpassOptions {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly secretKey: string;
  readonly publicKey: string;
  readonly service: ServiceKind;
  readonly fetch?: (url: string, init: RequestInit) => Promise<Response>;
  readonly timeoutMs?: number;
}

const variationsResponse = z.object({
  content: z.object({
    variations: z.array(
      z.object({
        variation_code: z.string().min(1),
        name: z.string().min(1),
        variation_amount: z.union([z.string(), z.number()]),
      }),
    ),
  }),
});

const purchaseResponse = z.object({
  code: z.string().min(1),
  requestId: z.string().optional(),
  content: z
    .object({
      transactions: z
        .object({
          status: z.string().optional(),
          transactionId: z.string().optional(),
        })
        .optional(),
    })
    .optional(),
  response_description: z.string().optional(),
  // Utility purchases return a token the customer types into their meter.
  purchased_code: z.string().optional(),
  mainToken: z.string().optional(),
});

const verifyResponse = z.object({
  code: z.string().min(1),
  content: z.object({
    Customer_Name: z.union([z.string(), z.boolean()]).optional(),
    Address: z.string().optional(),
    Meter_Number: z.string().optional(),
  }),
});

export class VtpassAdapter implements FulfilmentPort, TargetVerification {
  readonly provider = PROVIDER;
  readonly service: ServiceKind;

  readonly #options: VtpassOptions;
  readonly #fetch: (url: string, init: RequestInit) => Promise<Response>;

  constructor(options: VtpassOptions) {
    this.#options = options;
    this.service = options.service;
    this.#fetch = options.fetch ?? ((url, init) => fetch(url, init));
  }

  async catalogue(query: CatalogueQuery): Promise<readonly CatalogueItem[]> {
    // Airtime has no catalogue: the customer names the amount. Returning an
    // empty list rather than inventing a single "any amount" product keeps
    // "you choose" out of the price field.
    if (this.service === 'airtime') return [];

    const payload = await this.#request(
      'GET',
      `${VTPASS_ENDPOINTS.variations}?serviceID=${encodeURIComponent(query.group ?? '')}`,
    );

    const parsed = variationsResponse.safeParse(payload);
    if (!parsed.success) {
      throw new ProviderContractError(PROVIDER, 'unexpected service-variations shape', parsed.error);
    }

    return parsed.data.content.variations.map((variation) => ({
      code: variation.variation_code,
      name: variation.name,
      // VTpass prices are naira as a decimal STRING ("1500.00"). Parsed to kobo
      // through text, never through a float: 1500.00 * 100 is fine and
      // 0.07 * 100 is 7.000000000000001, and only one of those is obvious.
      priceMinor: nairaToKobo(variation.variation_amount),
      currency: 'NGN' as const,
      metadata: { service_id: query.group ?? '' },
    }));
  }

  async purchase(request: PurchaseRequest): Promise<PurchaseResult> {
    if (request.currency !== 'NGN') {
      throw new ProviderContractError(
        PROVIDER,
        `VTpass settles in NGN; got ${request.currency}`,
      );
    }

    const payload = await this.#request('POST', VTPASS_ENDPOINTS.purchase, {
      // Our reference, so their de-duplication and ours agree on what "the
      // same purchase" means.
      request_id: request.reference,
      serviceID: request.itemCode.split(':')[0],
      variation_code: request.itemCode.split(':')[1],
      billersCode: request.target,
      phone: request.target,
      amount: koboToNaira(request.amountMinor),
    });

    return this.#toResult(payload, request.reference);
  }

  async status(reference: string): Promise<PurchaseResult> {
    const payload = await this.#request('POST', VTPASS_ENDPOINTS.status, {
      request_id: reference,
    });
    return this.#toResult(payload, reference);
  }

  /**
   * Confirms a meter or smartcard number belongs to who the customer thinks.
   *
   * Not on the port: two of the three Phase 6 providers have no such concept,
   * and widening the port to fit one of them would mean two implementations
   * that throw.
   */
  async verifyTarget(itemCode: string, target: string): Promise<VerifiedTarget> {
    const payload = await this.#request('POST', VTPASS_ENDPOINTS.verify, {
      serviceID: itemCode.split(':')[0],
      billersCode: target,
      type: itemCode.split(':')[1],
    });

    const parsed = verifyResponse.safeParse(payload);
    if (!parsed.success) {
      throw new ProviderContractError(PROVIDER, 'unexpected merchant-verify shape', parsed.error);
    }

    const name = parsed.data.content.Customer_Name;
    // VTpass returns `false` rather than an error for an unknown meter. Treated
    // as a rejection, because handing the customer an empty name to confirm is
    // worse than telling them the number is wrong.
    if (typeof name !== 'string' || name.trim() === '') {
      throw new ProviderRejectedError(
        PROVIDER,
        'the provider does not recognise that number',
        parsed.data.code,
      );
    }

    return {
      target,
      name: name.trim(),
      metadata: {
        ...(parsed.data.content.Address === undefined
          ? {}
          : { address: parsed.data.content.Address }),
      },
    };
  }

  #toResult(payload: unknown, reference: string): PurchaseResult {
    const parsed = purchaseResponse.safeParse(payload);
    if (!parsed.success) {
      throw new ProviderContractError(PROVIDER, 'unexpected purchase shape', parsed.error);
    }

    const body = parsed.data;
    const providerReference = body.content?.transactions?.transactionId ?? reference;

    // The token IS the product for a utility purchase. Losing it means the
    // customer paid and has nothing to type into their meter.
    const token = body.purchased_code ?? body.mainToken;
    const delivery: Record<string, string> = token === undefined ? {} : { token };

    if (body.code === CODE_PROCESSING) {
      return { status: 'pending', providerReference, delivery };
    }

    if (body.code !== CODE_SUCCESS) {
      return {
        status: 'failed',
        providerReference,
        delivery,
        failureReason: body.response_description ?? `provider code ${body.code}`,
      };
    }

    // A success code with a transaction still marked pending is pending. The
    // numbers win over the label, as with Bitnob's card funding.
    const transactionStatus = body.content?.transactions?.status?.toLowerCase();
    if (transactionStatus === 'pending' || transactionStatus === 'initiated') {
      return { status: 'pending', providerReference, delivery };
    }

    return { status: 'delivered', providerReference, delivery };
  }

  async #request(method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#options.timeoutMs ?? 20_000);

    let response: Response;
    try {
      response = await this.#fetch(`${this.#options.baseUrl.replace(/\/+$/, '')}${path}`, {
        method,
        signal: controller.signal,
        headers: {
          'api-key': this.#options.apiKey,
          // VTpass uses the secret key for writes and the public key for reads.
          ...(method === 'POST'
            ? { 'secret-key': this.#options.secretKey }
            : { 'public-key': this.#options.publicKey }),
          'content-type': 'application/json',
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (cause) {
      if (cause instanceof Error && cause.name === 'AbortError') {
        throw new ProviderTimeoutError(
          PROVIDER,
          `${method} ${path} timed out; whether it was applied is unknown, so requery ` +
            `rather than resend`,
          cause,
        );
      }
      throw new ProviderUnavailableError(PROVIDER, `${method} ${path} failed`, cause);
    } finally {
      clearTimeout(timeout);
    }

    const text = await response.text();
    if (response.status >= 500) {
      throw new ProviderUnavailableError(PROVIDER, `${method} ${path} returned ${response.status}`, text);
    }

    try {
      return JSON.parse(text);
    } catch (cause) {
      throw new ProviderContractError(
        PROVIDER,
        `${method} ${path} returned ${response.status} with a non-JSON body`,
        cause,
      );
    }
  }
}

/**
 * A naira decimal string to kobo, without passing through a float.
 *
 * VTpass sends "1500.00". `Number("1500.00") * 100` happens to be exact, and
 * `Number("0.07") * 100` is 7.000000000000001 — the difference is invisible
 * until it is a customer's balance.
 */
export function nairaToKobo(value: string | number): bigint {
  const text = typeof value === 'number' ? value.toFixed(2) : value.trim();
  const match = /^(-)?(\d+)(?:\.(\d{1,2}))?$/.exec(text);
  if (match === null) {
    throw new ProviderContractError(PROVIDER, `not a naira amount: '${String(value)}'`);
  }
  const [, sign, whole = '0', fraction = ''] = match;
  const kobo = BigInt(`${whole}${fraction.padEnd(2, '0')}`);
  return sign === '-' ? -kobo : kobo;
}

/** Kobo back to the decimal string VTpass expects. */
export function koboToNaira(minor: bigint): string {
  const negative = minor < 0n;
  const abs = negative ? -minor : minor;
  return `${negative ? '-' : ''}${abs / 100n}.${(abs % 100n).toString().padStart(2, '0')}`;
}
