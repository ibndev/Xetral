import {
  type Currency,
  CURRENCIES,
  exponentOf,
  scaleOf,
} from './currency.js';

/**
 * An amount of money, as an integer count of minor units.
 *
 * Money is generic over its currency, and that is the entire point:
 *
 *   const fee: Money<'NGN'> = ngn(5000);
 *   const bal: Money<'USD'> = usd(1000);
 *   add(fee, bal);   // ← does not compile
 *
 * Adding naira to dollars is not a runtime error to be caught by a test. It
 * is a type error, caught before the code runs, on every developer's machine
 * and in CI. The compiler is the cheapest auditor available.
 *
 * `amount` is bigint, not number. JS numbers are exact only to 2^53, which is
 * about ₦90 trillion in kobo — survivable for one wallet, not for the sum of
 * every posting in a platform-wide account. bigint has no upper bound, and it
 * maps one-to-one onto Postgres BIGINT with no lossy step between.
 *
 * THE `in out` IS LOAD-BEARING. DO NOT REMOVE IT.
 * ----------------------------------------------
 * Without it the guarantee above is FICTION, and it fails silently. `C`
 * appears only in a covariant position (the `currency` property), so
 * TypeScript happily widens it: `Money<'NGN'>` and `Money<'USD'>` are both
 * assignable to `Money<'NGN' | 'USD'>`, the compiler infers that union for
 * `C`, and `add(ngn(100), usd(100))` COMPILES CLEANLY.
 *
 * `in out` declares `C` invariant, so the widening is rejected and the call
 * is the type error it should always have been. This was verified by
 * compiling the failing case, not assumed — see the `does not compile` test
 * in money.test.ts, which asserts the error is still produced.
 */
export interface Money<in out C extends Currency = Currency> {
  readonly amount: bigint;
  readonly currency: C;
}

/** Construct money from an integer count of MINOR units (kobo, cents). */
export function money<C extends Currency>(amount: bigint | number, currency: C): Money<C> {
  if (typeof amount === 'number' && !Number.isInteger(amount)) {
    throw new RangeError(
      `money() takes MINOR units as an integer; got ${amount} ${currency}. ` +
        `For a major-unit decimal use fromMajor().`,
    );
  }
  return { amount: BigInt(amount), currency };
}

export const ngn = (minor: bigint | number): Money<'NGN'> => money(minor, 'NGN');
export const usd = (minor: bigint | number): Money<'USD'> => money(minor, 'USD');

export const zero = <C extends Currency>(currency: C): Money<C> => money(0n, currency);

/* ------------------------------------------------------------------ *
 * Arithmetic
 *
 * Every operation that combines two amounts is constrained to a single
 * currency parameter C. There is deliberately NO function that adds across
 * currencies: converting is a ledger event with a rate, a spread and a
 * counterparty, so it belongs in the FX module where those can be recorded —
 * not in a helper that quietly produces a number.
 * ------------------------------------------------------------------ */

export function add<C extends Currency>(a: Money<C>, b: Money<C>): Money<C> {
  assertSameCurrency(a, b);
  return { amount: a.amount + b.amount, currency: a.currency };
}

export function subtract<C extends Currency>(a: Money<C>, b: Money<C>): Money<C> {
  assertSameCurrency(a, b);
  return { amount: a.amount - b.amount, currency: a.currency };
}

export function negate<C extends Currency>(a: Money<C>): Money<C> {
  return { amount: -a.amount, currency: a.currency };
}

export function sum<C extends Currency>(currency: C, amounts: readonly Money<C>[]): Money<C> {
  let total = 0n;
  for (const m of amounts) {
    if (m.currency !== currency) {
      throw new TypeError(`sum(${currency}) received a ${m.currency} amount`);
    }
    total += m.amount;
  }
  return { amount: total, currency };
}

