import { ProviderContractError } from '../ports/errors.js';

/**
 * Reading an NGN deposit amount off a Bitnob payload.
 *
 * THE MOST DANGEROUS CONVERSION IN THE CODEBASE, and it deserves its own file
 * for the same reason `amounts.ts` does. A card settlement read wrong spends a
 * customer's own money incorrectly. A DEPOSIT read wrong creates money that
 * never arrived — a factor-of-100 error turns a N500 transfer into a N50,000
 * balance the customer can immediately spend and we can never recover.
 *
 * So the unit is a stated deployment value rather than a guess baked into
 * code, and it is guarded by a ceiling. Between them:
 *
 *   - If the unit is right, everything works.
 *   - If the unit is wrong by any of the plausible factors (100 or 10,000),
 *     the very first real deposit blows the ceiling, lands in SUSPENSE, and
 *     escalates. Nobody is credited. The mistake costs an afternoon rather
 *     than a balance sheet.
 *
 * That is deliberately not the same as "we verified it": it is a design in
 * which being wrong is recoverable, which is the stronger property when a
 * provider's payload cannot be inspected before go-live.
 *
 * THE GUARD IS ASYMMETRIC, ON PURPOSE. It catches reading an amount as too
 * LARGE, because that money is spendable before anyone notices and is gone.
 * Reading one too SMALL is not caught and does not need to be: the customer
 * says "I sent more than that" within the hour, and a correcting entry fixes
 * it. Protecting equally against both would mean a floor, and a floor rejects
 * the small deposits that are most of the traffic.
 */

/**
 * How Bitnob expresses an NGN amount in a deposit payload.
 *
 * `kobo` is the default because it is the natural minor unit for NGN and what
 * the ledger itself stores. `naira` covers a provider sending major units.
 * `micro` covers the six-decimal convention their USD card webhooks use, in
 * case the same convention is applied here.
 */
export type NgnAmountUnit = 'kobo' | 'naira' | 'micro';

const KOBO_PER_UNIT: Record<NgnAmountUnit, bigint> = {
  kobo: 1n,
  naira: 100n,
  micro: 0n, // handled separately: micro DIVIDES rather than multiplies
};

/** 1 NGN = 1,000,000 micro-units, matching the card webhook convention. */
const MICRO_PER_NAIRA = 1_000_000n;

export class DepositCeilingError extends Error {
  constructor(
    readonly amountKobo: bigint,
    readonly ceilingKobo: bigint,
  ) {
    super(
      `deposit of ${amountKobo} kobo exceeds the configured ceiling of ${ceilingKobo}; ` +
        `refusing to credit. Either this is a genuinely large transfer that needs the ` +
        `ceiling raised, or BITNOB_NGN_AMOUNT_UNIT is wrong.`,
    );
    this.name = 'DepositCeilingError';
  }
}

/**
 * Parses a raw payload amount into kobo.
 *
 * Accepts a string or an integer, and REJECTS a JSON number beyond
 * MAX_SAFE_INTEGER rather than coercing it — by then `JSON.parse` has already
 * rounded it and the lost unit is unrecoverable. The fix in that case is to
 * ask the provider for a string, which is the same rule `parseMicro` applies.
 */
export function depositToKobo(raw: unknown, unit: NgnAmountUnit): bigint {
  const value = parseWhole(raw);

  if (unit === 'micro') {
    // Six decimals into two. A sub-kobo remainder is REFUSED rather than
    // rounded: a deposit is the one flow where rounding invents money that no
    // bank actually sent, and the amount must equal what left the customer's
    // account to the kobo.
    if (value % (MICRO_PER_NAIRA / 100n) !== 0n) {
      throw new ProviderContractError(
        'bitnob',
        `deposit amount ${value} micro-units is not a whole number of kobo`,
      );
    }
    return value / (MICRO_PER_NAIRA / 100n);
  }

  return value * KOBO_PER_UNIT[unit];
}

/** Applies the ceiling. Separate from parsing so a caller cannot skip it by
 *  accident — it has to be called, and it throws rather than returning a flag. */
export function assertWithinCeiling(amountKobo: bigint, ceilingKobo: bigint): void {
  if (amountKobo > ceilingKobo) throw new DepositCeilingError(amountKobo, ceilingKobo);
}

function parseWhole(raw: unknown): bigint {
  if (typeof raw === 'string') {
    if (!/^[0-9]+$/.test(raw.trim())) {
      throw new ProviderContractError('bitnob', `deposit amount '${raw}' is not a whole number`);
    }
    return BigInt(raw.trim());
  }

  if (typeof raw === 'number') {
    if (!Number.isSafeInteger(raw)) {
      throw new ProviderContractError(
        'bitnob',
        `deposit amount ${raw} is not a safe integer; JSON.parse has already lost precision. ` +
          `Ask the provider to send this field as a string.`,
      );
    }
    return BigInt(raw);
  }

  throw new ProviderContractError('bitnob', `deposit amount has type ${typeof raw}`);
}
