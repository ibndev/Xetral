import { describe, expect, it } from 'vitest';
import { e164, internationalDigits } from './phone.js';
import { MomoService } from './funding/momo.service.js';

/**
 * THE NUMBER THAT COULD NOT BE PAID.
 *
 * A Ghanaian types `0501234567`, because that is how a number is written in
 * Accra. Flutterwave's transfers API takes `233501234567` and has no idea what
 * a trunk zero is, so a mobile money payout was refused at the rail with a
 * sentence about an invalid account — which reads to the customer as their own
 * number being wrong.
 *
 * Every case here is a spelling somebody actually types.
 */
describe('a national number into the form a rail accepts', () => {
  it('strips the trunk zero and prefixes the country: Ghana', () => {
    expect(internationalDigits('233', '0501234567')).toBe('233501234567');
  });

  it('strips the trunk zero and prefixes the country: Kenya', () => {
    expect(internationalDigits('254', '0712345678')).toBe('254712345678');
  });

  it('takes a number typed without the trunk zero', () => {
    expect(internationalDigits('233', '501234567')).toBe('233501234567');
    expect(internationalDigits('254', '712345678')).toBe('254712345678');
  });

  it('leaves an already-international number alone rather than prefixing it twice', () => {
    /*
     * THE CASE THAT MATTERS IN THE DIRECTION MONEY LEAVES. Blindly prefixing
     * turns a pasted `+233501234567` into `233233501234567` — a number
     * belonging to nobody, on a payout that cannot be recalled.
     */
    expect(internationalDigits('233', '+233501234567')).toBe('233501234567');
    expect(internationalDigits('233', '233501234567')).toBe('233501234567');
    expect(internationalDigits('254', '254712345678')).toBe('254712345678');
  });

  it('ignores spaces, dashes and brackets, which is how people write numbers', () => {
    expect(internationalDigits('233', '024 412 3456')).toBe('233244123456');
    expect(internationalDigits('234', '0803-123-4567')).toBe('2348031234567');
  });

  it('refuses rather than guessing when it cannot build one', () => {
    // A number this cannot normalise must be REFUSED, never sent as typed:
    // "we sent it to whatever you wrote" is not a recovery story.
    expect(internationalDigits('233', '')).toBeUndefined();
    expect(internationalDigits('', '0501234567')).toBeUndefined();
    expect(internationalDigits('233', '12')).toBeUndefined();
    expect(internationalDigits('233', '01234567890123456789')).toBeUndefined();
  });

  it('is the same number with and without the plus', () => {
    /*
     * ONE DIFFERENCE, ONE CHARACTER. `bank_payouts.account_number` is CHECKed
     * digits-only and Flutterwave's wire format is digits; a stored number is
     * E.164. Neither is a preference — each is what its destination accepts.
     */
    expect(e164('233', '0501234567')).toBe('+233501234567');
    expect(e164('233', '0501234567')).toBe(`+${internationalDigits('233', '0501234567')!}`);
  });

  it('is the ONE definition, and the momo service uses it', () => {
    /*
     * THREE PLACES NEEDED TO AGREE AND ONLY TWO DID. Registration and
     * `MomoService` both normalised; a mobile money PAYOUT sent whatever was
     * typed. That is the two-definitions-of-one-question shape this codebase
     * keeps recording — the two recipient resolvers, the two beneficiary
     * lookups — so this asserts the delegation rather than the duplication.
     */
    for (const typed of ['0501234567', '501234567', '+233501234567']) {
      expect(MomoService.e164('233', typed)).toBe(e164('233', typed));
    }
  });
});
