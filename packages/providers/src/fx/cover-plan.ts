import { money } from '@xetral/shared';
import type { Currency } from '@xetral/shared';
import type { FxRate } from '../ports/fx.js';
import { convertWithSpread } from './rate-math.js';

/**
 * WHICH OF A CUSTOMER'S WALLETS PAY FOR A CARD TOP-UP, AND HOW MUCH OF EACH.
 *
 * WHY IT IS A TOP-UP AND NOT A SPEND. A Bitnob card is a prepaid USD card and
 * Bitnob approves every authorization against the card's OWN balance before
 * we hear of it — a card at $0 declines "even if your USD wallet has funds",
 * in their words, and four insufficient-funds declines in a row cost a penalty
 * and terminate the card. There is no request we can answer to fund a spend
 * as it happens. So the cascade runs where the money can still be chosen: on
 * its way ONTO the card. The same planner would run at authorization if the
 * issuer ever offers a decision hook; nothing in it knows which moment it is.
 *
 * THE ORDER IS THE CALLER'S, and it is fixed rather than asked: the wallet in
 * the card's own currency first, then the card's base currency, then the
 * platform's order. A customer is never asked which balance to use per
 * top-up.
 *
 * ONLY WHAT IS TAPPED IS CONVERTED. A wallet the plan does not reach is not
 * touched at all, and a wallet it does reach converts the LEAST amount that
 * covers what is still owed — so the spread (the conversion fee) is paid on
 * exactly the part that needed converting. Choosing the order costs nothing.
 *
 * A PLAN, NOT A CHECK. It reads balances to decide an order of work; it
 * guards nothing. Each conversion still meets the overdraft guard, the pair's
 * minimum and the rate-moved floor when it executes, so a plan made stale by
 * another request fails loudly rather than moving money it no longer has.
 */

export interface CoverPricing {
  readonly rate: FxRate;
  /** What `convert()` would charge today — including any widening. */
  readonly spreadBasisPoints: number;
  /** The pair's published minimum, in the SOURCE currency's minor units. */
  readonly minBaseMinor: bigint;
}

export interface CoverSource {
  readonly currency: Currency;
  /** What can be spent now, in this currency's minor units. */
  readonly spendableMinor: bigint;
  /**
   * How this currency becomes the target. Absent for the target currency
   * itself, and absent for a pair nobody has priced — which is skipped, never
   * converted at a guess.
   */
  readonly pricing?: CoverPricing;
}

export interface CoverLeg {
  readonly currency: Currency;
  /** Taken from this wallet, in its own minor units. */
  readonly debitMinor: bigint;
  /** What it becomes in the target currency. Equal to `debitMinor` for the
   *  target's own wallet, which converts nothing. */
  readonly deliversMinor: bigint;
  readonly converted: boolean;
  /** Zero for a leg that converts nothing: no fee is charged to decide. */
  readonly spreadBasisPoints: number;
  /** The EFFECTIVE rate, spread included — what a statement shows. */
  readonly appliedNumerator: bigint;
  readonly appliedDenominator: bigint;
}

export type CoverPlan =
  | {
      readonly covered: true;
      readonly legs: readonly CoverLeg[];
      /** Delivered beyond the need — a conversion rounds UP to cover, or a
       *  pair's minimum is above what was owed. It lands in the customer's
       *  own target-currency wallet and stays theirs. */
      readonly surplusMinor: bigint;
    }
  | { readonly covered: false };

