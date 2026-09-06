import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Pool } from 'pg';
import { DATABASE } from '../tokens.js';

/** What a route can be about. Money in, or money out. */
export type RoutedOperation = 'collect' | 'payout';

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
    }>(`SELECT operation, currency, provider, status
          FROM provider_route_coverage
         ORDER BY operation, currency`);
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
    readonly byUserId: number;
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO provider_routes (operation, currency, provider, updated_by)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (operation, currency) DO UPDATE
          SET provider = EXCLUDED.provider,
              updated_at = now(),
              updated_by = EXCLUDED.updated_by`,
      [options.operation, options.currency, options.provider, options.byUserId],
    );
    this.#cache.delete(`${options.operation}:${options.currency}`);
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
