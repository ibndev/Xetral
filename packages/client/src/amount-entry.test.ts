import { describe, expect, it } from 'vitest';
import { exceedsBalance, feeOn, figureOf, groupTyped, PAD, pressKey, typedAmount } from './amount-entry.js';
import { formatAmount } from './money.js';
import { recipientMatches } from './recipient-search.js';

/**
 * THE KEYPAD TOUCHES MONEY, so it is tested like money.
 *
 * Every function here takes a string and returns a string. There is no
 * `Number` and no `parseFloat` anywhere in the module, and these assertions
 * are what keeps it that way: each one is a value a float would round.
 */
describe('what a key press does to the amount', () => {
  it('appends, deletes and strips a leading zero', () => {
    expect(pressKey('', '5')).toBe('5');
    expect(pressKey('0', '5')).toBe('5');
    expect(pressKey('5', '000')).toBe('5000');
    expect(pressKey('5000', '<')).toBe('500');
    expect(pressKey('', '<')).toBe('');
  });

  it('still refuses `000` on an empty box, for a pad that carries one', () => {
    // Not on this pad any more, but the rule stays: `000` alone is not an
    // amount, and a caller that reintroduces the key gets the behaviour.
    expect(pressKey('', '000')).toBe('');
  });

  it('caps the DIGITS rather than the length, so a decimal point costs none', () => {
    const twelve = '123456789012';
    expect(pressKey(twelve, '3')).toBe(twelve);
    // Eleven digits and a point is eleven digits: the point may still take a
    // twelfth.
    expect(pressKey('1234567890.1', '2')).toBe('1234567890.12');
  });

  it('allows one decimal point and refuses a second', () => {
    expect(pressKey('5', '.')).toBe('5.');
    expect(pressKey('5.', '2')).toBe('5.2');
    expect(pressKey('5.2', '.')).toBe('5.2');
    // A LEADING POINT BECOMES `0.`: an amount that starts with a separator is
    // not one, and every validator downstream would reject it after the
    // customer had finished typing.
    expect(pressKey('', '.')).toBe('0.');
  });
});

describe('the figure as it is read', () => {
  it('groups the integer part and leaves the decimals alone', () => {
    expect(groupTyped('5000')).toBe('5,000');
    expect(groupTyped('1234567')).toBe('1,234,567');
    expect(groupTyped('5000.5')).toBe('5,000.5');
    // Mid-keystroke: a trailing point survives, because the person is still
    // typing and `formatAmount` would have turned "5" into "5.00" already.
    expect(groupTyped('5000.')).toBe('5,000.');
  });

  it('handles the empty and single-digit cases without inventing a comma', () => {
    expect(groupTyped('')).toBe('');
    expect(groupTyped('7')).toBe('7');
    expect(groupTyped('999')).toBe('999');
    expect(groupTyped('1000')).toBe('1,000');
  });
});

describe('the fee', () => {
  it('is scaled by the CURRENCY, not by what was typed', () => {
    // The same fee on the same amount, written two ways, must come out the
    // same — which is what scaling by the typed string got wrong.
    expect(feeOn('5000', 150, 'NGN')).toBe(feeOn('5000.00', 150, 'NGN'));
    expect(feeOn('5000', 150, 'NGN')).toBe('75.00');
  });

  it('rounds UP, so the figure shown is never less than the figure charged', () => {
    // 100.01 * 1bp = 0.010001 -> 0.02 at two places.
    expect(feeOn('100.01', 1, 'NGN')).toBe('0.02');
  });

  it('gives a zero the currency its own decimals', () => {
    expect(feeOn('5000', 0, 'NGN')).toBe('0.00');
    expect(feeOn('', 150, 'NGN')).toBe('0.00');
    expect(feeOn('0', 150, 'NGN')).toBe('0.00');
    // JPY has none, and a hardcoded 2 here would be the mistake the money
    // primitives exist to prevent.
    expect(feeOn('5000', 0, 'JPY')).toBe('0');
    // USDT has six.
    expect(feeOn('0', 150, 'USDT')).toBe('0.000000');
  });

  it('survives an amount past what a float can hold', () => {
    // 2^53 is 9,007,199,254,740,992. A float would round this; a bigint does
    // not — and this is the figure a customer would be charged on.
    expect(feeOn('90071992547409.94', 100, 'NGN')).toBe('900719925474.10');
  });
});