export function planCover(needMinor: bigint, target: Currency, sources: readonly CoverSource[]): CoverPlan {
  if (needMinor <= 0n) throw new RangeError('a cover plan needs a positive amount');

  const legs: CoverLeg[] = [];
  let remaining = needMinor;
  let delivered = 0n;

  for (const source of sources) {
    if (remaining <= 0n) break;
    if (source.spendableMinor <= 0n) continue;

    if (source.currency === target) {
      const take = source.spendableMinor < remaining ? source.spendableMinor : remaining;
      legs.push({
        currency: target,
        debitMinor: take,
        deliversMinor: take,
        converted: false,
        spreadBasisPoints: 0,
        appliedNumerator: 1n,
        appliedDenominator: 1n,
      });
      remaining -= take;
      delivered += take;
      continue;
    }

    const pricing = source.pricing;
    if (pricing === undefined) continue;
    if (pricing.rate.base !== source.currency || pricing.rate.quote !== target) {
      throw new RangeError(`a ${source.currency} source was priced with a ${pricing.rate.base}→${pricing.rate.quote} rate`);
    }

    const needed = leastToDeliver(remaining, source.currency, pricing);
    let debit: bigint | undefined;
    if (needed !== undefined && needed <= source.spendableMinor) {
      debit = needed < pricing.minBaseMinor ? pricing.minBaseMinor : needed;
      // A minimum above the whole balance cannot be met from this wallet.
      if (debit > source.spendableMinor) debit = undefined;
    } else if (source.spendableMinor >= pricing.minBaseMinor) {
      // Not enough here to finish: all of it, and the next wallet does the rest.
      debit = source.spendableMinor;
    }
    if (debit === undefined) continue;

    let out;
    try {
      out = convertWithSpread(money(debit, source.currency), pricing.rate, pricing.spreadBasisPoints);
    } catch {
      // Too small to yield a single minor unit of the target: this wallet
      // cannot help, and that is not an error in the plan.
      continue;
    }
    legs.push({
      currency: source.currency,
      debitMinor: debit,
      deliversMinor: out.quoteMinor,
      converted: true,
      spreadBasisPoints: pricing.spreadBasisPoints,
      appliedNumerator: out.appliedNumerator,
      appliedDenominator: out.appliedDenominator,
    });
    remaining -= out.quoteMinor;
    delivered += out.quoteMinor;
  }

  if (remaining > 0n) return { covered: false };
  return { covered: true, legs, surplusMinor: delivered - needMinor };
}

/**
 * The fewest source minor units that deliver at least `targetMinor` once the
 * spread and both round-downs in `convertWithSpread` have been applied.
 *
 * Closed form first — ceil(target × den × 10000 / (num × (10000 − bps))) is
 * enough by construction — then stepped DOWN while one less still covers, so
 * the customer is never charged a unit more than the conversion needs.
 * Undefined when the rate cannot deliver anything at all.
 */
export function leastToDeliver(
  targetMinor: bigint,
  from: Currency,
  pricing: Pick<CoverPricing, 'rate' | 'spreadBasisPoints'>,
): bigint | undefined {
  const keep = 10_000n - BigInt(pricing.spreadBasisPoints);
  if (keep <= 0n || pricing.rate.numerator <= 0n) return undefined;
  const top = targetMinor * pricing.rate.denominator * 10_000n;
  const bottom = pricing.rate.numerator * keep;
  let base = (top + bottom - 1n) / bottom;
  if (base <= 0n) base = 1n;

  const delivers = (b: bigint): bigint => {
    try {
      return convertWithSpread(money(b, from), pricing.rate, pricing.spreadBasisPoints).quoteMinor;
    } catch {
      return 0n;
    }
  };
  // Upward is a safety net the closed form should never need.
  while (delivers(base) < targetMinor) base += 1n;
  while (base > 1n && delivers(base - 1n) >= targetMinor) base -= 1n;
  return base;
}

/**
 * THE PLATFORM'S ORDER, after the target and the card's base currency.
 *
 * Dollar stablecoins before fiat — converting a dollar-pegged coin into
 * dollars moves the least value across a rate — then the operating fiat
 * currencies, then Bitcoin LAST: it is the balance a customer is most likely
 * holding on purpose, and the one whose price moves most between quote and
 * fill.
 */
export const CASCADE_ORDER: readonly Currency[] = ['USD', 'USDT', 'USDC', 'NGN', 'GHS', 'KES', 'GBP', 'CAD', 'EUR', 'BTC'];

/** The order a top-up taps wallets in: the card's own currency, its base
 *  currency, then `CASCADE_ORDER`. Each currency appears once. */
export function cascadeOrder(target: Currency, base: Currency | undefined): readonly Currency[] {
  const out: Currency[] = [target];
  if (base !== undefined && base !== target) out.push(base);
  for (const c of CASCADE_ORDER) if (!out.includes(c)) out.push(c);
  return out;
}
