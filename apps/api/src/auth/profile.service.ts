import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Pool } from 'pg';
import type { ApiConfig } from '../config.js';
import { API_CONFIG, DATABASE } from '../tokens.js';
import { PaymentLinkService } from '../pay/payment-link.service.js';

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
  /**
   * The public segment the link is served under.
   *
   * Returned as well as the whole link, because the apps build their own when
   * `APP_BASE_URL` is unset — a customer asking to be paid must never be handed
   * an operator's problem instead of a link. Null only on a deployment behind
   * 058.
   */
  readonly slug: string | null;
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
    @Inject(PaymentLinkService) private readonly links: PaymentLinkService,
  ) {}

  async mine(userUuid: string): Promise<ProfileView> {
    const result = await this.pool.query<{ phone: string | null }>(
      `SELECT phone FROM users WHERE uuid = $1`,
      [userUuid],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error('profile requested for a user that does not exist');

    /*
     * TWO INDEPENDENT READS, and the number is not what the link is made of
     * any more.
     *
     * The phone is the XETRAL-TO-XETRAL identifier — what another customer
     * types on the Send screen. The link is a public checkout, and its slug is
     * random precisely so the URL a customer posts in public does not publish
     * their phone number to everybody it is forwarded to.
     *
     * So an account with no phone still has a working link, and an account on
     * a database behind 058 still has a working number. Neither can take the
     * other out.
     */
    return this.#view(row.phone, await this.links.slugFor(userUuid));
  }

  #view(phone: string | null, slug: string | undefined): ProfileView {
    if (slug === undefined) return { phone, link: null, slug: null };

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
      return { phone, link: null, slug };
    }
    return { phone, link: paymentLinkFor(origin, slug), slug };
  }
}

/**
 * The link, in the one place both halves of it can be seen at once.
 *
 * THE SEGMENT IS THE SLUG AND NOT THE PHONE NUMBER any more, and that is the
 * decision this function exists to hold. A link is forwarded, indexed and
 * pasted into group chats; a phone number in it is a phone number published to
 * everybody it reaches, for ever, with no way to take it back. A slug can be
 * rotated.
 */
export function paymentLinkFor(origin: string, slug: string): string {
  return `${origin.replace(/\/+$/, '')}/pay/${slug}`;
}
