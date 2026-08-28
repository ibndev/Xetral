import { describe, expect, it } from 'vitest';
import { exponentFor, formatAmount, formatMinor, isValidAmount, parseAmount } from './money.js';

describe('formatting without a float', () => {
  it('groups a large naira balance exactly', () => {
    expect(formatAmount('1650250.00', 'NGN')).toBe('₦1,650,250.00');
  });

  it('keeps every digit of an eight-decimal BTC balance', () => {
    // THE case a float loses. 0.12345678 BTC through parseFloat and back is
    // not reliably the same digits, and this is the number a customer reads to
    // decide whether they have been paid.
    expect(formatAmount('0.12345678', 'BTC')).toBe('₿0.12345678');
  });

  it('keeps a balance beyond what a float can represent', () => {
    // 2^53 kobo is about ₦90 trillion — reachable in a currency with a large
    // unit count, and silently rounded the moment it becomes a number.
    expect(formatAmount('99999999999999999.99', 'NGN')).toBe('₦99,999,999,999,999,999.99');
  });

  it('renders a negative amount', () => {
    expect(formatAmount('-5050.00', 'NGN')).toBe('-₦5,050.00');
  });

  it('falls back to a currency code when there is no symbol', () => {
    expect(formatAmount('100.00', 'KES')).toBe('100.00 KES');
  });

  it('handles amounts below one', () => {
    expect(formatAmount('0.50', 'USD')).toBe('$0.50');
  });

  it('refuses something that is not an amount', () => {
    // Rejecting beats rendering NaN into a balance card.
    expect(() => formatAmount('1e5', 'NGN')).toThrow(RangeError);
    expect(() => formatAmount('', 'NGN')).toThrow(RangeError);
    expect(() => formatAmount('abc', 'NGN')).toThrow(RangeError);
  });
});

describe('parseAmount', () => {
  it('splits without arithmetic', () => {
    expect(parseAmount('-1650250.75')).toEqual({
      negative: true,
      whole: '1650250',
      fraction: '75',
    });
  });

  it('handles a whole number', () => {
    expect(parseAmount('42')).toEqual({ negative: false, whole: '42', fraction: '' });
  });
});

describe('validating input before it is sent', () => {
  it('accepts a well-formed naira amount', () => {
    expect(isValidAmount('1500.50', 2)).toBe(true);
  });

  it('rejects more decimals than the currency has', () => {
    // Told by the form, rather than by a 400 from a money-moving endpoint.
    expect(isValidAmount('1500.505', 2)).toBe(false);
    expect(isValidAmount('0.123456789', 8)).toBe(false);
  });

  it('accepts the full precision of USDT and BTC', () => {
    expect(isValidAmount('1.123456', exponentFor('USDT'))).toBe(true);
    expect(isValidAmount('0.12345678', exponentFor('BTC'))).toBe(true);
  });

  it('rejects zero, which moves nothing', () => {
    expect(isValidAmount('0', 2)).toBe(false);
    expect(isValidAmount('0.00', 2)).toBe(false);
  });

  it('rejects a negative amount', () => {
    // A negative transfer is a withdrawal wearing a deposit's clothes.
    expect(isValidAmount('-100.00', 2)).toBe(false);
  });

  it('rejects exponent notation and stray characters', () => {
    expect(isValidAmount('1e3', 2)).toBe(false);
    expect(isValidAmount('1,000.00', 2)).toBe(false);
    expect(isValidAmount('₦100', 2)).toBe(false);
  });

  it('knows JPY has no decimals', () => {
    expect(isValidAmount('100.5', exponentFor('JPY'))).toBe(false);
    expect(isValidAmount('100', exponentFor('JPY'))).toBe(true);
  });
});

describe('formatMinor', () => {
  it('shifts by the currency exponent, not by a hardcoded two', () => {
    expect(formatMinor('500000000', 'NGN')).toBe('₦5,000,000.00');
    expect(formatMinor('105', 'NGN')).toBe('₦1.05');
    expect(formatMinor('1', 'NGN')).toBe('₦0.01');
    expect(formatMinor('0', 'NGN')).toBe('₦0.00');
  });

  it('handles the currencies that would break a hardcoded two', () => {
    // JPY has no minor unit at all, and is in the registry precisely so code
    // assuming two decimals fails here rather than in production.
    // No symbol on the client for a currency it does not offer, so it falls
    // back to a suffixed code — the point here is the absent decimal places.
    expect(formatMinor('1500', 'JPY')).toBe('1,500 JPY');
    expect(formatMinor('1234567', 'USDT')).toBe('₮1.234567');
    expect(formatMinor('100000000', 'BTC')).toBe('₿1.00000000');
  });

  it('keeps a negative sign', () => {
    expect(formatMinor('-1500', 'NGN')).toBe('-₦15.00');
  });

  it('does not go through a float', () => {
    // Past MAX_SAFE_INTEGER, which is where a division would start lying — in
    // the digits somebody reads to file a return.
    expect(formatMinor('9007199254740993123', 'NGN')).toBe('₦90,071,992,547,409,931.23');
  });

  it('refuses anything that is not an integer of minor units', () => {
    // A major-unit string reaching this function would be off by a factor of
    // a hundred and look entirely plausible. Refusing is the only way that
    // mistake is visible.
    expect(() => formatMinor('15.00', 'NGN')).toThrow(RangeError);
    expect(() => formatMinor('', 'NGN')).toThrow(RangeError);
  });
});
