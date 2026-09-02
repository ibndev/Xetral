import { BadRequestException, ConflictException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { CURRENCIES } from '@xetral/shared';
import { DATABASE } from '../tokens.js';

/**
 * WHERE XETRAL OPERATES, as data.
 *
 * The country is a row an operator edits; the CURRENCY it names is not, and
 * cannot be — `Currency` in @xetral/shared is a compile-time union, which is
 * what makes `add(ngn(100), usd(100))` fail to compile. A currency invented
 * from this form would have no exponent, so every amount in it would be wrong
 * by a power of ten, and no ceiling and nothing watching it.
 *
 * So `supportedCurrencies()` below is what the admin form offers, read from
 * the money registry rather than typed. An operator cannot reach a currency
 * the code does not know, and the database refuses to ENABLE a country whose
 * currency has no ceiling at every tier and no monitoring threshold.
 */
export interface Country {
  readonly code: string;
  readonly name: string;
  readonly dial_code: string;
  readonly currency: string;
  readonly enabled: boolean;
}

@Injectable()
export class CountriesService {
  readonly #logger = new Logger(CountriesService.name);

  constructor(@Inject(DATABASE) private readonly pool: Pool) {}

  /**
   * What a signup form may offer. ENABLED ONLY, and the reason is not
   * cosmetic: a closed country is one nobody has decided to serve, and an
   * account opened there would be a customer in a place with no payout rail.
   */
  async open(): Promise<readonly Country[]> {
    const result = await this.pool.query<Country>(
      `SELECT code, name, dial_code, currency, enabled
         FROM countries WHERE enabled ORDER BY name`,
    );
    return result.rows;
  }

  /** Every row, for the operations screen. */
  async all(): Promise<readonly Country[]> {
    const result = await this.pool.query<Country>(
      `SELECT code, name, dial_code, currency, enabled
         FROM countries ORDER BY enabled DESC, name`,
    );
    return result.rows;
  }

  /**
   * The currencies a country may name, from the MONEY REGISTRY.
   *
   * Fiat only. A country whose default currency is Bitcoin is not a country
   * this system understands — the home screen would lead with a balance that
   * is not what anybody there is paid in — and offering crypto in this picker
   * would make that a one-click mistake.
   */
  supportedCurrencies(): readonly { code: string; name: string }[] {
    return Object.entries(CURRENCIES)
      .filter(([, meta]) => meta.kind === 'fiat')
      .map(([code, meta]) => ({ code, name: meta.name }));
  }

  /** Resolve a country a customer claims, refusing one that is not open. */
  async requireOpen(code: string, client?: PoolClient): Promise<Country> {
    const runner = client ?? this.pool;
    const result = await runner.query<Country>(
      `SELECT code, name, dial_code, currency, enabled
         FROM countries WHERE code = $1`,
      [code],
    );
    const row = result.rows[0];
    // The SAME answer for "no such country" and "we are not open there". A
    // signup form that distinguished them would publish the roadmap.
    if (row === undefined || !row.enabled) {
      throw new BadRequestException({ error: 'country_not_supported' });
    }
    return row;
  }

  async add(input: {
    code: string;
    name: string;
    dialCode: string;
    currency: string;
    actorId: string;
  }): Promise<Country> {
    // Checked here as well as by the database, so an operator gets the list of
    // what IS supported rather than a constraint violation.
    if (!this.supportedCurrencies().some((c) => c.code === input.currency)) {
      throw new BadRequestException({
        error: 'currency_not_supported',
        detail:
          `${input.currency} is not in the money registry. Adding it means a ` +
          `code change — it needs an exponent, or every amount in it is wrong ` +
          `by a power of ten.`,
      });
    }

    try {
      const created = await this.pool.query<Country>(
        `INSERT INTO countries (code, name, dial_code, currency, enabled, created_by)
         VALUES ($1, $2, $3, $4, FALSE, $5::bigint)
         RETURNING code, name, dial_code, currency, enabled`,
        [input.code, input.name, input.dialCode, input.currency, input.actorId],
      );
      const row = created.rows[0];
      if (row === undefined) throw new Error('country insert returned no row');
      return row;
    } catch (error: unknown) {
      if (isUniqueViolation(error)) throw new ConflictException({ error: 'country_exists' });
      throw error;
    }
  }

  /**
   * Open or close a country.
   *
   * The database decides whether opening is allowed — `countries_enable_needs_
   * coverage` refuses a currency with no ceiling at every tier or nothing
   * monitoring it. The message it raises names which is missing, and it is
   * relayed rather than replaced: "add kyc_tier_limits rows for GHS" is the
   * whole of what an operator needs, and a generic refusal would send them to
   * read this file.
   */
  async setEnabled(code: string, enabled: boolean): Promise<Country> {
    try {
      const updated = await this.pool.query<Country>(
        `UPDATE countries SET enabled = $2 WHERE code = $1
         RETURNING code, name, dial_code, currency, enabled`,
        [code, enabled],
      );
      const row = updated.rows[0];
      if (row === undefined) throw new NotFoundException({ error: 'country_not_found' });
      return row;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : '';
      if (message.includes('cannot be enabled')) {
        this.#logger.warn(`refused to open ${code}: ${message}`);
        throw new BadRequestException({ error: 'country_not_covered', detail: message });
      }
      throw error;
    }
  }
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error &&
    (error as { code?: string }).code === '23505';
}