/**
 * The runtime twin of the compile-time constraint.
 *
 * The generic already makes mismatched addition impossible in typed code, so
 * this looks redundant — and for typed callers it is. It exists for the
 * boundary: JSON off the wire, a row out of the database, a provider webhook.
 * Those arrive as `any` no matter how strict the config, and the type
 * parameter cannot help there. This is the check that catches a provider
 * silently switching a settlement currency.
 */
function assertSameCurrency<A extends Currency, B extends Currency>(
  a: Money<A>,
  b: Money<B>,
): void {
  // Widened to the base union before comparing. With `A` and `B` as distinct
  // parameters the compiler judges them non-overlapping and flags `!==` as a
  // mistake (TS2367) — reasonable, since in TYPED code this can never fire.
  // The comparison is here for untyped input, so the widening states plainly
  // that two currency codes are being compared at runtime.
  const left: Currency = a.currency;
  const right: Currency = b.currency;
  if (left !== right) {
    throw new TypeError(
      `currency mismatch: ${left} and ${right}. ` +
        `Cross-currency movement must go through the FX module so the rate ` +
        `and spread are recorded as postings.`,
    );
  }
}

/* ------------------------------------------------------------------ *
 * Comparison
 *
 * Every helper below is generic over C even where it only READS the amount.
 * That looks like noise, and it is not: because `Money` is invariant in C,
 * the bare type `Money` means `Money<Currency>` — money in the UNION of all
 * currencies at once — and `Money<'NGN'>` is deliberately not assignable to
 * it. Typing a parameter as plain `Money` would reject every real caller.
 * ------------------------------------------------------------------ */

export const isZero = <C extends Currency>(a: Money<C>): boolean => a.amount === 0n;
export const isPositive = <C extends Currency>(a: Money<C>): boolean => a.amount > 0n;
export const isNegative = <C extends Currency>(a: Money<C>): boolean => a.amount < 0n;

export function compare<C extends Currency>(a: Money<C>, b: Money<C>): -1 | 0 | 1 {
  assertSameCurrency(a, b);
  if (a.amount < b.amount) return -1;
  if (a.amount > b.amount) return 1;
  return 0;
}

export const equals = <C extends Currency>(a: Money<C>, b: Money<C>): boolean =>
  compare(a, b) === 0;
export const greaterThan = <C extends Currency>(a: Money<C>, b: Money<C>): boolean =>
  compare(a, b) === 1;
export const lessThan = <C extends Currency>(a: Money<C>, b: Money<C>): boolean =>
  compare(a, b) === -1;

/* ------------------------------------------------------------------ *
 * Fees and proportions
 * ------------------------------------------------------------------ */

/**
 * Apply a rate given in BASIS POINTS (1 bp = 0.01%). 150 bp = 1.5%.
 *
 * Rates are integers because a "1.5% fee" expressed as 0.015 is a float, and
 * a float in a fee calculation is a rounding difference between what the
 * customer was shown and what the ledger recorded.
 *
 * `rounding` is required, with no default. Every rounding choice moves money
 * to somebody, and which way it moves is a commercial and regulatory
 * decision, not a detail to inherit from whoever wrote the helper. A caller
 * must state it, and the statement is visible in review.
 */
export function applyBasisPoints<C extends Currency>(
  amount: Money<C>,
  basisPoints: number,
  rounding: 'up' | 'down' | 'half-even',
): Money<C> {
  if (!Number.isInteger(basisPoints) || basisPoints < 0) {
    throw new RangeError(`basisPoints must be a non-negative integer, got ${basisPoints}`);
  }
  const numerator = amount.amount * BigInt(basisPoints);
  return { amount: divideRounded(numerator, 10_000n, rounding), currency: amount.currency };
}

