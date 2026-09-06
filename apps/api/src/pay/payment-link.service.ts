import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { Pool } from 'pg';
import { PaystackClient, initializeCheckout, verifyCheckout } from '@xetral/providers';
import { ProviderRejectedError } from '@xetral/providers';
import { assertBalanced, posting } from '@xetral/ledger';
import type { LedgerIntent } from '@xetral/ledger';
import { LedgerService } from '@xetral/ledger';
import { fromMajor, money } from '@xetral/shared';
import type { Currency } from '@xetral/shared';
import { CURRENCIES } from '@xetral/shared';
import { API_CONFIG, DATABASE, LEDGER } from '../tokens.js';
import type { ApiConfig } from '../config.js';
import { ProviderCredentialService } from '../settings/provider-credentials.service.js';
import { paystackSecretKey } from '../app.module.js';

const PROVIDER = 'paystack';

/**
 * THE PAYMENT LINK, AND WHY IT IS A CHECKOUT RATHER THAN A SHORTCUT.
 *
 * `app.xetral.com/pay/<x>` used to hand the identifier to the SEND screen,
 * which is behind a sign-in. So the link a customer was told to share "to
 * accept payment globally" was payable only by somebody who already had a
 * Xetral account with money in it; for everybody else it was a sign-in page.
 * That is a shortcut for existing customers — a real thing, and not the thing
 * the screen promised.
 *
 * A payer here needs no account and no app. They open the link, type an
 * amount, and Paystack renders the methods they have — mobile money, a bank
 * transfer, a card. The money lands in the wallet of the customer whose link
 * it is.
 *
 * THE ROW IS WRITTEN BEFORE THE PAYER LEAVES, and that ordering is the whole
 * security argument. `charge.success` fires for every successful charge on the
 * integration, which is why 044 refuses to credit on the event name alone and
 * demands `channel = 'dedicated_nuban'`. A checkout has no dedicated account,
 * so that test cannot apply — what replaces it is stronger: the reference is
 * OURS and names a row that says which customer and how much. An event whose
 * reference matches no row credits nobody.
 */
@Injectable()
export class PaymentLinkService {
  readonly #logger = new Logger(PaymentLinkService.name);

  constructor(
    @Inject(DATABASE) private readonly pool: Pool,
    @Inject(LEDGER) private readonly ledger: LedgerService,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(ProviderCredentialService)
    private readonly credentials: ProviderCredentialService,
  ) {}

