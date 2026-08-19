/**
 * The currency registry.
 *
 * Every currency Xetral touches is declared here, once. Nothing else in the
 * codebase is allowed to invent one, because a currency is not just a label:
 * it carries an EXPONENT, and the exponent is what turns a stored integer
 * into an amount a human recognises.
 *
 * WHY MINOR UNITS, ALWAYS
 * -----------------------
 * Money is stored and moved as an integer count of the currency's smallest
 * unit — kobo for NGN, cents for USD. Never as a decimal, never as a float.
 *
 *   0.1 + 0.2 === 0.30000000000000004
 *
 * That is not a curiosity, it is a ledger that does not balance. An FX trade
 * priced in floats accumulates error on every leg, and the error lands in a
 * suspense account nobody reconciles until an auditor asks.
 *
 * WHY THE EXPONENT IS PER-CURRENCY AND NOT A CONSTANT 2
 * -----------------------------------------------------
 * Assuming "2 decimal places" is the most common money bug in fintech, and
 * it is invisible until you add a currency that breaks it. JPY has 0 — ¥100
 * is one hundred yen, not one yen. KWD has 3. Crypto has 8 or 18. Hard-code
 * 2 and the first non-decimal currency you add is off by a factor of 100 in
 * production, silently, in the direction of paying out too much.
 *
 * Xetral does not list JPY today. It is in the registry anyway, as a live
 * test that no code path assumes 2.
 */

export const CURRENCIES = {
  // ---- Fiat: the rails Xetral settles on ----
  NGN: { exponent: 2, symbol: '₦', name: 'Nigerian Naira', kind: 'fiat' },
  USD: { exponent: 2, symbol: '$', name: 'US Dollar', kind: 'fiat' },
  GBP: { exponent: 2, symbol: '£', name: 'Pound Sterling', kind: 'fiat' },
  EUR: { exponent: 2, symbol: '€', name: 'Euro', kind: 'fiat' },
  GHS: { exponent: 2, symbol: '₵', name: 'Ghanaian Cedi', kind: 'fiat' },
  KES: { exponent: 2, symbol: 'KSh', name: 'Kenyan Shilling', kind: 'fiat' },

  /**
   * Zero-exponent. Not offered to customers — present so that any code
   * assuming `exponent === 2` fails in a test rather than in production.
   */
  JPY: { exponent: 0, symbol: '¥', name: 'Japanese Yen', kind: 'fiat' },

  // ---- Crypto: voucher settlement ----
  // 8 decimals for BTC (satoshi). USDT is 6 on Tron, 6 on Ethereum — we
  // normalise to 6 and record the chain separately on the transfer, because
  // the ledger cares about value and the chain is a routing detail.
  BTC: { exponent: 8, symbol: '₿', name: 'Bitcoin', kind: 'crypto' },
  USDT: { exponent: 6, symbol: '₮', name: 'Tether', kind: 'crypto' },
} as const satisfies Record<string, CurrencyMeta>;

export interface CurrencyMeta {
  /** Decimal places. The power of ten between minor units and major units. */
  readonly exponent: number;
  readonly symbol: string;
  readonly name: string;
  readonly kind: 'fiat' | 'crypto';
}

/**
 * The union of every valid currency code: 'NGN' | 'USD' | ...
 *
 * Derived from the registry rather than declared alongside it, so the two can
 * never disagree. Adding a currency to CURRENCIES is the only step required.
 */
export type Currency = keyof typeof CURRENCIES;

/** Currencies a customer can hold a wallet in. */
export const WALLET_CURRENCIES = ['NGN', 'USD', 'GBP', 'EUR'] as const;
export type WalletCurrency = (typeof WALLET_CURRENCIES)[number];

export function isCurrency(value: string): value is Currency {
  return Object.hasOwn(CURRENCIES, value);
}

export function exponentOf(currency: Currency): number {
  return CURRENCIES[currency].exponent;
}

/**
 * 10^exponent as a bigint — the multiplier between major and minor units.
 *
 * Computed with a loop rather than 10 ** exponent because the exponentiation
 * operator on bigint requires both operands to be bigint, and the readable
 * alternative (BigInt(10 ** exponent)) goes through a float on the way,
 * which is precisely the thing this module exists to prevent. For USDT's 6
 * and BTC's 8 the float is still exact; for an 18-decimal token it would not
 * be, and this function should not have a silent upper bound.
 */
export function scaleOf(currency: Currency): bigint {
  let scale = 1n;
  for (let i = 0; i < CURRENCIES[currency].exponent; i++) scale *= 10n;
  return scale;
}
