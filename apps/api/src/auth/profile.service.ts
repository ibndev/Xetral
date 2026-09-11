import { ConflictException, ForbiddenException, Inject, Injectable, Logger } from '@nestjs/common';
import type { Pool } from 'pg';
import type { ApiConfig } from '../config.js';
import { API_CONFIG, DATABASE } from '../tokens.js';
import { PaymentLinkService } from '../pay/payment-link.service.js';
import { CountriesService } from '../countries/countries.service.js';

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
 * What the customer's own account holds, on the one screen that shows it back
 * to them.
 *
 * SEPARATE FROM `ProfileView` DELIBERATELY. That one is the payment link and
 * is read by the Add Money screen; this is the account itself. Collapsing them
 * would put the email address on every response that renders a link — and the
 * whole argument for `payable_links` carrying a name and NOT an email is that
 * a link resolver must not become a harvester.
 */
export interface AccountDetails {
  /**
   * What somebody typed about themselves. NOT the verified name — 040 keeps
   * `users.full_name` and `kyc_submissions.full_name` apart precisely so this
   * one can be personal on day one while only the reviewed one informs a money
   * decision. It is also what a payer reads on a checkout page, which
   * `058_payment_links.sql` calls "a greeting on a checkout page".
   *
   * Null on an account that predates the column, which is exactly the "missing
   * info" this screen exists to let somebody fill in.
   */
  readonly full_name: string | null;
  /**
   * The login identifier. READ ONLY here: `users_email_unique` is what refuses
   * a duplicate account, and an endpoint that could move an address between
   * accounts is an account-takeover primitive with a text box in front of it.
   */
  readonly email: string | null;
  /**
   * The Xetral-to-Xetral identifier, in E.164. READ ONLY for the reason the
   * handle was removed: a number is changed by changing the number on the
   * account, which is a verified action rather than a text box. Every per
   * customer control assumes one person is one number.
   */
  readonly phone: string | null;
  /** ISO-3166 alpha-2, or null on an account created before 040. */
  readonly country: string | null;
  /** What that country is called, for a screen rather than for a decision. */
  readonly country_name: string | null;
  /** When the account was opened. */
  readonly created_at: string;
  /**
   * 0 registered, 1 KYC approved, 2 enhanced. Shown because the ceiling in
   * force is the LOWER of the tier's and the flow's, and a customer refused
   * with no way to learn what would change is a support ticket.
   */
  readonly kyc_tier: number;
  /**
   * Whether a person has read this customer's documents.
   *
   * IT IS WHAT DECIDES EDITABILITY, and in the direction that may look
   * backwards: a VERIFIED customer may change nothing here. What a reviewer
   * read off a document is the record, and letting the subject of that record
   * retype their own name or number afterwards would make the verification a
   * claim about a moment rather than about the account — the same reason
   * `kyc_submissions.full_name` and `users.full_name` are separate columns.
   *
   * An UNVERIFIED customer may fill in what is missing and correct what is
   * wrong. They are tier 0, capped, and nothing has been attested about them
   * yet, so there is nothing for an edit to contradict.
   */
  readonly kyc_verified: boolean;
  /**
   * What this customer may change, named rather than implied.
   *
   * The screen draws itself from this instead of re-deriving the rule, so a
   * field the server will refuse is never presented as editable — and the
   * refusal stays the control either way.
   */
  readonly editable: readonly ('full_name' | 'phone' | 'country')[];
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
    @Inject(CountriesService) private readonly countries: CountriesService,
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