  /**
   * A customer's own slug, minting one if 058's trigger never ran for them.
   *
   * The trigger covers every account created since the migration and the
   * migration backfilled the rest, so this loop is for one case: an account
   * created in the window where eight random slugs collided, which the trigger
   * deliberately gives up on rather than failing a registration.
   */
  async slugFor(userUuid: string): Promise<string | undefined> {
    try {
      const existing = await this.pool.query<{ slug: string }>(
        `SELECT p.slug FROM payment_links p
           JOIN users u ON u.id = p.user_id
          WHERE u.uuid = $1`,
        [userUuid],
      );
      const slug = existing.rows[0]?.slug;
      if (slug !== undefined) return slug;

      const minted = await this.pool.query<{ slug: string }>(
        `INSERT INTO payment_links (user_id, slug)
         SELECT id, substr(replace(gen_random_uuid()::text, '-', ''), 1, 12)
           FROM users WHERE uuid = $1
         ON CONFLICT (user_id) DO NOTHING
         RETURNING slug`,
        [userUuid],
      );
      return minted.rows[0]?.slug;
    } catch (error: unknown) {
      /*
       * A DEPLOYMENT BEHIND 058, and the link is the one thing on the profile
       * that may be missing without taking the rest of it down — the same
       * split `AuthService.#core` makes between what has existed since 002 and
       * what a newer migration added.
       */
      this.#logger.warn(
        `no payment link for ${userUuid}: ${describe(error)}. ` +
          `If this says the table does not exist, apply ` +
          `packages/ledger/sql/058_payment_links.sql.`,
      );
      return undefined;
    }
  }

  /** Who a public link pays. A NAME and a CURRENCY, and deliberately no way
   *  to reach them — see `payable_links` in 058. */
  async payee(slug: string): Promise<{ name: string; currency: string }> {
    const found = await this.pool.query<{ full_name: string | null; currency: string }>(
      `SELECT full_name, currency FROM payable_links WHERE slug = $1`,
      [slug],
    );
    const row = found.rows[0];
    // The SAME refusal for a link that never existed and one whose owner has
    // closed their account. Distinguishing them would say which slugs are
    // real, on a page anybody can open.
    if (row === undefined) throw new NotFoundException({ error: 'link_not_found' });
    return { name: row.full_name ?? 'a Xetral customer', currency: row.currency };
  }

  /**
   * Start a payment. Writes the row, then asks Paystack for a page.
   *
   * THE AMOUNT IS A STRING IN MAJOR UNITS, parsed once by `fromMajor` — the
   * rule every money field on this platform follows. A JSON number has already
   * been through `JSON.parse` by the time anybody looks at it.
   */
  async begin(
    slug: string,
    input: { readonly amount: string; readonly payerEmail: string; readonly payerName?: string },
  ): Promise<{ authorization_url: string; reference: string }> {
    const target = await this.pool.query<{
      link_id: string;
      user_id: string;
      full_name: string | null;
      currency: string;
    }>(
      `SELECT p.id AS link_id, u.id AS user_id, u.full_name, COALESCE(c.currency, 'NGN') AS currency
         FROM payment_links p
         JOIN users u ON u.id = p.user_id
         LEFT JOIN countries c ON c.code = u.country
        WHERE p.slug = $1 AND u.status = 'active'`,
      [slug],
    );
    const payee = target.rows[0];
    if (payee === undefined) throw new NotFoundException({ error: 'link_not_found' });

    const currency = payee.currency as Currency;
    if (CURRENCIES[currency] === undefined) {
      // A country row naming a currency the money registry does not know. It
      // cannot be quoted, and refusing beats charging somebody in a unit
      // nothing can hold.
      throw new BadRequestException({ error: 'currency_not_supported' });
    }

    let amount;
    try {
      amount = fromMajor(input.amount, currency);
    } catch {
      throw new BadRequestException({ error: 'invalid_amount' });
    }
    if (amount.amount <= 0n) throw new BadRequestException({ error: 'invalid_amount' });

    /*
     * OUR REFERENCE, and it is a UUID rather than anything about the payee.
     *
     * It travels to Paystack, appears on their dashboard and comes back on
     * every webhook — so anything in it that described the customer would be
     * a customer detail published into somebody else's system for ever.
     */
    const reference = `xetpay-${randomUUID()}`;

    await this.pool.query(
      `INSERT INTO link_payments
         (reference, link_id, user_id, amount_minor, currency, payer_name, payer_email)
       VALUES ($1, $2::bigint, $3::bigint, $4::bigint, $5, $6, $7)`,
      [
        reference,
        payee.link_id,
        payee.user_id,
        amount.amount.toString(),
        currency,
        input.payerName ?? null,
        input.payerEmail,
      ],
    );

    const client = this.#client();
    let session;
    try {
      session = await initializeCheckout(client, {
        payerEmail: input.payerEmail,
        amountMinor: amount.amount,
        currency,
        reference,
        ...(payee.full_name === null ? {} : { payeeName: payee.full_name }),
        ...(this.config.appBaseUrl === undefined
          ? {}
          : { callbackUrl: `${this.config.appBaseUrl}/pay/${slug}?paid=${reference}` }),
      });
    } catch (error: unknown) {
      /*
       * THE ROW STAYS `pending`, and is not deleted.
       *
       * A refusal here is almost always a credential or a currency the
       * integration is not enabled for, and both are an operator's problem —
       * but the row is also the only record that somebody tried to pay this
       * customer. `link_payments` is append-mostly for the same reason
       * `purchases` is: a row that can be removed is evidence that can be
       * removed.
       */
      this.#logger.error(`could not start a payment on ${slug}: ${describe(error)}`);
      throw new ServiceUnavailableException({ error: 'checkout_unavailable' });
    }

    return { authorization_url: session.authorizationUrl, reference: session.reference };
  }

  /**
   * A CUSTOMER TOPPING UP THEIR OWN WALLET, through the same checkout.
   *
   * WHY THIS EXISTS. In Ghana and Kenya money moves through a mobile money
   * wallet, and there is no dedicated account to pay into — so the Add Money
   * screen there offered nothing that could actually add money, and said so.
   * Paystack's mobile money is a CHARGE CHANNEL rather than an account we can
   * issue and watch, and a charge is exactly what this rail already is.
   *
   * SO IT IS THE SAME CODE PATH, deliberately: a customer paying their own
   * link. Every rule the public checkout has — the row written before the
   * payer leaves, the amount that cannot move, the verification before any
   * credit — is a rule this gets for free rather than a second set of
   * assumptions about the ledger. `purchase-outcome.ts` records why two copies
   * of one settlement drift.
   *
   * THE PAYER'S EMAIL IS THEIR OWN. Paystack requires one and sends the
   * receipt there, which is right: the person paying is the person being
   * credited.
   */
  async topUp(
    userUuid: string,
    amount: string,
  ): Promise<{ authorization_url: string; reference: string }> {
    const found = await this.pool.query<{ slug: string; email: string | null }>(
      `SELECT p.slug, u.email
         FROM payment_links p JOIN users u ON u.id = p.user_id
        WHERE u.uuid = $1`,
      [userUuid],
    );
    const row = found.rows[0];
    if (row === undefined || row.email === null) {
      // A deployment behind 058, or an account with no address. Both are an
      // outage from the customer's side rather than something they typed
      // wrongly, so neither is a 400.
      throw new ServiceUnavailableException({ error: 'checkout_unavailable' });
    }

    return this.begin(row.slug, { amount, payerEmail: row.email });
  }

  /**
   * Credit a payment, from a reference.
   *
   * ONE PATH FOR BOTH CALLERS — the webhook, and the payer coming back from
   * Paystack. Two copies of "how a payment is credited" would be two sets of
   * assumptions about the ledger, and the copy that drifts is the one that
   * runs against money nobody is watching. `purchase-outcome.ts` records the
   * same rule.
   *
   * IT ASKS PAYSTACK RATHER THAN BELIEVING THE CALLER. The webhook is signed
   * and the return is not, so the return alone must never credit anything —
   * and verifying makes the two paths identical, which is what lets the
   * customer see their money the moment the payer comes back instead of
   * whenever the webhook lands.
   */
  async settle(reference: string): Promise<'credited' | 'replayed' | 'pending' | 'failed'> {
    const found = await this.pool.query<{
      id: string;
      user_id: string;
      amount_minor: string;
      currency: string;
      status: string;
    }>(
      `SELECT id, user_id, amount_minor, currency, status
         FROM link_payments WHERE reference = $1`,
      [reference],
    );
    const row = found.rows[0];
    // A reference we never issued. NOT an error to the caller: the webhook
    // handler asks this of every charge event, and most of them are dedicated
    // account credits that belong to 044's path.
    if (row === undefined) return 'pending';
    if (row.status === 'paid') return 'replayed';
    if (row.status === 'abandoned') return 'failed';

    let outcome;
    try {
      outcome = await verifyCheckout(this.#client(), reference);
    } catch (error: unknown) {
      if (error instanceof ProviderRejectedError) return 'pending';
      throw error;
    }

    if (outcome.status === 'failed') {
      await this.pool.query(
        `UPDATE link_payments SET status = 'abandoned' WHERE id = $1::bigint AND status = 'pending'`,
        [row.id],
      );
      return 'failed';
    }
    if (outcome.status !== 'success') return 'pending';

    /*
     * THE AMOUNT PAYSTACK REPORTS MUST BE THE AMOUNT WE ASKED FOR.
     *
     * We fixed it at initialize, so a difference is not a payer choosing to
     * pay less — it is an anomaly, and the two directions are not symmetric:
     * crediting more than was paid is money invented. Refusing leaves the row
     * pending and a person looks, which is the same decision 006 makes about a
     * deposit that blows the ceiling.
     */
    const paid = toMinor(outcome.amount);
    if (paid === undefined || paid !== BigInt(row.amount_minor)) {
      this.#logger.error(
        `payment ${reference} was initialised for ${row.amount_minor} and paid ` +
          `${String(outcome.amount)}; refusing to credit`,
      );
      return 'pending';
    }
    if (outcome.currency.toUpperCase() !== row.currency) {
      this.#logger.error(
        `payment ${reference} was initialised in ${row.currency} and paid in ` +
          `${outcome.currency}; refusing to credit`,
      );
      return 'pending';
    }

    const currency = row.currency as Currency;
    const intent: LedgerIntent = {
      /*
       * KEYED ON OUR REFERENCE, which both callers hold. A webhook redelivery
       * and the payer refreshing their return page produce the same key, and
       * the ledger answers `replayed` to the second — 044's rule about
       * `data.reference`, applied to the reference we generated.
       */
      idempotencyKey: `${PROVIDER}:link:${reference}`,
      kind: 'wallet_funding',
      occurredAt: outcome.paidAt === undefined ? new Date() : new Date(outcome.paidAt),
      description: 'payment received through your link',
      metadata: {
        provider_reference: reference,
        // The channel the payer used — `mobile_money`, `card`, `bank`. Not
        // their name or their address: those belong in `link_payments`, where
        // access is deliberate, rather than in an append-only entry nobody can
        // ever redact.
        ...(outcome.channel === undefined ? {} : { channel: outcome.channel }),
      },
      postings: [
        posting(
          { kind: 'customer_wallet', ownerId: row.user_id, currency },
          money(paid, currency),
        ),
        posting({ kind: 'provider_float', currency }, money(-paid, currency)),
      ],
    };
    assertBalanced(intent);

    const posted = await this.ledger.post(intent);

    await this.pool.query(
      `UPDATE link_payments
          SET status = 'paid', entry_id = $2::bigint, paid_at = now()
        WHERE id = $1::bigint AND status = 'pending'`,
      [row.id, posted.entryId],
    );

    return posted.replayed ? 'replayed' : 'credited';
  }

  #client(): PaystackClient {
    const baseUrl = this.config.paystackBaseUrl;
    if (baseUrl === undefined) {
      // No Paystack at all. Said as an outage rather than a 500, because the
      // fix is a deployment value and the caller is a stranger on a public
      // page who can do nothing about it.
      throw new ServiceUnavailableException({ error: 'checkout_unavailable' });
    }
    return new PaystackClient({
      baseUrl,
      secretKey: paystackSecretKey(this.config, this.credentials),
    });
  }
}

/**
 * Paystack's `amount`, as minor units, or undefined.
 *
 * `unknown` rather than `number` all the way from the schema, because a JSON
 * number past 2^53 has already lost precision by the time anybody looks at
 * it — `parseMicro` records the same rule, and refuses for the same reason.
 * A string is exact and is what their API sends for large values.
 */
function toMinor(value: unknown): bigint | undefined {
  if (typeof value === 'string' && /^[0-9]+$/.test(value)) return BigInt(value);
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
    return BigInt(value);
  }
  return undefined;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
