import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * SENDING TO A MOBILE MONEY WALLET, which was broken in Accra and Nairobi for
 * three rounds of reports and twice looked like a provider fault.
 *
 * IT WAS NEVER THE API. The payout port answers `name_unavailable` for a
 * wallet — correctly, and permanently: there is no name enquiry on that rail,
 * which 043 records and 059 repeats. The Send screen displayed that answer and
 * enabled its button for it. And then the SUBMIT HANDLER, written earlier and
 * never revisited, still required a beneficiary name:
 *
 *     if (destination === 'bank' && beneficiary === undefined) return;
 *
 * So the control enabled, the customer pressed it, and nothing happened. A
 * button that looks live and does nothing reads to a customer as "it cannot
 * find the number" — which is what was reported, about a number that was
 * perfectly correct.
 *
 * Two definitions of one question is what did it, so the test is that there is
 * ONE. The same shape as the two recipient resolvers and the two beneficiary
 * lookups.
 */
const HERE = new URL('.', import.meta.url).pathname;
const web = readFileSync(`${HERE}/page.tsx`, 'utf8');
const mobile = readFileSync(`${HERE}/../../../../mobile/app/transfer.tsx`, 'utf8');

describe('a mobile money send can actually be submitted', () => {
  it('asks ONE question about whether the payout side is reviewable', () => {
    expect(web).toContain('const payoutReviewable =');
    // Both the guard and the button read it. If either grows its own copy of
    // the condition again, this count moves.
    const uses = web.split('payoutReviewable').length - 1;
    expect(uses).toBeGreaterThanOrEqual(3);
  });

  it('NEVER re-derives that condition inline', () => {
    // The exact expression that was the bug. Written out in either file, the
    // two can disagree again — and the way they disagree is silent.
    expect(web).not.toContain('beneficiary === undefined && !nameUnavailable');
    expect(web).not.toMatch(/destination === 'bank' && beneficiary === undefined/);
  });

  it('does not demand ten digits on a rail whose numbers are nine', () => {
    /*
     * A Ghanaian MTN number and a Kenyan Safaricom number are nine national
     * digits. A floor of ten meant the lookup never fired for a customer who
     * typed theirs without the trunk zero — so no request was made, no
     * `name_unavailable` came back, and the button stayed disabled with
     * nothing on screen explaining it.
     */
    for (const source of [web, mobile]) {
      expect(source).toContain('const minimumDigits = mobileMoney ? 9 : 10;');
      expect(source).toContain('number.length < minimumDigits');
      expect(source).not.toContain('number.length < 10');
    }
  });
});
