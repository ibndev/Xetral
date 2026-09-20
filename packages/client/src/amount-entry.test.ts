import { describe, expect, it } from 'vitest';
import { feeOn, groupTyped, PAD, pressKey } from './amount-entry.js';

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
