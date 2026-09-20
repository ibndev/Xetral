import { describe, expect, it } from 'vitest';
import { displayPhone, nationalPhone } from './client.js';

/**
 * THE ONE STRING A CUSTOMER READS ALOUD.
 *
 * Request payment shows a customer their own number so they can give it to
 * somebody who is about to pay them. It was grouped in threes from the LEFT,
 * so every 10-digit Nigerian number ended in a single orphan digit —
 * `803 123 456 7` — which is unreadable over a phone call and is what a
 * sender then types wrong.
 */
describe('a phone number as somebody reads it out', () => {
  it('keeps the last four together on a Nigerian number', () => {
    expect(nationalPhone('+2348031234567', '+234')).toBe('803 123 4567');
  });

  it('keeps the last four together on a Ghanaian and a Kenyan number', () => {
    expect(nationalPhone('+233241234567', '+233')).toBe('24 123 4567');
    expect(nationalPhone('+254712345678', '+254')).toBe('71 234 5678');
  });

  it('never produces a group of one digit, at any length', () => {
    /*
     * THE LOOP IS THE POINT, not the three lengths this platform uses today.
     * Checking NG, GH and KE would have passed the version that rendered
     * `1 2345` for a five-digit number — and the orphan is the whole defect,
     * at either end. It found exactly that case on its first run.
     */
    for (let n = 5; n <= 14; n += 1) {
      const digits = '1234567890123'.slice(0, n);
      const groups = nationalPhone(digits).split(' ');
      for (const g of groups) {
        expect(g.length, `${n} digits -> ${groups.join('|')}`).toBeGreaterThan(1);
      }
      // And no digit is lost or invented on the way.
      expect(groups.join(''), `${n} digits`).toBe(digits);
    }
  });

  it('leaves a short number alone rather than inventing a grouping', () => {
    expect(nationalPhone('1234')).toBe('1234');
    expect(nationalPhone('')).toBe('');
  });

  it('still shares the country code, split where the country actually ends', () => {
    // `displayPhone` is the OTHER choice and is for a number handed to
    // somebody who may be abroad: a national number has no country in it.
    expect(displayPhone('+2348031234567', '+234')).toBe('+234 803 123 4567');
    expect(displayPhone('+14165550132', '+1')).toBe('+1 416 555 0132');
    // WITHOUT a code it cannot know where the country ends — +1, +44 and
    // +234 are one, two and three digits — so it groups the digits rather
    // than guessing a split, and is still readable.
    expect(displayPhone('+2348031234567')).toBe('+234 803 123 4567');
  });
});
