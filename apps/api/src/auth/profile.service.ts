import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Pool } from 'pg';
import type { ApiConfig } from '../config.js';
import { API_CONFIG, DATABASE } from '../tokens.js';

export interface ProfileView {
  /**
   * The customer's own number in E.164, which is WHO THEY ARE HERE.
   *
   * Null only for an account that predates phone collection. A screen with no
   * number shows nothing to copy rather than an em dash pretending to be one.
   */
  readonly phone: string | null;
  /**
   * The whole thing, ready to paste into a message — or NULL when this
   * deployment has not been told its own address.
   *
   * Nullable rather than a relative path, which is what it used to be:
   * `appBaseUrl ?? ''` produced `/pay/…`, and a screen offering to copy THAT
   * hands the customer a string that cannot be opened by anybody they send it
   * to. A link that looks real and does not work is worse than an absent one,
   * because they find out from whoever failed to pay them.
   *
   * A null here is NOT what a customer sees. Both apps build the link from
   * their own origin when the server has none — see `paymentLink()` in
   * `@xetral/client`. This field is the server's answer, not the product's.
   */
  readonly link: string | null;
}

/**
 * A customer's payment link, built from the ONE identifier this product has.
 *
 * THE IDENTIFIER IS THE PHONE NUMBER. It used to be an `@handle`, minted from
 * the email address and changeable once, and that was a second name for the
 * same person: a customer had a number every screen already knew and a handle
 * they had to be taught, and the Send screen accepted both. Two identifiers
 * for one account is two things to get wrong — a link shared under a handle
 * somebody later changed, a number typed at a screen expecting a handle — for
 * no capability the number does not already have.
 *
 * So there is no minting here any more, and deliberately NO WAY TO CHANGE IT.
 * A number is changed by changing the number on the account, which is a
 * verified action rather than a text box.
 *
 * WHAT THE LINK CARRIES IS ALREADY PUBLIC. A payment link is meant to be
 * posted, and it carries the number somebody would be paid on anyway — the
 * same string they would send in a message asking to be paid. `payable_handles`
 * exists so resolving one cannot leak an email address, and `/pay` still
 * resolves nothing publicly for the same reason.
 */
@Injectable()
export class ProfileService {
  readonly #logger = new Logger(ProfileService.name);

  constructor(
    @Inject(DATABASE) private readonly pool: Pool,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
  ) {}

  async mine(userUuid: string): Promise<ProfileView> {
    const result = await this.pool.query<{ phone: string | null }>(
      `SELECT phone FROM users WHERE uuid = $1`,
      [userUuid],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error('profile requested for a user that does not exist');
    return this.#view(row.phone);
  }

  #view(phone: string | null): ProfileView {
    if (phone === null) return { phone: null, link: null };

    // `appBaseUrl` is the customer-facing origin and is CONFIGURATION, never a
    // request header — the same rule password reset follows. A link built from
    // a `Host` an attacker controls is a payment link pointing at their site,
    // which is worse here than in an email because it is meant to be
    // forwarded. When it is unset the CLIENT fills it in from the origin it is
    // already running on, which no attacker chose either.
    const origin = this.config.appBaseUrl;
    if (origin === undefined) {
      this.#logger.warn(
        'PAYMENT LINKS HAVE NO ADDRESS: APP_BASE_URL is not set, so the API ' +
          'returns no link and each app falls back to its own origin. Set it ' +
          'to the origin a customer browser reaches.',
      );
      return { phone, link: null };
    }
    return { phone, link: paymentLinkFor(origin, phone) };
  }
}

/**
 * The link, in the one place both halves of it can be seen at once.
 *
 * The `+` goes, because a link is pasted into places that treat one as a
 * space — a mail client wrapping a line, a chat app's own linkifier — and a
 * payment link that breaks when it is shared is a payment link that does not
 * work at the only moment it is used. `/pay/2348031234567` is unambiguous
 * without it: an E.164 number with the plus removed is still the whole number,
 * country code first.
 */
export function paymentLinkFor(origin: string, phone: string): string {
  return `${origin.replace(/\/+$/, '')}/pay/${phone.replace(/^\+/, '')}`;
}
