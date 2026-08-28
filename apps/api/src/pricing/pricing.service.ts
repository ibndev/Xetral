import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { Pool } from 'pg';
import { DATABASE } from '../tokens.js';

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
  async fxPolicies(): Promise<readonly Record<string, unknown>[]> {
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
