import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * SENDING TO A MOBILE MONEY WALLET, which was broken in Accra and Nairobi for
 * three rounds of reports and twice looked like a provider fault.
 *
 * IT WAS NEVER THE API, and it was not one bug either. Two of them, stacked:
 *
 *   1. The ADAPTER refused before it called anything. It matched the network
 *      code and threw `name_unavailable` on the reasoning that a wallet has no
 *      name enquiry — which is true of Kenya's M-PESA and FALSE of Ghana,
 *      whose numbers `/v3/accounts/resolve` resolves. Our own invented
 *      refusal, relayed faithfully by every layer above it.
 *   2. The SCREEN displayed that refusal, enabled its button for it, and then
 *      the submit handler — written earlier and never revisited — still
 *      required a beneficiary name:
 *
 *          if (destination === 'bank' && beneficiary === undefined) return;
 *
 *      So the control enabled, the customer pressed it, and nothing happened.
 *      A button that looks live and does nothing reads to a customer as "it
 *      cannot find the number", which is what was reported, about numbers that
 *      were perfectly correct.
 *
 * The Send screen is one flow now and the tabs are gone, so the shape has
 * changed. What has NOT changed is what must hold, and this checks exactly
 * that, in both apps:
 *
 *   - ONE definition of whether enough has been typed to ask the rail, read by
 *     the lookup AND by the button. Two definitions is what did it.
 *   - A floor PER RAIL, nine digits on a wallet, because a Ghanaian MTN number
 *     and a Kenyan Safaricom number are nine national digits.
 *   - A rail that cannot name its holder never DISABLES the way forward. It
 *     asks for a label instead, which is a different screen rather than a dead
 *     end.
 */
const HERE = new URL('.', import.meta.url).pathname;
const web = readFileSync(`${HERE}/page.tsx`, 'utf8');
const mobile = readFileSync(`${HERE}/../../../../mobile/app/transfer.tsx`, 'utf8');

/** Both apps, so neither can be fixed alone. The old version read the web for
 *  two of its three checks and the phone for one, which is how the phone's
 *  copy of a condition came to be the one that drifted. */
const APPS: readonly (readonly [string, string])[] = [
  ['web', web],
  ['mobile', mobile],
];

describe('a mobile money send can actually be submitted', () => {
  it('asks ONE question about whether there is enough to look up', () => {
    for (const [name, source] of APPS) {
      expect(source, name).toContain('const enough = destination.replace(/[^0-9]/g, \'\').length >= minimumDigits;');
      // The lookup, the button and the declaration. If either the guard or the
      // control grows its own copy of the condition again, this count moves.
      const uses = source.split('enough').length - 1;
      expect(uses, `${name} reads \`enough\` in at least three places`).toBeGreaterThanOrEqual(3);
    }
  });

  it('NEVER re-derives that condition inline', () => {
    for (const [name, source] of APPS) {
      // The exact expressions that were the bug, in either of its two forms.
      expect(source, name).not.toContain('beneficiary === undefined && !nameUnavailable');
      expect(source, name).not.toMatch(/destination === 'bank' && beneficiary === undefined/);
    }
  });

  it('does not demand ten digits on a rail whose numbers are nine', () => {
    for (const [name, source] of APPS) {
      expect(source, name).toContain('const minimumDigits = mobileMoney ? 9 : 10;');
      // A bare ten anywhere near the destination is the fault coming back.
      expect(source, name).not.toContain('.length < 10');
      expect(source, name).not.toContain('.length >= 10');
    }
  });

  it('never gates a momo send on a name it cannot get', () => {
    /*
     * THE FOURTH ROUND, AND THE REASON THIS ASSERTION INVERTED.
     *
     * Earlier the screen collected a LABEL when the rail could not name the
     * holder, which unblocked Kenya but still made the momo send a two-step,
     * name-gated flow — and the resolve path it leaned on was STRICTER than the
     * send path, so a Ghanaian wallet whose /v3/accounts/resolve answered
     * `account_not_found` was refused a send the very next layer would have
     * completed. The mockup's momo screen has no name and no label: country,
     * network, number, go.
     *
     * So the invariant is now the OPPOSITE of a label gate — momo must NOT be
     * gated on `resolved_name` at all. The old `ready` expression and the
     * label field are gone in both apps, and their return is the regression.
     */
    for (const [name, source] of APPS) {
      expect(source, name).not.toContain('label.trim().length >= 2');
      expect(source, name).not.toContain('Name this recipient');
      // Momo proceeds in one tap: the submit resolves and goes straight on.
      expect(source, name).toMatch(/kind === 'momo'[\s\S]{0,80}proceed\(/);
    }
  });

  it('never shows the SENDER\'s own words as the account name', () => {
    /*
     * 043's rule: a confirmation screen showing a name the sender typed
     * confirms nothing while looking exactly like one. The "Account name" panel
     * renders `resolved_name` — the rail's own answer — or is not drawn at all,
     * and a wallet with no name enquiry shows no such panel rather than echoing
     * the number back as if it were a name.
     */
    for (const [name, source] of APPS) {
      expect(source, name).toContain('resolved_name');
      expect(source, name).not.toMatch(/Account name[\s\S]{0,400}\{label\}/);
    }
  });
});
