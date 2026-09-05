import { Inject, Injectable, Logger } from '@nestjs/common';
import type { OnApplicationShutdown } from '@nestjs/common';
import type { Pool } from 'pg';
import type { Currency } from '@xetral/shared';
import { CURRENCIES } from '@xetral/shared';
import type { ReferenceRatePort } from '@xetral/providers';
import { PublishedRateService } from './published-rate.service.js';
import type { ApiConfig } from '../config.js';
import { API_CONFIG, DATABASE, REFERENCE_RATE_PORT } from '../tokens.js';

/**
 * KEEPING EVERY CORRIDOR PRICED, WITHOUT ANYBODY RETYPING A NUMBER.
 *
 * 053 gave an operator a form to publish a rate into, and that was the whole
 * mechanism. The platform now names eight fiat currencies, so keeping the
 * corridors current is fifty-six numbers to retype — every day, for ever, or
 * customers are quoted a price from whenever somebody last had time. The
 * failure is silent in the worst way: the quote succeeds, at the wrong number.
 *
 * WHAT THIS DOES NOT DO IS DECIDE A PRICE. It publishes what the market says
 * and the SPREAD on top is still an operator's, still per pair, still 053's.
 * And a rate a person published by hand is NEVER overwritten — a deliberate
 * price outranks a market one, which is the whole reason `source` exists.
 *
 * IT ONLY EVER APPENDS. A change is a retirement and a new row, in one
 * transaction, so a trade quoted last month can still be checked against what
 * was live — the rule 007's rate cards, 035's prices and 053 all follow.
 *
 * AND IT IS OFF UNTIL SOMEBODY SETS AN INTERVAL. `FX_RATE_SYNC_INTERVAL_SECONDS`
 * on exactly one instance, the shape every other worker here uses. With no key
 * it does nothing and says so; with no interval it never runs. Both are
 * visible on the prices screen, which reports how old each rate is, because
 * the way this feature fails is that it stops and nothing errors.
 */

/**
 * WHICH CURRENCIES ARE ASKED ABOUT, and why the list is derived rather than
 * written.
 *
 * FIAT ONLY, out of the money registry. A reference feed prices national
 * currencies; USDT and USDC are dollars by construction and Bitcoin is not
 * something to quote from a foreign-exchange endpoint. Deriving it from
 * `CURRENCIES` means a currency added to the registry is priced on the next
 * sync rather than in whichever release somebody remembers this file in —
 * which is the failure 038 records about USDC and the coverage views.
 */
function fiatCurrencies(): readonly Currency[] {
  return (Object.keys(CURRENCIES) as Currency[]).filter(
    (code) => CURRENCIES[code].kind === 'fiat',
  );
}

interface LiveRateRow {
  base_currency: string;
  quote_currency: string;
  quote_per_base: string;
  source: string;
}

export interface RateSyncReport {
  /** Pairs whose price moved, and were republished. */
  readonly published: number;
  /** Pairs the feed agreed with. Nothing was written for these — republishing
   *  an unchanged number would fill an append-only table with noise and make
   *  the history useless for the one thing it is for. */
  readonly unchanged: number;
  /** Pairs a person published. Left exactly as they are. */
  readonly operatorHeld: number;
  /** Bases the feed could not answer for. */
  readonly failed: number;
}

@Injectable()
export class RateFeedService implements OnApplicationShutdown {
  readonly #logger = new Logger(RateFeedService.name);
  #timer: NodeJS.Timeout | undefined;

  constructor(
    @Inject(DATABASE) private readonly pool: Pool,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(REFERENCE_RATE_PORT) private readonly feed: ReferenceRatePort,
  ) {}

  start(): void {
    const everySeconds = this.config.fxRateSyncIntervalSeconds;
    if (everySeconds === undefined) {
      /*
       * Loud, and the same shape as the monitoring sweep's warning, because
       * this failure is silent in the same way: nothing breaks, no request
       * fails, and every corridor quietly quotes whatever was last published
       * by hand. A wrong price that works is worse than a refusal.
       *
       * Not an error and not a refusal to boot: a deployment that publishes
       * its rates by hand is a legitimate deployment, and `published_fx_rates`
       * reports how old each one is either way.
       */
      this.#logger.warn(
        'FX_RATE_SYNC_INTERVAL_SECONDS is not set: RATES ARE NOT BEING ' +
          'REFRESHED. Every corridor quotes whatever was last published by ' +
          'hand, which is not an error anywhere. Set it on exactly one instance.',
      );
      return;
    }

