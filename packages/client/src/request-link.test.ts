import { describe, expect, it } from 'vitest';
import { readRequest, requestLinkFor } from './request-link.js';

const LINK = 'https://app.xetral.com/pay/ab12cd34ef';

describe('a request link', () => {
  it('carries the amount, currency and reason, and reads them back', () => {
    const url = requestLinkFor(LINK, { amount: '25000', currency: 'NGN', note: 'Rent for May' });
    expect(url.startsWith(`${LINK}?`)).toBe(true);
    expect(readRequest(new URL(url).searchParams)).toEqual({
      amount: '25000',
      currency: 'NGN',
      note: 'Rent for May',
    });
  });

  it('is the plain link when nothing is asked for', () => {
    expect(requestLinkFor(LINK, {})).toBe(LINK);
  });

  it('drops an amount the currency cannot represent, rather than showing it', () => {
    // Naira has two decimals; a third would open a checkout that then refuses.
    expect(readRequest(new URLSearchParams('amount=100.505&currency=NGN'))).toEqual({ currency: 'NGN' });
    // USDT has six, so the same shape is fine there.
    expect(readRequest(new URLSearchParams('amount=100.505&currency=USDT')).amount).toBe('100.505');
  });

  it('drops an amount with no currency, a currency nobody knows, and zero', () => {
    expect(readRequest(new URLSearchParams('amount=500'))).toEqual({});
    expect(readRequest(new URLSearchParams('amount=500&currency=XYZ'))).toEqual({});
    expect(readRequest(new URLSearchParams('amount=0.00&currency=NGN'))).toEqual({ currency: 'NGN' });
    expect(readRequest(new URLSearchParams('amount=-5&currency=NGN'))).toEqual({ currency: 'NGN' });
  });

  it('bounds the reason and collapses its whitespace', () => {
    const long = 'x'.repeat(400);
    expect(readRequest(new URLSearchParams({ for: long })).note).toHaveLength(140);
    expect(readRequest(new URLSearchParams({ for: '  lunch \n  money ' })).note).toBe('lunch money');
  });
});