/**
 * Splits a VAT-INCLUSIVE amount into what we keep and what we owe.
 *
 * The customer paid `gross`. Part of it was never ours: at 7.5% the tax inside
 * a gross fee is `gross × 750 / 10750`, NOT `gross × 750 / 10000` — the second
 * is the tax on a fee of that size EXCLUDING tax, which is a different and
 * larger number. Getting this backwards under-collects on every single
 * transaction, and the error is invisible until a return is reconciled.
 *
 * THE TAX ROUNDS UP, and the direction is the decision. The remainder has to
 * go somewhere, and giving it to the revenue authority means we can never
 * under-remit — at worst we are a fraction of a kobo out of pocket per
 * transaction. Rounding it toward ourselves would mean systematically
 * collecting less tax than was due on a rate somebody else sets, which is not
 * a position to be in.
 *
 * Returns both halves so a caller cannot compute one and infer the other
 * wrongly; they sum to `gross` exactly, by construction.
 */
export function splitInclusiveTax<C extends Currency>(
  gross: Money<C>,
  basisPoints: number,
): { readonly net: Money<C>; readonly tax: Money<C> } {
  if (!Number.isInteger(basisPoints) || basisPoints < 0) {
    throw new RangeError(`basisPoints must be a non-negative integer, got ${basisPoints}`);
  }
  if (gross.amount < 0n) {
    // A negative gross would make "round up" move the tax the other way, and
    // there is no flow here that charges a negative fee. Refusing beats
    // guessing which direction was meant.
    throw new RangeError('cannot split tax out of a negative amount');
  }

  const rate = BigInt(basisPoints);
  const tax = divideRounded(gross.amount * rate, 10_000n + rate, 'up');
  return {
    net: { amount: gross.amount - tax, currency: gross.currency },
    tax: { amount: tax, currency: gross.currency },
  };
}

/**
 * Integer division with an explicit rounding mode.
 *
 * bigint division truncates toward zero, which for a NEGATIVE numerator
 * rounds UP in value (-7n / 2n === -3n, not -4n). Left unhandled, a fee on a
 * reversal rounds the opposite way from the same fee on the original — and
 * the two do not cancel. Every branch below is written in terms of the true
 * mathematical direction, not the truncation the operator happens to give.
 */
export function divideRounded(
  numerator: bigint,
  denominator: bigint,
  rounding: 'up' | 'down' | 'half-even',
): bigint {
  if (denominator === 0n) throw new RangeError('division by zero');

  const negative = numerator < 0n !== denominator < 0n;
  const absNum = numerator < 0n ? -numerator : numerator;
  const absDen = denominator < 0n ? -denominator : denominator;

  const quotient = absNum / absDen;
  const remainder = absNum % absDen;
  if (remainder === 0n) return negative ? -quotient : quotient;

  let magnitude: bigint;
  switch (rounding) {
    case 'up': // away from zero
      magnitude = quotient + 1n;
      break;
    case 'down': // toward zero
      magnitude = quotient;
      break;
    case 'half-even': {
      // Banker's rounding: ties go to the even neighbour, so a long run of
      // .5 cases does not drift upward the way half-up does. This is the
      // default an auditor expects on interest and FX.
      const twice = remainder * 2n;
      if (twice > absDen) magnitude = quotient + 1n;
      else if (twice < absDen) magnitude = quotient;
      else magnitude = quotient % 2n === 0n ? quotient : quotient + 1n;
      break;
    }
  }
  return negative ? -magnitude : magnitude;
}

/**
 * Split an amount into n parts that sum EXACTLY back to the original.
 *
 * ₦100 into 3 is 33.33, 33.33, 33.34 — never 33.33 × 3, which loses a kobo.
 * The remainder is distributed one minor unit at a time across the leading
 * parts. Used for instalments and for allocating a fee across several
 * postings; anywhere the parts must reconcile to the whole.
 */
export function allocate<C extends Currency>(amount: Money<C>, parts: number): Money<C>[] {
  if (!Number.isInteger(parts) || parts < 1) {
    throw new RangeError(`parts must be a positive integer, got ${parts}`);
  }
  const n = BigInt(parts);
  const base = amount.amount / n;
  let remainder = amount.amount % n;
  const step = remainder < 0n ? -1n : 1n;
  if (remainder < 0n) remainder = -remainder;

  return Array.from({ length: parts }, (_, i) => ({
    amount: BigInt(i) < remainder ? base + step : base,
    currency: amount.currency,
  }));
}

