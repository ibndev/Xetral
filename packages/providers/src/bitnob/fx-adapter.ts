import { z } from 'zod';
import type { Currency, Money } from '@xetral/shared';
import { ProviderContractError } from '../ports/errors.js';
import type { BitnobClient } from './client.js';
import type { FxExecution, FxPort, FxRate } from '../ports/fx.js';
import { parseMinor } from './crypto-adapter.js';

const PROVIDER = 'bitnob';

/** Bitnob for FX. */
export const BITNOB_FX_ENDPOINTS = {
  /**
   * VERIFIED against `bitnob/stealthdocs` (`docs.json`, `docs/trading/*`).
   *
   * Both paths changed with v2. `/rates` and `/wallets/swap` were the v1
   * surface, and a swap is now a two-step trade: quote, then order. This
   * adapter still calls one endpoint per port method, because `FxPort` models
   * a rate and a conversion and nothing here needs a quote that outlives the
   * request — the ledger's own idempotency key is what makes a retry safe,
   * and a quote id would be a second, weaker copy of that.
   */
  /**
   * A PRICE IS ASKED FOR IN THE BODY, not in the path, and that is a
   * deliberate choice between two documented endpoints.
   *
   * `GET /api/trading/prices/{pair}` exists, and nothing in their docs says
   * how a pair is spelled — `BTCUSDT`, `BTC-USDT`, `BTC_USDT` are all
   * plausible and two of them 404. `POST /api/trading/quotes` takes
   * `base_currency` and `quote_currency` as separate fields, which their own
   * examples show, so there is no separator to get wrong.
   *
   * Guessing the separator is precisely the mistake this whole file is
   * correcting, one layer down: a plausible constant, a test written from the
   * same assumption, and a 404 on the first live call.
   */
  rate: '/api/trading/quotes',
  convert: '/api/trading/orders',
} as const;

/**
 * A rate arrives as a RATIO, not a decimal — requested that way and validated
 * that way. If a provider can only give a decimal, converting it to a ratio is
 * the adapter's job and belongs here, at one boundary, rather than at every
 * call site.
 */
const rateResponse = z.object({
  data: z.object({
    /** Left `unknown` and narrowed by `parseMinor`: a `z.number()` would
     *  accept a value JSON.parse had already rounded, and this one multiplies
     *  every conversion. */
    numerator: z.unknown(),
    denominator: z.unknown(),
    expires_at: z.string().nullish(),
  }),
});

const convertResponse = z.object({
  data: z.object({
    id: z.string().min(1),
    /** What they charged us, in BASE minor units. */
    source_amount: z.unknown(),
    /** What they delivered, in QUOTE minor units. */
    destination_amount: z.unknown(),
  }),
});

export interface BitnobFxOptions {
  readonly client: BitnobClient;
  /** How long a rate is good for when the provider does not say. Deliberately
   *  short: a stale rate either fails on execution or quietly gives the
   *  customer a different number from the one they accepted. */
  readonly rateTtlSeconds?: number;
}

export class BitnobFxAdapter implements FxPort {
  readonly provider = PROVIDER;

  readonly #client: BitnobClient;
  readonly #rateTtlSeconds: number;

  constructor(options: BitnobFxOptions) {
    this.#client = options.client;
    this.#rateTtlSeconds = options.rateTtlSeconds ?? 30;
  }

  async rate(base: Currency, quote: Currency): Promise<FxRate> {
    if (base === quote) {
      throw new ProviderContractError(PROVIDER, `${base} to ${quote} is not a conversion`);
    }

    const payload = await this.#client.request('POST', BITNOB_FX_ENDPOINTS.rate, {
      base_currency: base,
      quote_currency: quote,
    });

    const parsed = rateResponse.safeParse(payload);
    if (!parsed.success) {
      throw new ProviderContractError(
        PROVIDER,
        `rate response does not match the expected shape: ${issues(parsed.error)}`,
        parsed.error,
      );
    }

    const numerator = parseMinor(parsed.data.data.numerator);
    const denominator = parseMinor(parsed.data.data.denominator);
    if (numerator <= 0n || denominator <= 0n) {
      // A zero on either side is not a bad rate, it is a broken one: it would
      // either divide by zero or convert everything to nothing.
      throw new ProviderContractError(
        PROVIDER,
        `rate ${base}/${quote} came back as ${numerator}/${denominator}`,
      );
    }

    const expires = parsed.data.data.expires_at;
    return {
      base,
      quote,
      numerator,
      denominator,
      expiresAt:
        expires === null || expires === undefined
          ? new Date(Date.now() + this.#rateTtlSeconds * 1000)
          : new Date(expires),
    };
  }

  async convert<B extends Currency>(
    base: B,
    quote: Currency,
    amount: Money<B>,
    reference: string,
  ): Promise<FxExecution> {
    if (amount.currency !== base) {
      throw new ProviderContractError(
        PROVIDER,
        `a ${amount.currency} amount cannot be sold as ${base}`,
      );
    }

    const payload = await this.#client.request('POST', BITNOB_FX_ENDPOINTS.convert, {
      // snake_case, with the rest of v2. The old camelCase names are what a
      // v1 body looked like, and a field a server does not recognise is
      // dropped in silence rather than refused.
      base_currency: base,
      quote_currency: quote,
      amount: amount.amount.toString(),
      // Their de-duplication and ours agree on what "the same trade" means.
      reference,
    });

    const parsed = convertResponse.safeParse(payload);
    if (!parsed.success) {
      throw new ProviderContractError(
        PROVIDER,
        `swap response does not match the expected shape: ${issues(parsed.error)}`,
        parsed.error,
      );
    }

    const costMinor = parseMinor(parsed.data.data.source_amount);
    const filledQuoteMinor = parseMinor(parsed.data.data.destination_amount);

    if (costMinor > amount.amount) {
      // They charged more than we offered. Distrusting the number over the
      // label is the same rule the card adapter applies to a "success" whose
      // balance did not move — and here it protects a customer from paying a
      // price they never saw.
      throw new ProviderContractError(
        PROVIDER,
        `swap ${parsed.data.data.id} cost ${costMinor} ${base} against an offer of ${amount.amount}`,
      );
    }
    if (filledQuoteMinor <= 0n) {
      throw new ProviderContractError(
        PROVIDER,
        `swap ${parsed.data.data.id} delivered nothing`,
      );
    }

    return { providerReference: parsed.data.data.id, costMinor, filledQuoteMinor };
  }
}

function issues(error: z.ZodError): string {
  return error.issues.map((i) => i.path.join('.')).join(', ');
}