  /**
   * The account, for the customer's own settings screen.
   *
   * ONE QUERY OVER `users` AND A LEFT JOIN, and the join is to `countries`
   * which arrives in 040. That is the join that took the session read down —
   * `describeSession` read `u.country` and joined `countries` in the query
   * that also read the name and the phone, so a database behind 040 returned
   * EVERY FIELD AS NULL and greeted the customer as "there". Here the join is
   * LEFT and this method serves a screen rather than a session, so a missing
   * country costs the country row and nothing else.
   */
  async details(userUuid: string): Promise<AccountDetails> {
    const result = await this.pool.query<{
      full_name: string | null;
      email: string | null;
      phone: string | null;
      country: string | null;
      country_name: string | null;
      created_at: Date;
      kyc_tier: number;
      kyc_approved: boolean;
    }>(
      `SELECT u.full_name,
              u.email,
              u.phone,
              u.country,
              c.name AS country_name,
              u.created_at,
              u.kyc_tier,
              EXISTS (
                SELECT 1 FROM kyc_submissions k
                 WHERE k.user_id = u.id AND k.status = 'approved'
              ) AS kyc_approved
         FROM users u
         LEFT JOIN countries c ON c.code = u.country
        WHERE u.uuid = $1`,
      [userUuid],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error('profile requested for a user that does not exist');

    /*
     * EITHER SIGNAL COUNTS AS VERIFIED, and reading both is deliberate.
     *
     * 029 raises `kyc_tier` to 1 in the SAME transaction that approves a
     * submission, so the two normally agree. They can disagree in one
     * direction that matters: an administrator may raise a tier for a customer
     * whose source of funds was established off-platform. Treating the higher
     * tier as verified is the SAFE reading here, because the consequence of
     * being wrong is a locked field rather than an editable record somebody
     * has attested to.
     */
    const verified = row.kyc_approved || Number(row.kyc_tier) >= 1;

    return {
      full_name: row.full_name,
      email: row.email,
      phone: row.phone,
      country: row.country,
      country_name: row.country_name,
      created_at: row.created_at.toISOString(),
      kyc_tier: Number(row.kyc_tier),
      kyc_verified: verified,
      editable: verified ? [] : ['full_name', 'phone', 'country'],
    };
  }

  /**
   * Changes the name the customer is greeted by, and nothing else.
   *
   * NO TRANSACTION PIN, and that follows the rule rather than relaxing it. A
   * PIN authorises money leaving a customer's own account; this moves nothing,
   * and 018 makes the same call about raising a dispute and 033 about
   * withdrawing consent. What it changes is a greeting — on the home screen and
   * on a checkout page, both of which have said `users.full_name` since 040 and
   * neither of which may inform a money decision. The name a reviewer read off
   * a document is `kyc_submissions.full_name` and is untouched by this.
   *
   * THE SHAPE IS THE DATABASE'S. `users_full_name_check` demands 2..120
   * characters after trimming, so the request schema states the same bounds and
   * the CHECK is what actually holds — a rule enforced only in application code
   * is a rule that holds until the first 3am manual fix.
   */
  async update(
    userUuid: string,
    input: { full_name?: string | undefined; phone?: string | undefined; country?: string | undefined },
  ): Promise<AccountDetails> {
    const current = await this.details(userUuid);

    /*
     * A VERIFIED CUSTOMER CHANGES NOTHING HERE, and the refusal is the
     * control — the screen hiding the fields is only a courtesy.
     *
     * What a reviewer read off a document is the record. Letting its subject
     * retype their own name or number afterwards would make the verification
     * a claim about a moment rather than about the account, and the name a
     * money decision may read would no longer be the name anybody checked.
     * Changing either is a re-verification, which is a person's job.
     */
    if (current.kyc_verified) {
      throw new ForbiddenException({ error: 'profile_locked' });
    }

    /*
     * THE COUNTRY IS RESOLVED FIRST, because it is what gives a national
     * number its dialling code. A customer correcting both in one save must
     * get the NEW country's code on the new number rather than the old one's
     * — doing the phone first would write a number belonging to a country
     * they are in the act of leaving.
     */
    const countryCode = input.country ?? current.country;
    if (input.country !== undefined && input.country !== current.country) {
      // `requireOpen`, so a country this platform does not serve is refused
      // with the same answer signup gives — a profile form must not become a
      // way to read the roadmap either.
      await this.countries.requireOpen(input.country);
    }

    let phone: string | undefined;
    if (input.phone !== undefined) {
      if (countryCode === null) {
        /*
         * A NATIONAL NUMBER WITH NO COUNTRY CANNOT BE NORMALISED, and
         * guessing is the one thing that must not happen: assuming the
         * platform default would write a Nigerian number for a Ghanaian and
         * `users_phone_unique` would then hold a string nobody can be reached
         * on.
         */
        throw new ConflictException({ error: 'country_required' });
      }
      const country = await this.countries.requireOpen(countryCode);
      /*
       * THE SAME NORMALISATION REGISTRATION DOES, deliberately identical: the
       * trunk zero is a domestic dialling convention rather than part of the
       * number, and `users_phone_unique` is a plain unique index on text that
       * cannot see that three spellings are one person.
       */
      phone = `+${country.dial_code}${input.phone.replace(/^0+/, '')}`;
    }

    try {
      const result = await this.pool.query<{ id: string }>(
        `UPDATE users
            SET full_name = COALESCE($2, full_name),
                phone     = COALESCE($3, phone),
                country   = COALESCE($4::char(2), country)
          WHERE uuid = $1
          RETURNING id`,
        [
          userUuid,
          input.full_name?.trim() ?? null,
          phone ?? null,
          input.country ?? null,
        ],
      );
      if (result.rowCount === 0) {
        throw new Error('profile update for a user that does not exist');
      }
    } catch (error: unknown) {
      /*
       * ONE NUMBER, ONE ACCOUNT. Every per-customer control — the daily
       * ceiling, the new-recipient count, the hourly velocity, 025's BVN
       * uniqueness — assumes a person cannot become several customers, and
       * this index is part of what holds that.
       *
       * The refusal says the number is taken and deliberately not by whom.
       */
      const detail = error instanceof Error ? error.message : String(error);
      if (detail.includes('users_phone_unique')) {
        throw new ConflictException({ error: 'phone_taken' });
      }
      throw error;
    }

    this.#logger.log(`profile updated for an unverified customer`);
    return this.details(userUuid);
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
