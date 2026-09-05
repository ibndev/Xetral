import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';
import type { Currency } from '@xetral/shared';
import { exponentOf } from '@xetral/shared';
import type { FxRate } from '@xetral/providers';
import { DATABASE } from '../tokens.js';

/**
 * A RATE WE SET OURSELVES, and what publishing one means.
 *
 * `fx_spread_policies` publishes a MARGIN. The RATE has always come from
 * `FxPort.rate()` — from Bitnob — so an operator could say "take 1.5% on
 * NGN→GHS" and had no way at all to say what a cedi is worth. For NGN→USD
 * that is right: there is a market, a provider quotes it, and a number we
 * typed would drift from the one the swap executes at. FOR NGN→GHS THERE IS
 * NO SUCH PROVIDER, so the pair could be given a spread, look published, and
 * refuse every customer — which is the state the corridor this platform was
 * built for is in.
 *
 * SO A PUBLISHED RATE MAKES US THE COUNTERPARTY. Where one exists, Xetral is
 * quoting its own price and settling out of its own float in both currencies:
 * there is nobody to ask for a rate and nobody to execute against. Where one
 * does not, nothing changes and the provider is asked exactly as before.
 *
 * The cost of being the counterparty is worth stating: our `provider_float`
 * in the quote currency falls with every conversion, and it is
 * overdraft-EXEMPT, so over-selling a currency shows as a negative float
 * rather than as a refusal. That is a real position and a visible one —
 * `admin_liability` reports it per currency — but it is a position somebody
 * has to watch, which a provider-quoted pair never asked of anyone.
 */
export interface PublishedRateRow {
  readonly base_currency: string;
  readonly quote_currency: string;
  readonly numerator: string;
  readonly denominator: string;
  readonly quote_per_base: string;
}

@Injectable()
export class PublishedRateService {
  constructor(@Inject(DATABASE) private readonly pool: Pool) {}

  /**
   * The live rate for this direction, or undefined.
   *
   * READ PER QUOTE, never cached. The reason to change a rate is almost
   * always that the market moved, and a quote that keeps its old value for
   * thirty seconds is a price we are honouring after deciding not to — the
   * same argument 029 makes for reading a KYC tier on every check.
   *
   * Swallows a missing table so a deployment that has not applied 053 falls
   * back to the provider rather than refusing every conversion: the failure
   * mode of a missing migration should be the old behaviour, not none.
   */
  async rateFor(base: Currency, quote: Currency): Promise<FxRate | undefined> {
    let row: PublishedRateRow | undefined;
    try {
      const rows = await this.pool.query<PublishedRateRow>(
        `SELECT base_currency, quote_currency,
                numerator::text AS numerator, denominator::text AS denominator,
                quote_per_base
           FROM fx_published_rates
          WHERE base_currency = $1 AND quote_currency = $2 AND retired_at IS NULL`,
        [base, quote],
      );
      row = rows.rows[0];
    } catch {
      return undefined;
    }
    if (row === undefined) return undefined;

    return {
      base,
      quote,
      numerator: BigInt(row.numerator),
      denominator: BigInt(row.denominator),
      /*
       * A RATE WE SET DOES NOT EXPIRE, and the far-future date says so rather
       * than pretending otherwise.
       *
       * `expiresAt` exists because a provider's quote is a promise with a
       * clock on it — accept it late and the swap fails or silently fills at
       * a different number. Ours is a price we are choosing to honour until
       * we retire it, so there is no moment at which it becomes stale
       * underneath a customer. Answering `now()` would make every quote look
       * expired on arrival; answering a short window would invent a deadline
       * nothing enforces.
       */
      expiresAt: new Date('2099-12-31T00:00:00.000Z'),
    };
  }

  /**
   * Turns what an operator typed into the ratio the ledger uses.
   *
   * `quotePerBase` is MAJOR units of the quote currency for one MAJOR unit of
   * the base — "1650.00", which is how a person says a rate and the only form
   * they can check. A STRING, for the reason `fromMajor()` takes one: by the
   * time a decimal is a JS number the precision is already gone.
   *
   *     quoteMinor = baseMinor * numerator / denominator
   *
   * so, for `quotePerBase = N / 10^d`:
   *
   *     numerator   = N * 10^exponent(quote)
   *     denominator = 10^d * 10^exponent(base)
   *
   * Both sides are scaled by the currencies' own exponents rather than by a
   * hardcoded two — JPY is 0, USDT is 6, and a rate built on an assumed 2
   * would be wrong by a power of ten in exactly the pairs nobody tests.
   */
  static ratioFor(
    quotePerBase: string,
    base: Currency,
    quote: Currency,
  ): { numerator: bigint; denominator: bigint } {
    const match = /^([0-9]+)(?:\.([0-9]+))?$/.exec(quotePerBase.trim());
    if (match === null) throw new RangeError(`not a rate: ${quotePerBase}`);

    const whole = match[1] ?? '0';
    const fraction = match[2] ?? '';
    // Digits joined rather than multiplied: "1650" + "00" is 165000 exactly,
    // where 1650 * 10^2 through a number is fine until the day it is not.
    const scaled = BigInt(`${whole}${fraction}`);
    if (scaled <= 0n) throw new RangeError('a rate must be positive');

    const numerator = scaled * 10n ** BigInt(exponentOf(quote));
    const denominator = 10n ** BigInt(fraction.length) * 10n ** BigInt(exponentOf(base));
    return { numerator, denominator };
  }
}
