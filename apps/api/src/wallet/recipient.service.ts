import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Pool } from 'pg';
import { DATABASE } from '../tokens.js';
import { handleIn, payLinkTarget } from './pay-link.js';

/**
 * WHO TO PAY, FROM WHATEVER THE CUSTOMER PASTED — in ONE place.
 *
 * IT WAS TWO, AND THE SECOND ONLY KNEW EMAIL ADDRESSES. `wallet.service.ts`
 * grew this resolver as the identifier moved from an email to a handle to a
 * phone number to a checkout slug; `fx.service.ts` kept its own, which had
 * been `WHERE lower(email) = lower($1)` since Phase 10 and was never touched
 * again.
 *
 * A SAME-CURRENCY TRANSFER GOES THROUGH THE FIRST AND A CROSS-CURRENCY ONE
 * GOES THROUGH THE SECOND. So paying a Nigerian by phone worked and paying a
 * Ghanaian by phone — the same screen, the same field, the same typing —
 * answered `recipient_not_found`, because converting currency is what routes
 * a transfer to the remittance path. The account existed. The resolver asked
 * the wrong question, and only on the corridor this product is FOR.
 *
 * There is one now, and both services inject it. A second copy of "who is
 * this" is a second answer, and the copy that drifts is the one on the path
 * nobody tests by hand.
 */
@Injectable()
export class RecipientService {
  constructor(@Inject(DATABASE) private readonly pool: Pool) {}

  /**
   * Who to pay, from whatever the customer pasted.
   *
   * FOUR SHAPES, ONE FIELD. An email, a phone number, an `@handle`, or a whole
   * profile URL copied out of a message — `https://app.xetral.com/pay/olawale`
   * and every variation of it somebody's keyboard produces. The alternative is
   * a second form field the customer has to classify their own input into,
   * which is asking them to do the parsing.
   *
   * The handle is matched against `payable_handles`, which excludes closed
   * accounts and carries no contact detail — so resolving a link cannot be
   * turned into a way to read the address behind it.
   */
  async resolve(raw: string): Promise<{ id: string }> {
    /*
     * A PAYMENT LINK NOW CARRIES A PHONE NUMBER, and a link somebody shared
     * last year still carries a handle.
     *
     * The identifier of an account is the phone number, so
     * `https://app.xetral.com/pay/2348031234567` is what this product
     * generates. Unwrapping the link FIRST is what lets one segment be read
     * two ways: all digits is a number, anything else is a handle from a link
     * already in the world — which must go on paying the same person, because
     * nobody re-reads a link they have already sent.
     */
    const identifier = payLinkTarget(raw);

    /*
     * A CHECKOUT SLUG, WHICH IS WHAT A PAYMENT LINK CARRIES NOW.
     *
     * The link is public and pays whoever it belongs to, so a Xetral customer
     * who pastes a friend's link into Send should pay that friend rather than
     * be told there is no such person. `payable_links` excludes closed
     * accounts and carries no contact detail, which is why the lookup can be
     * this direct — and an unknown slug answers exactly as an unknown email
     * does, so it cannot be walked to learn which links are real.
     *
     * BEFORE the handle branch, because 039's handle shape and a slug overlap:
     * both are lowercase letters and digits. A slug is what this product
     * generates today, so it is the reading that must win.
     */
    if (/^[a-z0-9]{8,32}$/.test(identifier)) {
      const bySlug = await this.pool.query<{ id: string }>(
        `SELECT u.id FROM users u
           JOIN payable_links p ON p.user_uuid = u.uuid
          WHERE p.slug = $1`,
        [identifier],
      );
      const row = bySlug.rows[0];
      if (row !== undefined) return { id: row.id };
      // Falls THROUGH rather than refusing: an eight-character string is also
      // a legal handle, and a link shared before the identifier settled must
      // go on paying the same person.
    }

    const handle = handleIn(identifier);
    if (handle !== undefined) {
      const byHandle = await this.pool.query<{ id: string }>(
        `SELECT u.id FROM users u
           JOIN payable_handles p ON p.user_uuid = u.uuid
          WHERE p.handle = $1`,
        [handle],
      );
      const row = byHandle.rows[0];
      // The SAME refusal as an unknown email. A link that answered differently
      // from an address would say which handles exist.
      if (row === undefined) throw new NotFoundException({ error: 'recipient_not_found' });
      return { id: row.id };
    }

    /*
     * A PHONE NUMBER IN ANY OF THE THREE SHAPES IT GETS TYPED.
     *
     * `users.phone` is E.164 and the match was `phone = $1` — exact — so a
     * sender who typed the number the way they have it saved, with the trunk
     * zero every Nigerian writes, was told there was no such customer. The
     * account existed; the string did not match. That is the one refusal on
     * this screen a customer cannot act on, because nothing tells them the
     * shape is what is wrong.
     *
     * So the identifier is ALSO compared as digits, which makes
     * `+2348031234567` and `2348031234567` one person — a plus somebody
     * dropped, or a share sheet stripped.
     *
     * IT DELIBERATELY DOES NOT MATCH `08031234567`. A national number has no
     * country in it, and the only ways to supply one are to assume the
     * SENDER's — wrong for exactly the cross-border payments this screen
     * exists for — or to match on a suffix, which on a money path can pay a
     * stranger in another country who happens to share the digits. The
     * dialling-code picker in front of the field is what makes the national
     * form work: both apps build E.164 from it through `e164()`, so the
     * customer types the number the way they have it saved and the server
     * still gets one canonical string.
     *
     * The digits are computed rather than stored, so this cannot use an index
     * — but it is guarded by `$2 <> ''`, false for every email address and
     * every handle, so the scan only happens for something shaped like a
     * number at all.
     */
    const digits = identifier.replace(/[^0-9]/g, '').replace(/^0+/, '');
    const result = await this.pool.query<{ id: string; status: string }>(
      `SELECT id, status FROM users
        WHERE lower(email) = lower($1)
           OR phone = $1
           OR ($2 <> '' AND regexp_replace(phone, '[^0-9]', '', 'g') = $2)
        LIMIT 1`,
      [identifier, digits],
    );
    const row = result.rows[0];

    // "No such recipient" and "that recipient is closed" are the same answer.
    // Distinguishing them turns a transfer form into a way to test which phone
    // numbers belong to customers.
    if (row === undefined || row.status === 'closed') {
      throw new NotFoundException({ error: 'recipient_not_found' });
    }
    return { id: row.id };
  }
}
