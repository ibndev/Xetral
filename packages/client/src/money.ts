/**
 * Money, on the client side, is a STRING and stays one.
 *
 * The API sends major units as decimal strings — "1650250.00" — precisely so
 * no float is involved anywhere. The moment a client calls `parseFloat` to
 * format a balance, the guarantee the whole backend is built around is gone,
 * and it is gone in the one place a customer actually reads.
 *
 * So everything here operates on the digits themselves. Nothing in this file
 * converts to a number, and there is deliberately no `toNumber` for somebody
 * to reach for.
 */

export interface ParsedAmount {
  readonly negative: boolean;
  readonly whole: string;
  readonly fraction: string;
}

/** Splits a decimal string without going through a float. */
export function parseAmount(amount: string): ParsedAmount {
  const trimmed = amount.trim();
  if (!/^-?[0-9]+(\.[0-9]+)?$/.test(trimmed)) {
    throw new RangeError(`'${amount}' is not a decimal amount`);
  }

  const negative = trimmed.startsWith('-');
  const unsigned = negative ? trimmed.slice(1) : trimmed;
  const dot = unsigned.indexOf('.');

  return {
    negative,
    whole: dot === -1 ? unsigned : unsigned.slice(0, dot),
    fraction: dot === -1 ? '' : unsigned.slice(dot + 1),
  };
}

const SYMBOLS: Record<string, string> = {
  NGN: '₦',
  USD: '$',
  GBP: '£',
  EUR: '€',
  USDT: '₮',
  BTC: '₿',
};

/**
 * Formats for display: grouping separators, the currency's symbol, and NOT ONE
 * DIGIT changed.
 *
 * `Intl.NumberFormat` is deliberately not used. It takes a number, and a BTC
 * balance with eight decimals or a large naira balance in kobo is exactly
 * where a float starts lying — quietly, in the digits a customer is reading to
 * decide whether they have been paid.
 */
export function formatAmount(amount: string, currency: string): string {
  const { negative, whole, fraction } = parseAmount(amount);

  let grouped = '';
  for (let i = 0; i < whole.length; i += 1) {
    if (i > 0 && (whole.length - i) % 3 === 0) grouped += ',';
    grouped += whole[i];
  }

  const symbol = SYMBOLS[currency] ?? '';
  const suffix = symbol === '' ? ` ${currency}` : '';
  const body = fraction === '' ? grouped : `${grouped}.${fraction}`;

  return `${negative ? '-' : ''}${symbol}${body}${suffix}`;
}

/**
 * Is this a well-formed amount for this currency?
 *
 * Used to validate input BEFORE sending, so a customer is told about a third
 * decimal place on a naira amount by the form rather than by a 400 from a
 * money-moving endpoint.
 */
export function isValidAmount(input: string, exponent: number): boolean {
  const trimmed = input.trim();
  if (!/^[0-9]+(\.[0-9]+)?$/.test(trimmed)) return false;

  const dot = trimmed.indexOf('.');
  if (dot !== -1 && trimmed.length - dot - 1 > exponent) return false;

  // Zero is well-formed and still not a payment. The caller decides what to
  // say about it; this only reports that it moves nothing.
  return /[1-9]/.test(trimmed);
}

/** Decimal places per currency, mirroring the server's registry. Kept small
 *  and explicit rather than imported, so a client bundle does not pull in the
 *  whole money package to format a label. */
export const EXPONENTS: Record<string, number> = {
  NGN: 2, USD: 2, GBP: 2, EUR: 2, GHS: 2, KES: 2, JPY: 0, USDT: 6, BTC: 8,
};

export function exponentFor(currency: string): number {
  return EXPONENTS[currency] ?? 2;
}

/**
 * Formats MINOR units — an integer string, the way the ledger stores money.
 *
 * SEPARATE FROM `formatAmount`, which takes major units, and the separation is
 * the point: the two look identical at a call site and differ by a factor of
 * a hundred. The admin surface reads `*_minor` columns straight out of views,
 * and `formatAmount('500000000', 'NGN')` renders ₦500,000,000 for what is
 * really ₦5,000,000 — an error a reviewer deciding whether a transaction is
 * reportable has no way to see. Found on the compliance queue, which had been
 * doing exactly that.
 *
 * The exponent is PER CURRENCY. Six for USDT, eight for BTC, zero for JPY, and
 * never a hardcoded two.
 *
 * No division, and no number anywhere: the decimal point is inserted into the
 * digits.
 */
export function formatMinor(minor: string, currency: string): string {
  const trimmed = minor.trim();
  if (!/^-?[0-9]+$/.test(trimmed)) {
    throw new RangeError(`'${minor}' is not an integer amount of minor units`);
  }

  const negative = trimmed.startsWith('-');
  const digits = negative ? trimmed.slice(1) : trimmed;
  const exponent = exponentFor(currency);

  const padded = digits.padStart(exponent + 1, '0');
  const whole = exponent === 0 ? padded : padded.slice(0, padded.length - exponent);
  const fraction = exponent === 0 ? '' : padded.slice(padded.length - exponent);

  return formatAmount(`${negative ? '-' : ''}${whole}${fraction === '' ? '' : `.${fraction}`}`, currency);
}