/* ------------------------------------------------------------------ *
 * Parsing and formatting
 * ------------------------------------------------------------------ */

/**
 * Parse a MAJOR-unit decimal string into minor units. "1234.56" → 123456n.
 *
 * Takes a string, not a number, and that is deliberate: by the time a decimal
 * is a JS number the precision is already gone, and no amount of care here
 * gets it back. Anything that reaches this function should have come from an
 * input field or an API payload as text.
 */
export function fromMajor<C extends Currency>(input: string, currency: C): Money<C> {
  const trimmed = input.trim().replace(/,/g, '');
  const match = /^(-)?(\d+)(?:\.(\d+))?$/.exec(trimmed);
  if (!match) throw new RangeError(`not a valid decimal amount: "${input}"`);

  const [, sign, whole, fraction = ''] = match;
  const exponent = exponentOf(currency);

  if (fraction.length > exponent) {
    // Silently truncating here is how a customer is charged more than the
    // screen showed them. Reject, and make the caller decide.
    throw new RangeError(
      `${currency} has ${exponent} decimal place(s); "${input}" has ${fraction.length}`,
    );
  }

  const padded = fraction.padEnd(exponent, '0');
  const amount = BigInt(`${whole}${padded}`);
  return { amount: sign === '-' ? -amount : amount, currency };
}

/** Minor units back to a plain major-unit string. 123456n → "1234.56" */
export function toMajor<C extends Currency>(m: Money<C>): string {
  const exponent = exponentOf(m.currency);
  const negative = m.amount < 0n;
  const abs = negative ? -m.amount : m.amount;

  if (exponent === 0) return `${negative ? '-' : ''}${abs}`;

  const scale = scaleOf(m.currency);
  const whole = abs / scale;
  const fraction = (abs % scale).toString().padStart(exponent, '0');
  return `${negative ? '-' : ''}${whole}.${fraction}`;
}

/**
 * Format for display. "₦1,234.56"
 *
 * Uses Intl for fiat so grouping and placement follow the locale rather than
 * our assumptions. Crypto goes through a manual path because Intl's currency
 * data does not cover BTC or USDT and silently falls back to a bare code.
 *
 * THE DECIMAL STRING GOES TO INTL DIRECTLY. This used to read
 * `.format(Number(toMajor(m)))`, and that `Number` was a float holding money
 * in the one file whose whole purpose is that money is never a float. It is
 * not theoretical: a naira balance past 2^53 minor units formatted as
 * ₦90,071,992,547,409,940.00 for ₦90,071,992,547,409,931.23 — wrong in the
 * digits somebody reads to decide whether they have been paid.
 *
 * `Intl.NumberFormat.format` has accepted a string since ES2023 and formats it
 * exactly, so the locale-aware placement this function exists for costs
 * nothing. Found by writing the Semgrep rule that now forbids the pattern,
 * which is the argument for having written it.
 */
export function format<C extends Currency>(
  m: Money<C>,
  options: { locale?: string; showCode?: boolean } = {},
): string {
  const { locale = 'en-NG', showCode = false } = options;
  const meta = CURRENCIES[m.currency];

  if (meta.kind === 'crypto') {
    const value = toMajor(m).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
    return `${value} ${m.currency}`;
  }

  const formatted = new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: m.currency,
    minimumFractionDigits: meta.exponent,
    maximumFractionDigits: meta.exponent,
    /*
     * The cast, and why it is not the thing this file forbids. TypeScript
     * types Intl's string overload as `StringNumericLiteral` — a template
     * literal type no ordinary `string` satisfies — so the alternative to a
     * cast here is `Number()`, which is the float this whole module exists to
     * avoid. `toMajor` produces a plain decimal numeric string by
     * construction, so the cast asserts something already true rather than
     * widening anything.
     */
  }).format(toMajor(m) as `${number}`);

  return showCode ? `${formatted} ${m.currency}` : formatted;
}
