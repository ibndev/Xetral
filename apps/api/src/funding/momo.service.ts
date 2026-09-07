import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { Pool } from 'pg';
import { DATABASE } from '../tokens.js';
import { isMissingSchema, reportMissingSchema } from '../database-schema.js';

/** What a screen is told about a linked wallet. */
export interface MomoAccountView {
  readonly uuid: string;
  readonly network: string;
  readonly msisdn: string;
  readonly currency: string;
  readonly status: string;
  readonly verified_at: string | null;
}

/**
 * THE MOBILE MONEY NUMBER A CUSTOMER LINKS TO THEIR WALLET.
 *
 * WHY THIS EXISTS. Add Money in Accra and Nairobi asked for an AMOUNT — a
 * one-off charge that leaves nothing behind — while the Send screen asked for
 * a wallet number again every time, and nothing on the account recorded which
 * number belongs to this customer at all. A linked number is the shape the
 * product actually needs: one wallet that both funds and receives.
 *
 * WHAT IT DELIBERATELY DOES NOT DO IS ASK THE PROVIDER WHO OWNS IT. 043
 * already records that a mobile money wallet has no name enquiry on any of
 * these rails — `name_unavailable` is its own refusal — and the one thing an
 * adapter must never do is echo back the number the sender typed, which
 * confirms nothing while looking exactly like a confirmation. So a number is
 * CLAIMED here and becomes VERIFIED when money actually arrives from it, which
 * is a fact rather than an assertion.
 *
 * NIGERIA NEVER REACHES THIS. `countries.funding_methods` is
 * `{virtual_account}` there, that rail works, and none of this touches it.
 */
@Injectable()
export class MomoService {
  readonly #logger = new Logger(MomoService.name);

  constructor(@Inject(DATABASE) private readonly pool: Pool) {}