    this.#logger.log(`refreshing reference rates every ${everySeconds}s`);
    this.#timer = setInterval(() => {
      void this.sync().catch((error: unknown) => {
        this.#logger.error(`rate sync failed: ${describe(error)}`);
      });
    }, everySeconds * 1000);
    this.#timer.unref();
  }

  onApplicationShutdown(): void {
    if (this.#timer !== undefined) clearInterval(this.#timer);
  }

  /**
   * One pass over every pair.
   *
   * ONE CALL PER BASE, not one per pair: these feeds meter REQUESTS, and
   * asking fifty-six times for what eight calls answer is how a free-tier
   * quota is exhausted before lunch.
   *
   * A BASE THAT FAILS COSTS ONLY ITS OWN PAIRS. The loop does not abort — an
   * unknown currency, a rate the feed dropped, or a bad afternoon on one
   * request must not leave the other seven corridors on last week's price.
   */
  async sync(): Promise<RateSyncReport> {
    const codes = fiatCurrencies();
    const live = await this.#live();

    let published = 0;
    let unchanged = 0;
    let operatorHeld = 0;
    let failed = 0;

    for (const base of codes) {
      let answered;
      try {
        answered = await this.feed.latest(base);
      } catch (error: unknown) {
        failed += 1;
        // Named, and not thrown. A feed outage must not stop the sweep: the
        // cost of one base going unpriced is an old rate on those corridors,
        // and the cost of aborting is an old rate on all of them.
        this.#logger.warn(`no reference rates for ${base}: ${describe(error)}`);
        continue;
      }

      for (const quote of codes) {
        if (quote === base) continue;

        const current = live.get(`${base}/${quote}`);
        if (current !== undefined && current.source !== 'reference_feed') {
          // A PERSON CHOSE THIS PRICE. The feed does not argue with it.
          operatorHeld += 1;
          continue;
        }

        const quoted = answered.rates.get(quote);
        if (quoted === undefined) continue;

        // COMPARED AS TEXT, which is what the adapter's fixed six decimal
        // places are for. Comparing as numbers would reintroduce a float on
        // the one decision that writes a price.
        if (current !== undefined && current.quote_per_base === quoted) {
          unchanged += 1;
          continue;
        }

        try {
          await this.#republish(base, quote, quoted);
          published += 1;
        } catch (error: unknown) {
          failed += 1;
          this.#logger.warn(`could not publish ${base}/${quote}: ${describe(error)}`);
        }
      }
    }

    this.#logger.log(
      `rate sync: ${published} published, ${unchanged} unchanged, ` +
        `${operatorHeld} held by an operator, ${failed} failed`,
    );
    return { published, unchanged, operatorHeld, failed };
  }

  /** Every live rate, keyed by direction, so the sweep reads the table once
   *  rather than fifty-six times. */
  async #live(): Promise<ReadonlyMap<string, LiveRateRow>> {
    const rows = await this.pool.query<LiveRateRow>(
      `SELECT base_currency, quote_currency, quote_per_base, source
         FROM fx_published_rates WHERE retired_at IS NULL`,
    );
    return new Map(rows.rows.map((r) => [`${r.base_currency}/${r.quote_currency}`, r]));
  }

  /**
   * Retire what is live and publish the new one, IN ONE TRANSACTION.
   *
   * Apart, a process dying in the gap leaves a direction with NO live rate —
   * and an unpublished pair is refused rather than quoted from a default,
   * which Phase 10 chose deliberately. So the failure of a price sync would be
   * a corridor that stops serving customers entirely, which is far worse than
   * the stale price it was trying to fix.
   */
  async #republish(base: string, quote: string, quotePerBase: string): Promise<void> {
    const { numerator, denominator } = PublishedRateService.ratioFor(
      quotePerBase,
      base as Currency,
      quote as Currency,
    );

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE fx_published_rates SET retired_at = now()
          WHERE base_currency = $1 AND quote_currency = $2 AND retired_at IS NULL`,
        [base, quote],
      );
      await client.query(
        `INSERT INTO fx_published_rates
           (base_currency, quote_currency, numerator, denominator, quote_per_base, source)
         VALUES ($1, $2, $3::bigint, $4::bigint, $5, 'reference_feed')`,
        [base, quote, numerator.toString(), denominator.toString(), quotePerBase],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
