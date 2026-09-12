import {
  BadRequestException,
  ConflictException,
  HttpException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { Pool } from 'pg';
import { DATABASE } from '../tokens.js';
import { internationalDigits } from '../phone.js';
import { CountriesService } from '../countries/countries.service.js';
import { PayoutService } from '../payouts/payout.service.js';
import type { CreateRecipientBody, RecipientKind, ResolveRecipientBody } from './dto.js';

/**
 * One row of the customer's own address book.
 *
 * IT CARRIES NO EMAIL AND NO OTHER CONTACT DETAIL. The reason is the one
 * `payable_links` and `payable_handles` both record: a resolver that answers
 * more than "this destination is real and it belongs to this name" is a
 * harvester with a nice URL. This one is read by its owner rather than by the
 * public, which lowers the stakes and does not change the shape.
 */
export interface RecipientView {
  readonly id: string;
  readonly kind: RecipientKind;
  readonly country: string;
  readonly currency: string;
  readonly rail_code: string | null;
  readonly rail_name: string | null;
  /** Digits only, in the form the rail accepts. */
  readonly destination: string;
  /** What the list shows. */
  readonly display_name: string;
  /**
   * What the RAIL said, or null where it has no name enquiry. Only this one
   * may be rendered as a confirmation — `display_name` can be the customer's
   * own words, and a screen that presented those as confirmed would be a
   * confirmation screen confirming nothing.
   */
  readonly resolved_name: string | null;
  readonly last_used_at: string | null;
  readonly created_at: string;
}

/** What a lookup can say about a destination before anything is saved. */
export interface RecipientResolution {
  readonly kind: RecipientKind;
  readonly country: string;
  readonly currency: string;
  readonly rail_code: string | null;
  readonly rail_name: string | null;
  readonly destination: string;
  /**
   * The rail's own answer, or null.
   *
   * NULL IS NOT A FAILURE HERE. On Kenya's M-PESA no name enquiry exists, so
   * the screen asks the customer for a label instead of refusing — which is
   * the difference between a corridor that works and one that shows "we could
   * not find the user name" about a number that is perfectly correct.
   */
  readonly resolved_name: string | null;
}

interface RecipientRow {
  uuid: string;
  kind: RecipientKind;
  country: string;
  currency: string;
  rail_code: string | null;
  rail_name: string | null;
  destination: string;
  display_name: string;
  resolved_name: string | null;
  last_used_at: Date | null;
  created_at: Date;
}

/**
 * THE ADDRESS BOOK BEHIND ONE SEND FLOW.
 *
 * NAMED `RecipientBookService` BECAUSE `RecipientService` IS ALREADY TAKEN,
 * and by something narrower: that one answers "which Xetral customer is this
 * string?" and is what the wallet and the remittance paths share. This one
 * owns the SAVED LIST and spans every rail. Two things called Recipient
 * would be the two-definitions-of-one-question shape this codebase keeps
 * recording, so they are named apart and this one delegates to that one for
 * the case it covers.
 *
 * NO TRANSACTION PIN ON ANY OF THIS, and the reason is where the control
 * actually sits. Adding a beneficiary is the classic first half of a takeover,
 * so the instinct is to gate it — but a saved recipient moves nothing. The
 * send takes a PIN, re-fetches the rail's name on that very request, and the
 * destination on this row is IMMUTABLE by trigger, so a stolen session that
 * adds a recipient has gained a row it still cannot spend through. Asking here
 * as well would be a second, weaker copy of a control that already holds, on
 * the screen a customer uses most.
 */
@Injectable()
export class RecipientBookService {
  readonly #logger = new Logger(RecipientBookService.name);

  constructor(
    @Inject(DATABASE) private readonly pool: Pool,
    @Inject(CountriesService) private readonly countries: CountriesService,
    @Inject(PayoutService) private readonly payouts: PayoutService,
  ) {}

  async list(userUuid: string): Promise<readonly RecipientView[]> {
    const rows = await this.pool.query<RecipientRow>(
      `SELECT r.uuid, r.kind::text AS kind, r.country, r.currency, r.rail_code,
              r.rail_name, r.destination, r.display_name, r.resolved_name,
              r.last_used_at, r.created_at
         FROM recipients r
         JOIN users u ON u.id = r.user_id
        WHERE u.uuid = $1 AND r.removed_at IS NULL
        ORDER BY r.last_used_at DESC NULLS LAST, r.created_at DESC
        LIMIT 200`,
      [userUuid],
    );
    return rows.rows.map(toView);
  }

  /**
   * Who holds this destination, asked of whatever can answer.
   *
   * THIS IS THE CALL THAT WAS NEVER MADE FOR A GHANAIAN WALLET. The payout
   * adapter matched the network code and threw `name_unavailable` without
   * asking — so "it says it cannot find the user name" was our own refusal,
   * relayed correctly by every layer above it, about a number Flutterwave
   * will happily resolve.
   */
  async resolve(userUuid: string, body: ResolveRecipientBody): Promise<RecipientResolution> {
    if (body.kind === 'xetral') {
      return this.#resolveXetral(userUuid, body.destination, body.country);
    }

    const iso = body.country;
    if (iso === undefined || body.rail_code === undefined) {
      throw new BadRequestException({
        error: 'invalid_request',
        fields: iso === undefined ? ['country'] : ['rail_code'],
      });
    }
    const country = await this.countries.byCode(iso);
    if (country === undefined) {
      throw new UnprocessableEntityException({ error: 'country_not_supported' });
    }

    /*
     * A WALLET IS A PHONE NUMBER AND A BANK ACCOUNT IS NOT.
     *
     * The same normalisation the payout path uses, in the same place in the
     * order: before anything reads the destination, so the row, the lookup and
     * the transfer all name the same string. A bank account number is left
     * exactly as typed — a NUBAN has no dialling code and an account beginning
     * with a zero is an ordinary account.
     */
    const destination =
      body.kind === 'momo'
        ? internationalDigits(country.dial_code, body.destination)
        : body.destination.replace(/[^0-9]/g, '');
    if (destination === undefined || !/^[0-9]{6,20}$/.test(destination)) {
      throw new BadRequestException({ error: 'invalid_request', fields: ['destination'] });
    }

    const banks = await this.payouts.banks(iso);
    const rail = banks.find((bank) => bank.code === body.rail_code);
    if (rail === undefined) {
      /*
       * A CODE THIS RAIL DOES NOT OFFER, refused here rather than at the
       * provider. 046's lesson: a selection the customer's money cannot reach
       * fails later as something that reads like their own number being wrong.
       */
      throw new UnprocessableEntityException({ error: 'unsupported_network' });
    }

    /*
     * THE RAIL'S ANSWER, OR NOTHING — and nothing is not a failure.
     *
     * `name_unavailable` means the product has no name enquiry at all, which
     * today is true of M-PESA and false of Ghanaian mobile money. Treating it
     * as a refusal is what stopped the Kenyan corridor; treating every wallet
     * as having it is what stopped the Ghanaian one. Told apart, both work.
     */
    let resolved: string | null = null;
    try {
      const found = await this.payouts.lookupOrRefuse({
        country: iso,
        bank_code: body.rail_code,
        account_number: destination,
      });
      resolved = found.accountName;
    } catch (error: unknown) {
      /*
       * FOR A WALLET, A NAME IS A BONUS AND NEVER A GATE — and this resolve
       * path must not be STRICTER than the send path, which is the bug that
       * kept "it cannot find the momo details" alive across three earlier
       * fixes.
       *
       * `payout.service.#beneficiaryFor` does not look a momo name up AT ALL
       * (`if (destination.mobile_money) return undefined`), so the send would
       * have gone through — but this method, which gates the Continue button,
       * only tolerated `name_unavailable` and RE-THREW everything else. So a
       * Ghanaian wallet whose name enquiry answered `account_not_found`, or a
       * moment when Flutterwave was unreachable, blocked a send that the very
       * next layer would have completed without a name.
       *
       * A momo lookup is therefore best-effort here: on ANY failure the name
       * is simply null and the flow proceeds, exactly as the send path does.
       * Only a BANK rail — where the bank's answer is the one claim about the
       * beneficiary that does not come from the sender (043) — still surfaces
       * a real failure, and even then a rail with no name enquiry is tolerated.
       */
      if (body.kind === 'momo') {
        this.#logger.log(
          `${iso} ${body.rail_code} momo name enquiry did not answer (${describe(error)}); proceeding without a name`,
        );
      } else if (isNameUnavailable(error)) {
        this.#logger.log(`${iso} ${body.rail_code} has no name enquiry; asking for a label instead`);
      } else {
        throw error;
      }
    }

    return {
      kind: body.kind,
      country: iso,
      currency: country.currency,
      rail_code: rail.code,
      rail_name: rail.name,
      destination,
      resolved_name: resolved,
    };
  }

  async create(userUuid: string, body: CreateRecipientBody): Promise<RecipientView> {
    const found = await this.resolve(userUuid, {
      kind: body.kind,
      ...(body.country === undefined ? {} : { country: body.country }),
      ...(body.rail_code === undefined ? {} : { rail_code: body.rail_code }),
      destination: body.destination,
    });

    /*
     * THE RAIL'S NAME WINS, AND THE LABEL IS THE FALLBACK.
     *
     * Where a name was resolved it is what the list shows, because it is the
     * one claim about the destination the customer did not author. Their own
     * label is for the case where nothing can answer — and a recipient with
     * NEITHER is refused rather than saved as a bare number, which is how
     * somebody pays the wrong person out of their own address book.
     */
    const display = found.resolved_name ?? body.label?.trim();
    if (display === undefined || display === '') {
      throw new UnprocessableEntityException({ error: 'recipient_name_required' });
    }

    try {
      const inserted = await this.pool.query<RecipientRow>(
        `INSERT INTO recipients
           (user_id, kind, country, currency, rail_code, rail_name, destination,
            display_name, resolved_name)
         SELECT u.id, $2::recipient_kind, $3, $4, $5, $6, $7, $8, $9
           FROM users u WHERE u.uuid = $1
         RETURNING uuid, kind::text AS kind, country, currency, rail_code, rail_name,
                   destination, display_name, resolved_name, last_used_at, created_at`,
        [
          userUuid,
          found.kind,
          found.country,
          found.currency,
          found.rail_code,
          found.rail_name,
          found.destination,
          display,
          found.resolved_name,
        ],
      );
      const row = inserted.rows[0];
      if (row === undefined) throw new Error('recipient insert returned no row');
      return toView(row);
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      if (detail.includes('recipients_one_live_per_destination')) {
        // Already saved. Not an error worth a red banner — the customer wanted
        // this destination in their list and it is in their list.
        const existing = await this.#byDestination(userUuid, found);
        if (existing !== undefined) return existing;
        throw new ConflictException({ error: 'recipient_exists' });
      }
      throw error;
    }
  }

  /**
   * Removing one, which is a column rather than a DELETE.
   *
   * A payout names its destination, and an operator reading a complaint months
   * later needs to see the recipient the customer was looking at. A row a
   * customer can erase is evidence a customer can erase — 018's argument about
   * a dispute, one table over.
   */
  async remove(userUuid: string, id: string): Promise<void> {
    const done = await this.pool.query(
      `UPDATE recipients r
          SET removed_at = now()
         FROM users u
        WHERE u.id = r.user_id AND u.uuid = $1 AND r.uuid = $2 AND r.removed_at IS NULL`,
      [userUuid, id],
    );
    if (done.rowCount === 0) {
      // THE SAME 404 for "not yours" and "no such row", which is 018's rule:
      // distinguishing them turns the endpoint into a way to enumerate other
      // people's address books by id.
      throw new NotFoundException({ error: 'recipient_not_found' });
    }
  }

  /** Sorts the list, so the people somebody actually pays rise to the top. */
  async noteUsed(userUuid: string, id: string): Promise<void> {
    await this.pool
      .query(
        `UPDATE recipients r SET last_used_at = now()
           FROM users u
          WHERE u.id = r.user_id AND u.uuid = $1 AND r.uuid = $2`,
        [userUuid, id],
      )
      .catch(() => undefined);
  }

  /**
   * A Xetral customer, resolved through the ONE resolver that owns that
   * question.
   *
   * It reads `users` directly here for the NAME and the country, which
   * `RecipientService.resolve` deliberately does not return — that one answers
   * an id because a transfer needs an id and nothing else. Widening it would
   * put a name into every path that only wanted to route money.
   */
  async #resolveXetral(
    userUuid: string,
    typed: string,
    iso: string | undefined,
  ): Promise<RecipientResolution> {
    /*
     * `08031234567` IS HOW A NUMBER IS WRITTEN IN LAGOS, and matching the
     * stored E.164 against it finds nobody.
     *
     * `users.phone` is `+2348031234567`, so comparing typed digits to stored
     * digits works only for somebody who typed the country code — and the
     * resolver this one sits beside refuses a bare national number ON PURPOSE:
     * assuming the SENDER's country is wrong for exactly the cross-border
     * payments this screen exists for, and matching on a suffix can pay a
     * stranger abroad who shares the digits.
     *
     * What makes the national form safe is a country that was CHOSEN rather
     * than assumed. This flow has one: the currency step already fixed where
     * the money is going, so the dialling code comes from that country's own
     * row through the same `phone.ts` the payout path uses. One normalisation,
     * three places agreeing about one number — the shape the two recipient
     * resolvers and the two beneficiary lookups both record.
     *
     * The raw digits are still matched too, so a pasted `+2348031234567` or
     * `2348031234567` goes on working when no country is supplied.
     */
    const raw = typed.replace(/[^0-9]/g, '');
    let national: string | undefined;
    if (iso !== undefined) {
      const country = await this.countries.byCode(iso);
      if (country !== undefined) national = internationalDigits(country.dial_code, typed);
    }

    const found = await this.pool.query<{
      id: string;
      full_name: string | null;
      phone: string | null;
      country: string | null;
      currency: string | null;
    }>(
      `SELECT u.id, u.full_name, u.phone, u.country, c.currency
         FROM users u
         LEFT JOIN countries c ON c.code = u.country
        WHERE u.status <> 'closed'
          AND regexp_replace(COALESCE(u.phone, ''), '[^0-9]', '', 'g') IN ($1, $2)`,
      [raw, national ?? raw],
    );
    const row = found.rows[0];
    if (row === undefined) {
      // EXACTLY AS AN UNKNOWN ANYTHING ELSE ANSWERS. A Send screen that told
      // somebody apart from a stranger would be a way to learn which numbers
      // hold accounts here.
      throw new NotFoundException({ error: 'recipient_not_found' });
    }

    const me = await this.pool.query<{ id: string }>(`SELECT id FROM users WHERE uuid = $1`, [
      userUuid,
    ]);
    if (me.rows[0]?.id === row.id) {
      throw new UnprocessableEntityException({ error: 'cannot_send_to_self' });
    }

    return {
      kind: 'xetral',
      country: row.country ?? '',
      /* What they hold. A Xetral account receives in its own country's money
       * unless the sender converts, and the amount screen offers that. */
      currency: row.currency ?? 'NGN',
      rail_code: null,
      rail_name: null,
      /* WHAT WAS MATCHED, never what was typed. The row is what a later send
         reads, and 043's rule is that a destination which the rail never saw
         is one nothing can reconcile afterwards. */
      destination: (row.phone ?? '').replace(/[^0-9]/g, '') || raw,
      /* ALWAYS RESOLVED for this kind: the account is ours, so the name is a
       * fact rather than a claim, and no label is ever asked for. */
      resolved_name: row.full_name ?? 'Xetral customer',
    };
  }

  async #byDestination(
    userUuid: string,
    found: RecipientResolution,
  ): Promise<RecipientView | undefined> {
    const rows = await this.pool.query<RecipientRow>(
      `SELECT r.uuid, r.kind::text AS kind, r.country, r.currency, r.rail_code,
              r.rail_name, r.destination, r.display_name, r.resolved_name,
              r.last_used_at, r.created_at
         FROM recipients r
         JOIN users u ON u.id = r.user_id
        WHERE u.uuid = $1 AND r.removed_at IS NULL
          AND r.kind = $2::recipient_kind
          AND COALESCE(r.rail_code, '') = COALESCE($3, '')
          AND r.destination = $4`,
      [userUuid, found.kind, found.rail_code, found.destination],
    );
    const row = rows.rows[0];
    return row === undefined ? undefined : toView(row);
  }
}