  /** The customer's live linked wallet, or nothing. */
  async linked(userUuid: string): Promise<MomoAccountView | undefined> {
    try {
      const found = await this.pool.query<MomoAccountView>(
        `SELECT m.uuid, m.network, m.msisdn, m.currency, m.status, m.verified_at
           FROM linked_momo_accounts m
           JOIN users u ON u.id = m.user_id
          WHERE u.uuid = $1::uuid`,
        [userUuid],
      );
      return found.rows[0];
    } catch (error) {
      if (isMissingSchema(error)) {
        // A deployment behind 063. The screen shows the link form rather than
        // failing, which is the state it is genuinely in.
        reportMissingSchema(this.#logger, error, 'reading a linked mobile money number');
        return undefined;
      }
      throw error;
    }
  }

  /**
   * Links a wallet.
   *
   * THE NUMBER IS NORMALISED SERVER-SIDE, from the dialling code on the
   * customer's own country row and the national digits they typed. 040's
   * argument: `momo_one_customer_per_number` is a plain unique index on text
   * and cannot see that `+233244123456`, `233244123456` and `0244123456` are
   * one wallet — and every per-customer control assumes one person cannot
   * become several.
   *
   * THE NETWORK IS CHECKED AGAINST WHAT THE RAIL ACTUALLY ACCEPTS rather than
   * stored as typed. A code no adapter recognises is a payout that fails at
   * the provider, weeks later, with the customer's money already reserved.
   */
  async link(
    userUuid: string,
    input: { readonly network: string; readonly number: string },
  ): Promise<MomoAccountView> {
    const who = await this.#placement(userUuid);

    /*
     * REFUSED WHERE THE COUNTRY DOES NOT MOVE MONEY THIS WAY, before a row
     * exists. 051 put `funding_methods` on the country precisely so a screen
     * would stop offering a product the customer's money cannot reach; this is
     * the server half of that, because anything a client can send a stolen
     * session can send.
     */
    if (!who.funding_methods.includes('mobile_money')) {
      throw new UnprocessableEntityException({ error: 'momo_not_supported_here' });
    }

    const network = input.network.trim().toUpperCase();
    if (!/^[A-Z0-9]{2,10}$/.test(network)) {
      throw new BadRequestException({ error: 'invalid_request', fields: ['network'] });
    }

    const msisdn = MomoService.e164(who.dial_code, input.number);
    if (msisdn === undefined) {
      throw new BadRequestException({ error: 'invalid_request', fields: ['number'] });
    }

    try {
      const inserted = await this.pool.query<MomoAccountView>(
        `INSERT INTO momo_accounts (user_id, network, msisdn, currency)
         VALUES ($1::bigint, $2, $3, $4)
         RETURNING uuid, network, msisdn, currency, status, verified_at`,
        [who.user_id, network, msisdn, who.currency],
      );
      const row = inserted.rows[0];
      if (row === undefined) throw new Error('linking a wallet returned no row');
      this.#logger.log(`a ${who.country} customer linked a ${network} wallet`);
      return row;
    } catch (error) {
      if (isMissingSchema(error)) {
        reportMissingSchema(this.#logger, error, 'linking a mobile money number');
        throw new UnprocessableEntityException({ error: 'momo_not_supported_here' });
      }
      if (isUniqueViolation(error)) {
        /*
         * TWO CASES, ONE ANSWER, and that is deliberate. Either this customer
         * already has a live wallet, or somebody else has claimed this number.
         * Telling them apart would turn this endpoint into a way to learn
         * which numbers are registered here, one request at a time — the rule
         * 043 applies to a bank account lookup and 025 to a BVN collision.
         */
        throw new ConflictException({ error: 'momo_already_linked' });
      }
      throw error;
    }
  }

  /**
   * Unlinks it. FINAL, and it frees the customer to link another.
   *
   * Not a delete: the wallet money arrived from and left to is part of the
   * financial record, which is what 019 decides `keep` about. The row stays
   * and stops being live.
   */
  async unlink(userUuid: string): Promise<void> {
    const done = await this.pool.query(
      `UPDATE momo_accounts m
          SET status = 'removed', removed_at = now()
         FROM users u
        WHERE u.id = m.user_id AND u.uuid = $1::uuid AND m.status <> 'removed'`,
      [userUuid],
    );
    if (done.rowCount === 0) throw new NotFoundException({ error: 'not_found' });
  }

  /**
   * Money arrived from this wallet, so its holder authorised the link.
   *
   * THE ONLY PATH TO `verified`, and it is called from a settlement rather
   * than from an endpoint — a request that could mark itself verified would be
   * a request that verifies nothing. Best-effort for the reason a receipt is:
   * the money is already credited, and failing here would take a settled
   * payment down over a status column.
   */
  async noteFundedFrom(userUuid: string, msisdn: string): Promise<void> {
    try {
      await this.pool.query(
        `UPDATE momo_accounts m
            SET status = 'verified', verified_at = now()
           FROM users u
          WHERE u.id = m.user_id AND u.uuid = $1::uuid
            AND m.msisdn = $2 AND m.status = 'claimed'`,
        [userUuid, msisdn],
      );
    } catch (error) {
      this.#logger.warn(`could not mark a wallet verified: ${String(error)}`);
    }
  }

  async #placement(userUuid: string): Promise<{
    user_id: string;
    country: string;
    currency: string;
    dial_code: string;
    funding_methods: readonly string[];
  }> {
    const found = await this.pool.query<{
      user_id: string;
      country: string | null;
      currency: string | null;
      dial_code: string | null;
      funding_methods: string[] | null;
    }>(
      `SELECT u.id AS user_id, u.country, c.currency, c.dial_code, c.funding_methods
         FROM users u LEFT JOIN countries c ON c.code = u.country
        WHERE u.uuid = $1::uuid`,
      [userUuid],
    );
    const row = found.rows[0];
    if (row === undefined) throw new NotFoundException({ error: 'not_found' });
    if (row.currency === null || row.dial_code === null) {
      // No country row means nothing here can say which currency the wallet
      // moves in — and guessing one is finding 72.
      throw new UnprocessableEntityException({ error: 'momo_not_supported_here' });
    }
    return {
      user_id: row.user_id,
      country: row.country ?? '',
      currency: row.currency,
      dial_code: row.dial_code,
      funding_methods: row.funding_methods ?? [],
    };
  }

  /**
   * The country's dialling code and the national digits, with the trunk zero
   * stripped — the same construction registration uses, so one wallet has one
   * spelling wherever it is written down.
   */
  static e164(dialCode: string, national: string): string | undefined {
    const digits = national.replace(/[^0-9]/g, '').replace(/^0+/, '');
    const code = dialCode.replace(/[^0-9]/g, '');
    if (digits.length < 6 || digits.length > 14 || code === '') return undefined;
    return `+${code}${digits}`;
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: string }).code === '23505'
  );
}
