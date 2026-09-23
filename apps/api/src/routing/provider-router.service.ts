import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Pool } from 'pg';
import { DATABASE } from '../tokens.js';

/**
 * What a route can be about.
 *
 * `collect` is a checkout — money a payer pushes through a hosted page.
 * `payout` is money leaving. `account` is WHO OPENS A DEDICATED ACCOUNT
 * NUMBER, and it is its own operation because it is its own decision: moving
 * naira account numbers to Flutterwave must not also move every naira payment
 * link, which is what re-pointing `collect` would do. Where no `account` row
 * exists the `collect` route answers, which is how every account was opened
 * before 076.
 */
export type RoutedOperation = 'collect' | 'payout' | 'account';

export const ROUTED_OPERATIONS: readonly RoutedOperation[] = ['account', 'collect', 'payout'];

interface Cached {
  readonly provider: string | undefined;
  readonly at: number;
}

/**
 * WHICH PROVIDER SERVES WHICH CURRENCY.
 *
 * WHY THIS EXISTS AT ALL. `funding_provider` and `payout_provider` are one
 * name each — they can say "Paystack" or "Bitnob" and cannot say "Paystack
 * for naira and somebody else for cedis", which is the only sentence that
 * describes a platform operating in three countries. A Paystack account
 * registered in Nigeria settles in naira: asked for cedis it either refuses
 * or accepts and converts at a rate nobody chose, and the customer's screen
 * said "Payments are unavailable right now" with nothing anywhere able to say
 * which of those two had happened.
 *
 * IT NAMES WHO, NEVER WHETHER. The four kill switches in 009 decide whether a
 * flow runs at all, and they stay separate on purpose: an operator turning
 * something off in an incident must not have to know which rail it was on,
 * and a router that could also disable would be a second, quieter switch
 * nobody thinks to check.
 *
 * READ PER CALL, WITH FIVE SECONDS OF CACHE — the interval
 * `ProviderCredentialService` uses and for the same reason. The moment you
 * want to move a corridor is the moment that rail is having a bad afternoon,
 * and a rail that keeps serving for another half minute after an operator
 * moved it has not been moved.
 *
 * AN UNROUTED CURRENCY IS REFUSED, NOT DEFAULTED. A default here would send
 * dollars to a rail that cannot take them, and the refusal would arrive from
 * the provider as something unrelated. `provider_route_coverage` is what
 * makes the gap visible before a customer finds it.
 */
@Injectable()
export class ProviderRouterService {
  readonly #logger = new Logger(ProviderRouterService.name);
  readonly #cache = new Map<string, Cached>();
  readonly #ttlMs = 5_000;

  constructor(@Inject(DATABASE) private readonly pool: Pool) {}

  /**
   * The provider for this operation and currency, or undefined when nothing
   * is routed.
   *
   * NEVER THROWS ON A DATABASE THAT PREDATES 059. A deployment behind the
   * migration has no table, and the honest answer there is "no route", which
   * every caller already has to handle — throwing would take out the naira
   * corridor that was working perfectly before this class existed.
   */
  async providerFor(
    operation: RoutedOperation,
    currency: string,
  ): Promise<string | undefined> {
    const key = `${operation}:${currency}`;
    const hit = this.#cache.get(key);
    if (hit !== undefined && Date.now() - hit.at < this.#ttlMs) return hit.provider;

    let provider: string | undefined;
    try {
      const found = await this.pool.query<{ provider: string }>(
        `SELECT provider FROM provider_routes WHERE operation = $1 AND currency = $2`,
        [operation, currency],
      );
      provider = found.rows[0]?.provider;
    } catch (error: unknown) {
      this.#logger.warn(
        `no provider route for ${key}: ${describe(error)}. ` +
          `If this says the table does not exist, apply ` +
          `packages/ledger/sql/059_provider_routing.sql.`,
      );
      provider = undefined;
    }

    this.#cache.set(key, { provider, at: Date.now() });
    return provider;
  }

  /** Every route, for the operations screen. */
  async all(): Promise<
    readonly { operation: string; currency: string; provider: string | null; status: string }[]
  > {
    const found = await this.pool.query<{
      operation: string;
      currency: string;
      provider: string | null;
      status: string;
    }>(
      /*
       * THE COVERAGE VIEW, AND EVERY ROUTE IT DOES NOT MENTION. The view is
       * driven off the currencies the platform is OPEN in and lists `collect`
       * and `payout` only, so an `account` route — or one for a corridor not
       * yet opened — would be a row in force that the operations screen never
       * showed. A screen that hides a route is a screen an operator trusts
       * about the wrong thing.
       */
      `SELECT operation, currency, provider, status FROM provider_route_coverage
       UNION ALL
       SELECT r.operation, r.currency, r.provider, 'ok'
         FROM provider_routes r
        WHERE NOT EXISTS (SELECT 1 FROM provider_route_coverage c
                           WHERE c.operation = r.operation AND c.currency = r.currency)
        ORDER BY 1, 2`,
    );
    return found.rows;
  }

  /**
   * Point a currency at a provider.
   *
   * The history row is written BY TRIGGER rather than here — 026's rule about
   * the credential rotation log: a write the endpoint performs is a write a
   * psql prompt skips, and the prompt is exactly where somebody goes at three
   * in the morning.
   */
  async route(options: {
    readonly operation: RoutedOperation;
    readonly currency: string;
    readonly provider: string;
    /** The acting staff member's UUID — `claims.sub`, never the numeric id. */
    readonly byUserUuid: string;
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO provider_routes (operation, currency, provider, updated_by)
       VALUES ($1, $2, $3, (SELECT id FROM users WHERE uuid = $4::uuid))
       ON CONFLICT (operation, currency) DO UPDATE
          SET provider = EXCLUDED.provider,
              updated_at = now(),
              updated_by = EXCLUDED.updated_by`,
      [options.operation, options.currency, options.provider, options.byUserUuid],
    );
    this.#cache.delete(`${options.operation}:${options.currency}`);
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