describe('the pad', () => {
  it('is nine digits, then a point, zero and delete', () => {
    /*
     * THE COMP PUTS `000` WHERE THE POINT IS, and that is the one deliberate
     * departure. `000` is a convenience worth three taps in naira; a point is
     * the only way to type $10.50 — and on the phone the keypad REPLACED the
     * text input, so without it that amount cannot be entered at all.
     */
    expect(PAD.length).toBe(12);
    expect(PAD.slice(9)).toEqual(['.', '0', '<']);
  });
});

describe('the UI audit (round 44)', () => {
  it('a typed comma costs nothing rather than throwing during render', () => {
    // BigInt("1,00000") threw a SyntaxError inside the Send screen's render.
    expect(() => feeOn('1,000', 150, 'NGN')).not.toThrow();
    expect(feeOn('1,000', 150, 'NGN')).toBe('0.00');
    expect(feeOn('abc', 150, 'NGN')).toBe('0.00');
  });

  it('the keypad refuses more decimals than the currency has', () => {
    expect(pressKey('5.12', '3', 2)).toBe('5.12');
    expect(pressKey('5.1', '2', 2)).toBe('5.12');
    expect(pressKey('0.12345', '6', 6)).toBe('0.123456');
    expect(pressKey('7', '.', 0)).toBe('7');
    // Without an exponent the old behaviour stands.
    expect(pressKey('5.12', '3')).toBe('5.123');
  });

  it('cleans a free-typed amount the way the keypad would have built it', () => {
    expect(typedAmount('1,000', 2)).toBe('1000');
    expect(typedAmount('₦5000.567', 2)).toBe('5000.56');
    expect(typedAmount('1.2.3', 2)).toBe('1.23');
    expect(typedAmount('.5', 2)).toBe('0.5');
    expect(typedAmount('12.5', 0)).toBe('12');
    expect(typedAmount('007', 2)).toBe('7');
  });

  it('says an amount exceeds the balance only when it does', () => {
    expect(exceedsBalance('5000.01', '5000.00', 'NGN')).toBe(true);
    expect(exceedsBalance('5000', '5000.00', 'NGN')).toBe(false);
    // Malformed or mid-keystroke amounts are not a claim either way.
    expect(exceedsBalance('5.', '10.00', 'NGN')).toBe(false);
    expect(exceedsBalance('5.123', '1000.00', 'NGN')).toBeUndefined();
    expect(exceedsBalance('5', undefined, 'NGN')).toBeUndefined();
    // Per-currency exponents: 1.0000001 USDT has seven decimals, not a claim.
    expect(exceedsBalance('2.5', '2.500000', 'USDT')).toBe(false);
    expect(exceedsBalance('2.500001', '2.500000', 'USDT')).toBe(true);
  });

  it('a name search matches by name, not every recipient', () => {
    const ola = { display_name: 'Olawale Adeyemi', destination: '08031234567', rail_name: 'MTN' };
    const kofi = { display_name: 'Kofi Mensah', destination: '233244123456', rail_name: 'Telecel' };
    // "zzz" stripped to digits was "", and every destination contains "".
    expect(recipientMatches(ola, 'zzz')).toBe(false);
    expect(recipientMatches(kofi, 'ola')).toBe(false);
    expect(recipientMatches(ola, 'ola')).toBe(true);
    expect(recipientMatches(kofi, '2441')).toBe(true);
    expect(recipientMatches(kofi, 'telecel')).toBe(true);
    expect(recipientMatches(ola, '')).toBe(true);
  });

  it('a half-typed amount can be drawn — "." on the keypad crashed the Send screen', () => {
    // The receives line called formatAmount on the box: "5." threw in render.
    expect(() => formatAmount('5.', 'NGN')).toThrow();
    expect(formatAmount(figureOf('5.'), 'NGN')).toBe('₦5');
    expect(figureOf('0.')).toBe('0');
    expect(figureOf('')).toBe('0');
    expect(figureOf('12.50')).toBe('12.50');
  });
});
