import { money } from '@xetral/shared';
import type { Money } from '@xetral/shared';

/**
 * THE conversion boundary between Bitnob's micro-units and the ledger's cents.
 *
 * Bitnob expresses USD amounts in micro-units: 1 USD = 1,000,000. The ledger
 * uses minor units, and USD's exponent is 2, so 1 USD = 100 cents. Ten thousand
 * micro-units are therefore one cent.
 *
 * Every amount crossing this adapter passes through this file and nowhere else.
 * That is not tidiness — a second conversion written inline at a call site is
 * how one webhook handler ends up off by a factor of 10,000, and a factor of
 * 10,000 on a card settlement is not a rounding difference, it is the whole
 * balance.
 *
 * WHAT MUST NEVER HAPPEN HERE
 * ---------------------------
 * No `number`. A micro-unit amount of 12,345,678,901,234,567 exceeds 2^53 and
 * is silently wrong the moment it becomes a double. Bitnob sends these as JSON
 * numbers or strings; either way they are parsed straight to bigint from their
 * text, never through a float.
 *
 * The sibling `display_amount` field is a float and is for display only. It is
 * not read by anything in this file, and `webhooks.ts` does not carry it into
 * the domain event at all — there is no path by which it can reach a posting.
 */

/** 1 USD = 1,000,000 micro-units (Bitnob) = 100 cents (ledger). */
export const MICRO_PER_USD = 1_000_000n;
export const MICRO_PER_CENT = 10_000n;

export class MicroAmountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MicroAmountError';
  }
}

/**
 * Parses a micro-unit amount from whatever JSON gave us, without ever touching
 * a float.
 *
 * Accepts a string, or a number that is a safe integer. A non-integral or
 * unsafe number is REJECTED rather than coerced: by the time
 * 12345678901234567 has been through `JSON.parse` it is already
 * 12345678901234568, and no amount of care downstream recovers the lost unit.
 * Rejecting is the only honest option, and it points at the fix — ask the
 * provider for the value as a string.
 */
export function parseMicro(raw: unknown): bigint {
  if (typeof raw === 'bigint') return raw;

  if (typeof raw === 'string') {
    if (!/^-?\d+$/.test(raw.trim())) {
      throw new MicroAmountError(`micro-unit amount is not an integer string: '${raw}'`);
    }
    return BigInt(raw.trim());
  }

  if (typeof raw === 'number') {
    if (!Number.isInteger(raw)) {
      throw new MicroAmountError(`micro-unit amount is not an integer: ${raw}`);
    }
    if (!Number.isSafeInteger(raw)) {
      throw new MicroAmountError(
        `micro-unit amount ${raw} is beyond Number.MAX_SAFE_INTEGER and has already lost ` +
          `precision in JSON.parse; the provider must send this as a string`,
      );
    }
    return BigInt(raw);
  }

  throw new MicroAmountError(`micro-unit amount has unusable type '${typeof raw}'`);
}

export interface MicroToUsd {
  readonly amount: Money<'USD'>;
  /**
   * Micro-units that did not divide into whole cents.
   *
   * Returned rather than swallowed, because six decimal places into two does
   * not always land cleanly and a sub-cent remainder is real money. The caller
   * has to decide what happens to it — for a ledger posting that means routing
   * it to `suspense`, which is exactly what that account kind is for.
   */
  readonly remainderMicro: bigint;
}

/**
 * Micro-units to USD cents, truncating toward zero and handing back the
 * remainder.
 *
 * There is no rounding-mode argument on purpose, which is the opposite of the
 * rule in @xetral/shared — and the reason is that this is not a rounding
 * decision. Rounding discards the remainder and picks a direction; this keeps
 * the remainder so that nothing is discarded at all. A caller that wants to
 * round can, having seen what it is giving up.
 *
 * Truncation toward zero keeps the sign of a refund the mirror image of the
 * sign of the charge it reverses, so the pair still cancels exactly.
 */
export function microToUsd(micro: bigint): MicroToUsd {
  const cents = micro / MICRO_PER_CENT;
  const remainder = micro % MICRO_PER_CENT;
  return { amount: money(cents, 'USD'), remainderMicro: remainder };
}

/**
 * Micro-units to USD cents, refusing anything that is not a whole number of
 * cents.
 *
 * Used on paths where a sub-cent amount means something is wrong rather than
 * something is unusual — a card settlement is a real-world charge and settles
 * in cents. Failing loudly here surfaces a provider contract change as an
 * alert, instead of as a slow drip into a suspense account nobody reads.
 */
export function microToUsdExact(micro: bigint): Money<'USD'> {
  const { amount, remainderMicro } = microToUsd(micro);
  if (remainderMicro !== 0n) {
    throw new MicroAmountError(
      `${micro} micro-units is not a whole number of cents (remainder ${remainderMicro}); ` +
        `a sub-cent amount on this path means the provider contract changed`,
    );
  }
  return amount;
}

/** USD cents back to micro-units, for amounts we send Bitnob. Always exact:
 *  cents divide into micro-units with nothing left over. */
export function usdToMicro(amount: Money<'USD'>): bigint {
  return amount.amount * MICRO_PER_CENT;
}
