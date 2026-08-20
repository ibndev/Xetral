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
} from '../ports/fulfilment.js';

const PROVIDER = 'twilio';

/**
 * Twilio — virtual phone numbers, priced in USD.
 *
 * The odd one of the three: a number is not delivered once and finished, it is
 * RENTED. Twilio bills monthly for as long as we hold it, and nothing in this
 * adapter knows that — the recurring charge is a subscription concern for
 * whoever owns billing, and modelling it here would make a purchase port into a
 * billing engine.
 *
 * CONFIRM BEFORE GO-LIVE: the API version segment and the exact resource paths
 * are collected in TWILIO_ENDPOINTS and were not verifiable from this
 * repository.
 */
export const TWILIO_ENDPOINTS = {
  available: (accountSid: string, country: string) =>
    `/2010-04-01/Accounts/${accountSid}/AvailablePhoneNumbers/${country}/Local.json`,
  purchase: (accountSid: string) => `/2010-04-01/Accounts/${accountSid}/IncomingPhoneNumbers.json`,
  owned: (accountSid: string) => `/2010-04-01/Accounts/${accountSid}/IncomingPhoneNumbers.json`,
} as const;

export interface TwilioOptions {
  readonly baseUrl: string;
  readonly accountSid: string;
  readonly authToken: string;
  /** What we charge a customer per number, in cents. Twilio's own price list
   *  varies by country and is not what the customer pays. */
  readonly priceCents: bigint;
  readonly fetch?: (url: string, init: RequestInit) => Promise<Response>;
  readonly timeoutMs?: number;
}

const availableResponse = z.object({
  available_phone_numbers: z.array(
    z.object({
      phone_number: z.string().min(1),
      friendly_name: z.string().optional(),
      locality: z.string().optional(),
      iso_country: z.string().optional(),
    }),
  ),
});

const numberResponse = z.object({
  sid: z.string().min(1),
  phone_number: z.string().min(1),
  status: z.string().optional(),
});

const ownedResponse = z.object({
  incoming_phone_numbers: z.array(numberResponse),
});

export class TwilioAdapter implements FulfilmentPort {
  readonly provider = PROVIDER;
  readonly service: ServiceKind = 'number';

  readonly #options: TwilioOptions;
  readonly #fetch: (url: string, init: RequestInit) => Promise<Response>;

  constructor(options: TwilioOptions) {
    this.#options = options;
    this.#fetch = options.fetch ?? ((url, init) => fetch(url, init));
  }

  async catalogue(query: CatalogueQuery): Promise<readonly CatalogueItem[]> {
    const country = (query.group ?? 'US').toUpperCase();
    const payload = await this.#request(
      'GET',
      TWILIO_ENDPOINTS.available(this.#options.accountSid, country),
    );

    const parsed = availableResponse.safeParse(payload);
    if (!parsed.success) {
      throw new ProviderContractError(PROVIDER, 'unexpected available-numbers shape', parsed.error);
    }

    return parsed.data.available_phone_numbers.map((number) => ({
      // The number itself is the product code: you buy that number, not "a
      // number from this pool".
      code: number.phone_number,
      name: number.friendly_name ?? number.phone_number,
      // OUR price, not Twilio's. What a provider charges us is a cost, and a
      // cost is not a price.
      priceMinor: this.#options.priceCents,
      currency: 'USD' as const,
      metadata: {
        country: number.iso_country ?? country,
        ...(number.locality === undefined ? {} : { locality: number.locality }),
      },
    }));
  }

  async purchase(request: PurchaseRequest): Promise<PurchaseResult> {
    if (request.currency !== 'USD') {
      throw new ProviderContractError(PROVIDER, `Twilio settles in USD; got ${request.currency}`);
    }

    // Twilio takes form encoding, not JSON — the one place this adapter differs
    // from the other two, and precisely the sort of quirk a port should never
    // have to know about.
    const payload = await this.#request(
      'POST',
      TWILIO_ENDPOINTS.purchase(this.#options.accountSid),
      new URLSearchParams({
        PhoneNumber: request.itemCode,
        FriendlyName: `xetral:${request.reference}`,
      }),
    );

    const parsed = numberResponse.safeParse(payload);
    if (!parsed.success) {
      throw new ProviderContractError(PROVIDER, 'unexpected purchase shape', parsed.error);
    }

    return {
      status: 'delivered',
      providerReference: parsed.data.sid,
      delivery: { phone_number: parsed.data.phone_number },
    };
  }

  /**
   * Finds a number by the FriendlyName we set at purchase.
   *
   * Twilio has no concept of our reference, so the friendly name carries it.
   * That is what makes a timeout recoverable: we can ask "did a number with
   * this reference get bought?" instead of buying another one to find out.
   */
  async status(reference: string): Promise<PurchaseResult> {
    const payload = await this.#request(
      'GET',
      `${TWILIO_ENDPOINTS.owned(this.#options.accountSid)}?FriendlyName=${encodeURIComponent(
        `xetral:${reference}`,
      )}`,
    );

    const parsed = ownedResponse.safeParse(payload);
    if (!parsed.success) {
      throw new ProviderContractError(PROVIDER, 'unexpected owned-numbers shape', parsed.error);
    }

    const found = parsed.data.incoming_phone_numbers[0];
    if (found === undefined) {
      // Nothing was bought under this reference. A definite answer, which is
      // what makes it safe to reverse the customer's debit.
      return {
        status: 'failed',
        providerReference: reference,
        delivery: {},
        failureReason: 'no number was purchased for this reference',
      };
    }

    return {
      status: 'delivered',
      providerReference: found.sid,
      delivery: { phone_number: found.phone_number },
    };
  }

  async #request(
    method: 'GET' | 'POST',
    path: string,
    body?: URLSearchParams,
  ): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#options.timeoutMs ?? 20_000);

    const credentials = Buffer.from(
      `${this.#options.accountSid}:${this.#options.authToken}`,
      'utf8',
    ).toString('base64');

    let response: Response;
    try {
      response = await this.#fetch(`${this.#options.baseUrl.replace(/\/+$/, '')}${path}`, {
        method,
        signal: controller.signal,
        headers: {
          authorization: `Basic ${credentials}`,
          accept: 'application/json',
          ...(body === undefined
            ? {}
            : { 'content-type': 'application/x-www-form-urlencoded' }),
        },
        ...(body === undefined ? {} : { body: body.toString() }),
      });
    } catch (cause) {
      if (cause instanceof Error && cause.name === 'AbortError') {
        throw new ProviderTimeoutError(
          PROVIDER,
          `${method} ${path} timed out; look the number up by reference rather than buying again`,
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
      const detail = payload as { message?: unknown; code?: unknown };
      throw new ProviderRejectedError(
        PROVIDER,
        typeof detail.message === 'string' ? detail.message : `${method} ${path} returned ${response.status}`,
        detail.code === undefined ? undefined : String(detail.code),
        text,
      );
    }

    return payload;
  }
}