function toView(row: RecipientRow): RecipientView {
  return {
    id: row.uuid,
    kind: row.kind,
    country: row.country,
    currency: row.currency,
    rail_code: row.rail_code,
    rail_name: row.rail_name,
    destination: row.destination,
    display_name: row.display_name,
    resolved_name: row.resolved_name,
    last_used_at: row.last_used_at?.toISOString() ?? null,
    created_at: row.created_at.toISOString(),
  };
}

/**
 * "This rail has no name enquiry", told apart from every other refusal.
 *
 * `lookupOrRefuse` answers `name_unavailable` for that one case and
 * `account_not_found` for everything else — deliberately indistinguishable, so
 * the endpoint cannot be walked to map which numbers are live. Reading the
 * code off the exception rather than the message, because a message is prose
 * somebody will reword.
 */
function isNameUnavailable(error: unknown): boolean {
  if (!(error instanceof NotFoundException)) return false;
  const body = error.getResponse() as { error?: string };
  return body.error === 'name_unavailable';
}

/** A short, log-safe description of a swallowed lookup failure — never the
 *  provider's own sentence, which names our integration (006). */
function describe(error: unknown): string {
  if (error instanceof HttpException) {
    const body = error.getResponse();
    const code = typeof body === 'object' && body !== null ? (body as { error?: string }).error : undefined;
    return code ?? `http ${error.getStatus()}`;
  }
  return error instanceof Error ? error.name : 'unknown';
}
