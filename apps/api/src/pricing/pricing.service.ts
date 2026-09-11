import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { Pool } from 'pg';
import type { Currency } from '@xetral/shared';
import { DATABASE } from '../tokens.js';
import { PublishedRateService } from '../fx/published-rate.service.js';

/**
 * Publishing a price.
 *
 * TWO TABLES THE APPLICATION HAS NEVER WRITTEN. `fx_spread_policies` and
 * `giftcard_rate_cards` are read on every quote and were only ever populated
 * by hand — so a fresh deployment refuses every FX pair, and gift cards can
 * be switched on and then 404 the first customer who asks for a quote.
 *
 * BOTH ARE APPEND-ONLY, so there is deliberately no `update`. Changing a price
 * is retiring one row and publishing another, which keeps every past quote
 * reproducible — the rule 005 and 008 already enforce by trigger and the
 * reason a rate card carries the id it was quoted against.
 *
 * A PRICE PUBLISHED HERE ALWAYS HAS AN AUTHOR. The column is nullable because
 * rows already exist, but nothing on this path leaves it empty, and
 * `prices_without_an_author` is what finds the ones that did.
 */
@Injectable()
export class PricingService {
  readonly #logger = new Logger(PricingService.name);

  constructor(@Inject(DATABASE) private readonly pool: Pool) {}

  /** What a customer will be quoted today, both kinds in one list. An
   *  operator checking whether a deployment can take traffic should not have
   *  to know there are two tables. */
  async published(): Promise<{
    readonly prices: readonly Record<string, unknown>[];
    readonly unattributed: readonly Record<string, unknown>[];
  }> {
    const [prices, unattributed] = await Promise.all([
      this.pool.query(
        `SELECT kind, uuid, subject, price, terms, effective_from FROM published_prices`,
      ),
      this.pool.query(`SELECT kind, uuid, subject, effective_from FROM prices_without_an_author`),
    ]);
    return {
      prices: prices.rows as Record<string, unknown>[],
      unattributed: unattributed.rows as Record<string, unknown>[],
    };
  }

  /** Every FX policy including retired ones, newest first. The retired rows
   *  are the point: they are what explains a quote somebody was given last
   *  month. */
  /**
   * The spreads, and — for a live one — what it is ACTUALLY being quoted at.
   *
   * WHY THE EFFECTIVE FIGURE IS ON THIS LIST. 062 widens a spread when the
   * payout currency has strengthened since that pair's rate was last
   * published. That changes what a customer is charged, so a screen showing
   * only the published number would be showing a price nobody is being
   * quoted — the exact shape of failure this codebase keeps recording, a
   * control or a figure that nothing reads.
   *
   * The join is LEFT and the whole thing is guarded: a deployment behind 062
   * has no such view, and the spreads must still list.
   */
  async fxPolicies(): Promise<readonly Record<string, unknown>[]> {
    const withPressure = `
      SELECT p.uuid, p.base_currency, p.quote_currency,
             p.spread_basis_points, p.min_base_minor::text AS min_base_minor,
             p.effective_from, p.retired_at, u.email AS published_by,
             pr.effective_basis_points, pr.adverse_basis_points,
             pr.observed_rate, pr.published_rate
        FROM fx_spread_policies p
        LEFT JOIN users u ON u.id = p.created_by
        LEFT JOIN fx_spread_pressure pr
          ON p.retired_at IS NULL
         AND pr.base_currency = p.base_currency
         AND pr.quote_currency = p.quote_currency
       ORDER BY p.retired_at IS NOT NULL, p.effective_from DESC
       LIMIT 200`;

    try {
      const rows = await this.pool.query(withPressure);
      return rows.rows as Record<string, unknown>[];
    } catch {
      const rows = await this.pool.query(
        `SELECT p.uuid, p.base_currency, p.quote_currency,
                p.spread_basis_points, p.min_base_minor::text AS min_base_minor,
                p.effective_from, p.retired_at, u.email AS published_by
           FROM fx_spread_policies p
           LEFT JOIN users u ON u.id = p.created_by
          ORDER BY p.retired_at IS NOT NULL, p.effective_from DESC
          LIMIT 200`,
      );
      return rows.rows as Record<string, unknown>[];
    }
  }

