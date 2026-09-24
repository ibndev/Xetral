import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Currency, Money } from '@xetral/shared';
import type { PayoutPort } from '@xetral/providers';
import { PAYOUT_PORT } from '../tokens.js';

/**
 * WHAT EACH PAYOUT RAIL CAN ACTUALLY SPEND, asked of the rail itself.
 *
 * THE LEDGER CANNOT ANSWER THIS, and that is the finding behind the whole
 * file. `provider_float` is one account PER CURRENCY, not per provider: naira
 * a customer paid in through Paystack reads there as naira held, and so do
 * cedis a platform-priced conversion credited without paying any provider
 * anything. So a customer can hold cedis and naira that the ledger agrees
 * are backed, while Flutterwave — the rail that must pay them out — holds
 * none of either, and refuses. 073's guard read that ledger figure and was
 * satisfied every time.
 *
 * READ-ONLY, CACHED FOR THIRTY SECONDS, AND NEVER A REASON TO MOVE MONEY. A
 * balance is a figure that is stale the moment it is read; what this buys is
 * refusing a payout the rail would certainly refuse, BEFORE the customer's
 * money is held, with a reason that names us rather than their number — and
 * choosing another rail that can pay where the routing allows one.
 *
 * AN UNREADABLE BALANCE IS `undefined`, NEVER ZERO. Zero is a real answer and
 * would refuse every payout on the afternoon a balance endpoint is down;
 * undefined falls back to exactly what happened before this existed.
 */
@Injectable()
export class ProviderLiquidityService {
  readonly #logger = new Logger(ProviderLiquidityService.name);
  readonly #cache = new Map<string, { at: number; value: readonly Money<Currency>[] | undefined }>();

  constructor(@Inject(PAYOUT_PORT) private readonly port: PayoutPort) {}

  /** Every rail this deployment can pay out on. */
  rails(): readonly string[] {
    const switched = this.port as PayoutPort & { providers?: readonly string[] };
    return switched.providers ?? [this.port.provider];
  }

  /** Everything a rail says it holds, or undefined where it cannot say. */
  async balancesOf(provider: string, fresh = false): Promise<readonly Money<Currency>[] | undefined> {
    if (this.port.balancesOf === undefined) return undefined;
    const cached = this.#cache.get(provider);
    if (!fresh && cached !== undefined && Date.now() - cached.at < CACHE_MS) return cached.value;

    let value: readonly Money<Currency>[] | undefined;
    try {
      value = await this.port.balancesOf(provider);
    } catch (error) {
      // A rail we cannot ask is not a rail with nothing in it.
      this.#logger.warn(
        `could not read the ${provider} balance: ${error instanceof Error ? error.message : String(error)}`,
      );
      value = undefined;
    }
    this.#cache.set(provider, { at: Date.now(), value });
    return value;
  }

  /**
   * What one rail can spend in one currency, in minor units — undefined where
   * the rail has no readable balance. A readable balance that simply does not
   * list the currency is ZERO: the rail answered and holds none.
   */
  async available(provider: string, currency: string): Promise<bigint | undefined> {
    const held = await this.balancesOf(provider);
    if (held === undefined) return undefined;
    return held.find((m) => m.currency === currency)?.amount ?? 0n;
  }

  /** Called after a rail refuses for funds, so the next read is not the stale one. */
  forget(provider: string): void {
    this.#cache.delete(provider);
  }
}

const CACHE_MS = 30_000;
