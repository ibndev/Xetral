/**
 * The amount keypad's arithmetic, shared by both apps.
 *
 * ONE COPY, because two would drift — and the copy that drifts is the one a
 * customer is reading while deciding how much money to send. The comp draws
 * the same till on the phone and on a laptop; these are the four things that
 * screen has to get right, and none of them may touch a float.
 */
import { exponentFor } from './money.js';

/**
 * The keypad: three columns, with a decimal point, zero and delete on the
 * last row.
 *
 * THE COMP PUTS `000` IN THE BOTTOM-LEFT AND THIS IS THE ONE DELIBERATE
 * DEPARTURE FROM IT, because `000` is a convenience and a decimal point is a
 * capability.
 *
 * The comp is drawn in naira, where amounts are whole and `000` saves three
 * taps. This platform also sends US dollars, USDT at six decimal places and
 * Bitcoin at eight — and on the phone the keypad REPLACED the text input, so
 * a pad without a point is a pad on which $10.50 cannot be typed at all.
 * That is a customer unable to send an amount rather than a customer tapping
 * three more times.
 *
 * `pressKey` refuses a second point, so the key is inert once one is there.
 */
export const PAD = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '.', '0', '<'] as const;

/**
 * What a key press does to the amount.
 *
 * THE AMOUNT IS A STRING AND STAYS ONE. No `Number`, no `parseFloat` — this
 * is money, and the whole client is built on the rule that an amount never
 * becomes a float. So a leading zero is stripped textually and a decimal
 * point is refused a second time by looking for one, not by parsing.
 *
 * `000` IS ONE KEY AND APPENDS THREE ZEROES, which is what it is for on a
 * naira keypad — and it is refused on an empty box, because `000` alone is
 * not an amount.
 */
export function pressKey(was: string, key: string): string {
  if (key === '<') return was.slice(0, -1);
  if (key === '000' && was === '') return was;
  // A SECOND POINT IS REFUSED, and a leading one becomes `0.` rather than
  // `.` — an amount that starts with a separator is not one, and every
  // validator downstream would reject it after the customer had typed it.
  if (key === '.') {
    if (was.includes('.')) return was;
    return was === '' ? '0.' : `${was}.`;
  }
  const next = was + key;
  // Twelve digits is a trillion naira. The cap is on DIGITS rather than on
  // length so a decimal point does not eat one.
  if (next.replace(/[^0-9]/g, '').length > 12) return was;
  return next.replace(/^0+(?=\d)/, '');
}

/**
 * The typed amount, grouped for display only.
 *
 * `₦5000` was on screen where the comp shows `₦50,000`. A figure at 46px is
 * the thing being agreed to, and an ungrouped one is read digit by digit —
 * which is exactly the mistake that puts an extra zero on a transfer.
 *
 * ONLY THE INTEGER PART, and the decimals are left exactly as typed.
 * `formatAmount` would be wrong here: it forces the currency's own decimal
 * places, so "5" becomes "5.00" mid-keystroke and the box fights the person
 * using it. And it is a STRING throughout — no `Number`, no `toLocaleString`,
 * because this is money.
 */
export function groupTyped(amount: string): string {
  const [whole = '', rest] = amount.split('.');
  const grouped = (whole.match(/\d+/) ?? [''])[0]
    .split('')
    .reverse()
    .reduce((out, d, i) => (i > 0 && i % 3 === 0 ? `${d},${out}` : d + out), '');
  return rest === undefined ? grouped : `${grouped}.${rest}`;
}

/**
 * The fee on an amount, as a major-unit string, computed WITHOUT a float.
 *
 * Basis points are integers and the amount is a decimal string, so the whole
 * calculation is done in minor units as a `bigint` and formatted back. A
 * `Number(amount) * bp / 10000` would be a float holding money on the screen
 * that tells a customer what they are about to be charged — which the local
 * Semgrep rule refuses, and rightly.
 *
 * ROUNDED UP, so the figure shown is never less than the figure charged. A
 * customer surprised by a fee one kobo larger than the screen said is a
 * complaint; one pleasantly surprised by a kobo is not.
 */
export function feeOn(amount: string, basisPoints: number, currency: string): string {
  /*
   * THE SCALE IS THE CURRENCY'S, NOT THE TYPED STRING'S, and that was the
   * difference between `₦0.00` and `₦0`.
   *
   * `formatAmount` renders whatever fraction it is given — it does not impose
   * the currency's own, and it is right not to. So scaling by the number of
   * digits somebody happened to type meant a fee on "5000" came out as a
   * whole number and a fee on "5000.50" came out with two places: the same
   * fee written two ways depending on the keystroke before it.
   *
   * `exponentFor` is the client's own table, and it is PER CURRENCY — two for
   * naira, zero for yen, six for USDT. A hardcoded 2 here would be the
   * mistake the money primitives exist to prevent.
   */
  const scale = exponentFor(currency);
  const [whole = '0', frac = ''] = amount.split('.');
  const typed = BigInt((whole === '' ? '0' : whole) + frac.padEnd(scale, '0').slice(0, scale));
  if (amount === '' || basisPoints <= 0 || typed === 0n) {
    return scale === 0 ? '0' : `0.${'0'.repeat(scale)}`;
  }
  const numerator = typed * BigInt(Math.trunc(basisPoints));
  // ROUNDED UP, so the figure shown is never less than the figure charged.
  const rounded = numerator / 10000n + (numerator % 10000n === 0n ? 0n : 1n);
  const text = rounded.toString().padStart(scale + 1, '0');
  return scale === 0 ? text : `${text.slice(0, -scale)}.${text.slice(-scale)}`;
}