  async rateCards(): Promise<readonly Record<string, unknown>[]> {
    const rows = await this.pool.query(
      `SELECT r.uuid, r.brand, r.country, r.card_type, r.face_currency, r.payout_currency,
              r.payout_rate_minor::text AS payout_rate_minor,
              r.min_face_minor::text AS min_face_minor,
              r.max_face_minor::text AS max_face_minor,
              r.effective_from, r.retired_at, u.email AS published_by
         FROM giftcard_rate_cards r
         LEFT JOIN users u ON u.id = r.created_by
        ORDER BY r.retired_at IS NOT NULL, r.brand, r.min_face_minor
        LIMIT 500`,
    );
    return rows.rows as Record<string, unknown>[];
  }

  /**
   * Publishes an FX spread for one pair and one direction.
   *
   * ONE DIRECTION, and that is not an oversight to fix later: a rate is a
   * ratio, and NGN→USD and USD→NGN are priced separately because "minor units
   * per major unit" collapses in one of the two directions. Publishing one
   * does not publish the other, and an operator who forgets the reverse finds
   * out from `published_prices` rather than from a customer.
   */
  /**
   * THE RATE ITSELF, which nothing could set before.
   *
   * `publishFxSpread` publishes a MARGIN; this publishes what a cedi is
   * worth. See 053's header for why the two are separate and what publishing
   * a rate commits us to — where one exists, Xetral is the counterparty and
   * settles the swap out of its own float rather than asking a provider.
   *
   * The operator types a DECIMAL STRING — "1650.00", how a person says a rate
   * and the only form they can check — and `ratioFor` turns it into the ratio
   * of integers the ledger uses, scaled by each currency's own exponent. That
   * conversion lives in ONE place for the reason `bitnob/amounts.ts` does: a
   * second copy inline is how a rate ends up wrong by a power of ten in the
   * one pair nobody tests.
   */
  async publishFxRate(
    reviewerUuid: string,
    input: {
      readonly base_currency: string;
      readonly quote_currency: string;
      readonly quote_per_base: string;
    },
  ): Promise<Record<string, unknown>> {
    const { numerator, denominator } = PublishedRateService.ratioFor(
      input.quote_per_base,
      input.base_currency as Currency,
      input.quote_currency as Currency,
    );

    try {
      const inserted = await this.pool.query(
        `INSERT INTO fx_published_rates
           (base_currency, quote_currency, numerator, denominator, quote_per_base, created_by)
         VALUES ($1, $2, $3::bigint, $4::bigint, $5, (SELECT id FROM users WHERE uuid = $6))
         RETURNING uuid, base_currency, quote_currency, numerator::text AS numerator,
                   denominator::text AS denominator, quote_per_base, effective_from`,
        [
          input.base_currency,
          input.quote_currency,
          numerator.toString(),
          denominator.toString(),
          input.quote_per_base,
          reviewerUuid,
        ],
      );
      this.#logger.log(
        `fx rate published: 1 ${input.base_currency} = ${input.quote_per_base} ` +
          `${input.quote_currency}`,
      );
      return inserted.rows[0] as Record<string, unknown>;
    } catch (error) {
      if (isUniqueViolation(error)) {
        // ONE LIVE RATE PER DIRECTION. Retire the current one first — a rate
        // is append-only so every past quote stays checkable, which is the
        // rule gift card rate cards already follow.
        throw new ConflictException({ error: 'price_already_published' });
      }
      throw error;
    }
  }

  /**
   * WHAT THIS PAIR OR CARD WAS PRICED AT BEFORE, so an audit entry can say
   * old → new rather than just new.
   *
   * WHY THE MOST RECENTLY RETIRED ROW rather than a live one. Every publish
   * path here REFUSES while a live price exists — changing a price is retiring
   * one and publishing another, which is what keeps every past quote
   * reproducible. So at the moment of a publish there is by construction no
   * live predecessor, and the value being replaced is the newest retired row.
   *
   * NULL IS A REAL ANSWER and means this is the first price for that subject.
   * Reading it as anything else would put a fabricated "from" in an
   * append-only table.
   *
   * THREE READERS RATHER THAN ONE GENERIC ONE, written out. A helper that took
   * a table name and a set of key columns would be a query whose behaviour
   * changes with its arguments, over the tables that decide what customers are
   * charged — the argument `erase_customer_personal_data()` makes about naming
   * the rows it touches.
   *
   * Each is allowed to fail: an audit detail must never be what stops a price
   * being published.
   */
  async previousFxSpread(
    base: string,
    quote: string,
  ): Promise<Record<string, unknown> | null> {
    try {
      const found = await this.pool.query(
        `SELECT spread_basis_points, min_base_minor::text AS min_base_minor,
                effective_from, retired_at
           FROM fx_spread_policies
          WHERE base_currency = $1 AND quote_currency = $2 AND retired_at IS NOT NULL
          ORDER BY retired_at DESC, id DESC
          LIMIT 1`,
        [base, quote],
      );
      return (found.rows[0] as Record<string, unknown> | undefined) ?? null;
    } catch {
      return null;
    }
  }

  async previousFxRate(base: string, quote: string): Promise<Record<string, unknown> | null> {
    try {
      const found = await this.pool.query(
        `SELECT quote_per_base, source, effective_from, retired_at
           FROM fx_published_rates
          WHERE base_currency = $1 AND quote_currency = $2 AND retired_at IS NOT NULL
          ORDER BY retired_at DESC, id DESC
          LIMIT 1`,
        [base, quote],
      );
      return (found.rows[0] as Record<string, unknown> | undefined) ?? null;
    } catch {
      return null;
    }
  }

  async previousRateCard(input: {
    readonly brand: string;
    readonly country: string;
    readonly card_type: string;
  }): Promise<Record<string, unknown> | null> {
    try {
      const found = await this.pool.query(
        `SELECT payout_rate_minor::text AS payout_rate_minor,
                min_face_minor::text AS min_face_minor,
                max_face_minor::text AS max_face_minor,
                effective_from, retired_at
           FROM giftcard_rate_cards
          WHERE brand = $1 AND country = $2 AND card_type = $3 AND retired_at IS NOT NULL
          ORDER BY retired_at DESC, id DESC
          LIMIT 1`,
        [input.brand, input.country, input.card_type],
      );
      return (found.rows[0] as Record<string, unknown> | undefined) ?? null;
    } catch {
      return null;
    }
  }

  /** Every live rate, with the spread that goes with it. */
  async fxRates(): Promise<readonly Record<string, unknown>[]> {
    try {
      const rows = await this.pool.query(`SELECT * FROM published_fx_rates`);
      return rows.rows as Record<string, unknown>[];
    } catch {
      // A deployment that has not applied 053. The screen renders empty and
      // its own prose says what to do, rather than the whole prices page
      // failing over a table one panel needs.
      return [];
    }
  }

  async publishFxSpread(
    reviewerUuid: string,
    input: {
      readonly base_currency: string;
      readonly quote_currency: string;
      readonly spread_basis_points: number;
      readonly min_base_minor: string;
    },
  ): Promise<Record<string, unknown>> {
    try {
      const inserted = await this.pool.query(
        `INSERT INTO fx_spread_policies
           (base_currency, quote_currency, spread_basis_points, min_base_minor, created_by)
         VALUES ($1, $2, $3, $4::bigint, (SELECT id FROM users WHERE uuid = $5))
         RETURNING uuid, base_currency, quote_currency, spread_basis_points,
                   min_base_minor::text AS min_base_minor, effective_from`,
        [
          input.base_currency,
          input.quote_currency,
          input.spread_basis_points,
          input.min_base_minor,
          reviewerUuid,
        ],
      );
      this.#logger.log(
        `fx spread published: ${input.base_currency}/${input.quote_currency} ` +
          `at ${String(input.spread_basis_points)}bp`,
      );
      return inserted.rows[0] as Record<string, unknown>;
    } catch (error) {
      if (isUniqueViolation(error)) {
        // A live policy already exists for this pair. Retire it first — which
        // is a separate, visible act rather than something this call does on
        // the operator's behalf, because it changes what every customer is
        // quoted.
        throw new ConflictException({ error: 'price_already_published' });
      }
      if (isCheckViolation(error)) {
        throw new UnprocessableEntityException({ error: 'invalid_price' });
      }
      throw error;
    }
  }

  /**
   * Publishes a gift card rate for one brand, country, type and band.
   *
   * A COLLISION IS REFUSED RATHER THAN RESOLVED. `#liveRate` picks the newest
   * of whatever matches, so two overlapping live bands would silently reprice
   * the overlap — 035's EXCLUDE constraint is what turns that into an error,
   * and this is where a person meets it.
   */
  async publishRateCard(
    reviewerUuid: string,
    input: {
      readonly brand: string;
      readonly country: string;
      readonly card_type: 'ecode' | 'physical';
      readonly face_currency: string;
      readonly payout_currency: string;
      readonly payout_rate_minor: string;
      readonly min_face_minor: string;
      readonly max_face_minor: string;
    },
  ): Promise<Record<string, unknown>> {
    try {
      const inserted = await this.pool.query(
        `INSERT INTO giftcard_rate_cards
           (brand, country, card_type, face_currency, payout_currency,
            payout_rate_minor, min_face_minor, max_face_minor, created_by)
         VALUES ($1, $2, $3, $4, $5, $6::bigint, $7::bigint, $8::bigint,
                 (SELECT id FROM users WHERE uuid = $9))
         RETURNING uuid, brand, country, card_type, face_currency, payout_currency,
                   payout_rate_minor::text AS payout_rate_minor,
                   min_face_minor::text AS min_face_minor,
                   max_face_minor::text AS max_face_minor, effective_from`,
        [
          input.brand,
          input.country,
          input.card_type,
          input.face_currency,
          input.payout_currency,
          input.payout_rate_minor,
          input.min_face_minor,
          input.max_face_minor,
          reviewerUuid,
        ],
      );
      this.#logger.log(`rate card published: ${input.brand} ${input.country} ${input.card_type}`);
      return inserted.rows[0] as Record<string, unknown>;
    } catch (error) {
      if (isExclusionViolation(error)) {
        // Overlaps a live band. Named separately from a duplicate because the
        // fix is different: retire the band it overlaps, or narrow this one.
        throw new ConflictException({ error: 'price_band_overlaps' });
      }
      if (isCheckViolation(error)) {
        throw new UnprocessableEntityException({ error: 'invalid_price' });
      }
      throw error;
    }
  }

  /**
   * Retires a published price.
   *
   * DOES NOT DELETE IT. The row stays and stops being live, which is what
   * keeps a quote given last month explicable. Retiring is final — 005 and 008
   * both refuse to un-retire — because bringing one back would make the
   * history say a price was in force during a period when it was not.
   */
  /**
   * DELETING A RETIRED RATE, which only an `admin` may do.
   *
   * A prices screen accumulates every mistyped rate for ever: publish 16500
   * where you meant 1650, retire it in the next second, and then look at it
   * for the life of the deployment. 064 permits the delete and the DATABASE
   * is what refuses a live one — deleting that unprices the corridor, and an
   * unpublished pair is refused rather than quoted, so the next customer is
   * told it cannot be converted with nothing on screen saying a row went
   * missing.
   *
   * WHAT IS LOST IS AN OFFER NOBODY TOOK. `fx_trades` carries its own
   * `applied_numerator`/`applied_denominator`, so a trade is self-describing
   * about the price it was struck at and nothing references a rate row by key.
   * That is the whole reason this can be permitted at all; if a trade read its
   * price back through this table it could not be.
   *
   * The refusal is relayed from the trigger rather than pre-checked here. A
   * check around the delete is a second, weaker copy of the rule plus a race,
   * which is the argument the ledger makes about never pre-checking a balance.
   */
  async deleteRate(uuid: string): Promise<{ uuid: string }> {
    const removed = await this.pool.query<{ uuid: string }>(
      `DELETE FROM fx_published_rates WHERE uuid = $1 RETURNING uuid`,
      [uuid],
    ).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : '';
      if (message.includes('LIVE published rate cannot be deleted')) {
        throw new UnprocessableEntityException({ error: 'price_is_live' });
      }
      throw error;
    });

    const row = removed.rows[0];
    // One answer for "no such rate" and "already gone", the same reasoning
    // `retire` records: the next step is identical and the list says which.
    if (row === undefined) throw new NotFoundException({ error: 'price_not_found' });

    this.#logger.log(`published rate deleted: ${uuid}`);
    return row;
  }

  /**
   * Removes a RETIRED spread policy.
   *
   * THE TABLE AN OPERATOR ACTUALLY RETIRES ROWS IN. 064 gave this to published
   * RATES, which mostly retire themselves because the reference feed
   * republishes them; a SPREAD is the row with a Retire button on it and the
   * one that accumulates every mistyped margin.
   *
   * TWO REFUSALS, AND THEY MEAN DIFFERENT THINGS.
   *
   * A LIVE policy is refused by 066's trigger: deleting one silently unprices
   * the corridor, because 008 refuses an unpublished pair rather than quoting
   * from a default.
   *
   * A policy that PRICED A TRADE is refused by the FOREIGN KEY, and that one
   * is permanent — it is part of that trade's record. Unlike a published rate,
   * which nothing references by key, a trade names the policy it was priced
   * under. The key is left to do the refusing rather than re-checked here: a
   * count before the constraint is a second, weaker copy of the rule plus a
   * race.
   */
  async deletePolicy(uuid: string): Promise<{ uuid: string }> {
    const removed = await this.pool
      .query<{ uuid: string }>(
        `DELETE FROM fx_spread_policies WHERE uuid = $1 RETURNING uuid`,
        [uuid],
      )
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : '';
        if (message.includes('LIVE spread policy cannot be deleted')) {
          throw new UnprocessableEntityException({ error: 'price_is_live' });
        }
        // The key's own refusal, turned into words an operator can act on —
        // and the action is "leave it", which is why it says so rather than
        // inviting a retry.
        if (message.includes('fx_trades_spread_policy_id_fkey')) {
          throw new UnprocessableEntityException({ error: 'price_in_use' });
        }
        throw error;
      });

    const row = removed.rows[0];
    if (row === undefined) throw new NotFoundException({ error: 'price_not_found' });

    this.#logger.log(`spread policy deleted: ${uuid}`);
    return row;
  }

  async retire(
    table: 'fx' | 'giftcard',
    uuid: string,
  ): Promise<Record<string, unknown>> {
    /*
     * TWO WRITTEN-OUT STATEMENTS, not one with the table interpolated. The
     * union is closed and either literal would be safe, and that is exactly
     * the reasoning that makes the next one — where the value comes from
     * somewhere less obvious — look safe too. The rule this codebase applies
     * to `apply_retention()` and `erase_customer_personal_data()` is that a
     * statement naming a table is a statement somebody can read; it costs two
     * lines here.
     */
    const updated =
      table === 'fx'
        ? await this.pool.query(
            `UPDATE fx_spread_policies SET retired_at = now()
              WHERE uuid = $1 AND retired_at IS NULL
              RETURNING uuid, retired_at`,
            [uuid],
          )
        : await this.pool.query(
            `UPDATE giftcard_rate_cards SET retired_at = now()
              WHERE uuid = $1 AND retired_at IS NULL
              RETURNING uuid, retired_at`,
            [uuid],
          );
    const row = updated.rows[0];
    if (row === undefined) {
      // Either it does not exist or it is already retired. One answer for
      // both: an operator who cannot find a price has the same next step
      // either way, and the list shows which it was.
      throw new NotFoundException({ error: 'price_not_found' });
    }
    this.#logger.log(`price retired: ${table} ${uuid}`);
    return row as Record<string, unknown>;
  }
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505';
}

function isExclusionViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23P01';
}

function isCheckViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23514';
}
