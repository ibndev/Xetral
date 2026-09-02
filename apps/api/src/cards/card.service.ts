import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  HttpException,
  HttpStatus,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { InsufficientFundsError, LedgerService, posting } from '@xetral/ledger';
import type { AccountRef, WrittenEntry } from '@xetral/ledger';
import {
  ProviderRejectedError,
  ProviderTimeoutError,
  ProviderUnavailableError,
} from '@xetral/providers';
import type { CardPort, VirtualCard } from '@xetral/providers';
import { fromMajor, subtract, toMajor } from '@xetral/shared';
import type { Money } from '@xetral/shared';
import { CARD_PORT, DATABASE, LEDGER } from '../tokens.js';
import { CardProtectionService } from './card-protection.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { TaxService } from '../tax/tax.service.js';

const PROVIDER = 'bitnob';

/**
 * How many reveals are allowed, and over what window.
 *
 * Two ceilings because they catch different things: per CARD stops somebody
 * harvesting one number, per CUSTOMER stops somebody walking a stolen session
 * through every card on an account — which the per-card limit would never see.
 *
 * The numbers are deliberately generous for a real customer (who reads a
 * number once when they save it somewhere, and occasionally again) and useless
 * to a script.
 */
const REVEAL_WINDOW_MINUTES = 60;
const REVEALS_PER_CARD = 5;
const REVEALS_PER_CUSTOMER = 10;

/**
 * What a reveal returns. Deliberately NOT part of `CardView`.
 *
 * If these were optional members of the ordinary card view, every listing and
 * every log line that serialises a card would carry a PAN whenever one
 * happened to be present — and the day it did, nothing would fail. A separate
 * type means the number can only travel through code that named it.
 */
export interface CardSecretsView {
  readonly pan: string;
  readonly cvv: string;
  readonly expiry_month: number;
  readonly expiry_year: number;
  readonly name_on_card?: string;
}

export interface CardView {
  readonly id: string;
  readonly status: string;
  readonly currency: string;
  readonly last4: string | null;
  readonly expiry_month: number | null;
  readonly expiry_year: number | null;
  readonly balance: string;
  /**
   * What the CUSTOMER calls this card, or null.
   *
   * Not `name_on_card`, which is their legal name and is not theirs to set.
   * Null is the resting state and the client falls back to the last four
   * digits — a card nobody has named is not a card with a blank name.
   */
  readonly label: string | null;
  /**
   * Why the card is frozen, when it is. Absent on a live card.
   *
   * `status: 'frozen'` alone cannot be turned into a sentence: one case is
   * "you froze this, tap to unfreeze" and the other is "we stopped a charge
   * that looked wrong". Showing the first wording for the second tells a
   * customer nothing happened when something did.
   */
  readonly frozen?: {
    readonly by: string;
    readonly reason: string;
    readonly detail: string | null;
    readonly at: string;
  };
}

interface CardRow {
  id: string;
  uuid: string;
  user_id: string;
  provider_card_id: string;
  status: string;
  currency: string;
  last4: string | null;
  expiry_month: number | null;
  expiry_year: number | null;
  label: string | null;
}

/**
 * Virtual USD cards.
 *
 * The card lives at Bitnob; what lives here is the mapping from a provider card
 * id to a customer, and the ledger entries for money moving on and off it.
 *
 * OPERATIONAL: Bitnob card issuing requires their approval before it can be
 * used at all, and that approval has a lead time. Nothing in this file works
 * against the live provider until it is granted.
 */
@Injectable()
export class CardService {
  readonly #logger = new Logger(CardService.name);

  constructor(
    @Inject(DATABASE) private readonly pool: Pool,
    @Inject(LEDGER) private readonly ledger: LedgerService,
    @Inject(CARD_PORT) private readonly cards: CardPort,
    @Inject(CardProtectionService) private readonly protection: CardProtectionService,
    @Inject(SettingsService) private readonly settings: SettingsService,
    @Inject(TaxService) private readonly tax: TaxService,
  ) {}

  async list(userUuid: string): Promise<readonly CardView[]> {
    const userId = await this.#activeUserId(userUuid);
    const rows = await this.pool.query<CardRow>(
      `SELECT id, uuid, user_id, provider_card_id, status, currency,
              last4, expiry_month, expiry_year, label
         FROM cards WHERE user_id = $1::bigint ORDER BY id DESC`,
      [userId],
    );
    return Promise.all(rows.rows.map(async (row) => this.#toView(row)));
  }

  /**
   * What a new card costs, as a major-unit string.
   *
   * Read from `platform_settings` on every call rather than cached here: the
   * settings service already caches for thirty seconds, and a second cache in
   * front of it would mean a price change took two windows to reach a screen.
   */
  async issuanceFee(): Promise<string> {
    const cents = await this.settings.cardIssuanceFeeCents();
    return toMajor({ amount: BigInt(cents), currency: 'USD' });
  }

  async get(userUuid: string, cardUuid: string): Promise<CardView> {
    const { row } = await this.#ownedCard(userUuid, cardUuid);
    return this.#toView(row);
  }

  /**
   * Issues a card and loads it in one customer-visible step.
   *
   * The provider call happens BEFORE the ledger entry, and the order matters:
   * if we posted first and Bitnob then refused, we would have moved a
   * customer's money onto a card that does not exist. Failing the other way —
   * provider succeeded, our write failed — leaves a real card we know about
   * from the response, which reconciliation can pick up.
   */
  async issue(
    userUuid: string,
    input: { idempotencyKey: string },
  ): Promise<CardView> {
    await this.settings.assertServiceEnabled('cards');
    const userId = await this.#activeUserId(userUuid);

    const providerCustomerId = await this.#providerCustomerId(userId);

    /*
     * THE NAME ON THE CARD IS THE VERIFIED ONE, and is not a field.
     *
     * A card is a payment instrument issued in a person's legal name, and the
     * only place this system holds one is `kyc_submissions.full_name` — what a
     * reviewer read off a document. `users.full_name` is what somebody typed
     * about themselves, which is right for a greeting and wrong here; the rule
     * 040 records about which of the two a money decision may read is exactly
     * this case.
     *
     * A free-text box was worse than either: it let the name embossed on the
     * card disagree with the identity it was issued against, which is the one
     * mismatch a merchant checks.
     */
    const nameOnCard = await this.#verifiedName(userId);

    /*
     * THE PRICE IS CHARGED BEFORE BITNOB IS ASKED FOR ANYTHING, and the order
     * is the same argument `fund()` makes: what decides whether a customer can
     * afford this is the OVERDRAFT GUARD, and a card must not be requested from
     * a provider on money that turns out not to be there.
     *
     * The other order was tempting, because issuing already calls Bitnob first
     * — but that rule is about the FUNDING leg, which puts a customer's money
     * onto a card that might not exist. A fee is the opposite shape: charged
     * first and refused by them, it is recoverable by appending a reversal;
     * charged after, a customer who cannot pay is already holding a live card.
     */
    const fee = await this.#chargeIssuanceFee(userId, input.idempotencyKey);

    let issued;
    try {
      issued = await this.cards.issue({
        ownerId: userId,
        providerCustomerId,
        nameOnCard,
        // ZERO. Buying a card and putting money on it are two decisions, and
        // asking them as one meant somebody who wanted a card had to name an
        // amount before they had a card to name it for. `fund()` is the second
        // step and the card screen offers it the moment the card is there.
        initialFunding: { amount: 0n, currency: 'USD' },
      });
    } catch (error) {
      await this.#refundIssuanceFee(userId, input.idempotencyKey, fee, error);
      throw error;
    }

    const client = await this.pool.connect();
    let row: CardRow;
    try {
      await client.query('BEGIN');
      row = await this.#insertCard(client, userId, issued);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      if (isUniqueViolation(error)) {
        // Bitnob returned a card we already know about, which is what a
        // retried issue looks like. Not an error.
        const existing = await this.#cardByProviderId(issued.providerCardId);
        if (existing !== undefined) return this.#toView(existing);
      }
      throw error;
    } finally {
      client.release();
    }

    return this.#toView(row);
  }

  /**
   * What the customer calls this card.
   *
   * NO PIN, because nothing moves. A label is the customer's own note on their
   * own list, and demanding the secret that authorises payments in order to
   * write one would train people to type it for things that are not payments.
   *
   * A terminated card can still be renamed: it stays in the list, and being
   * able to write "old one, compromised" beside it is most of why somebody
   * would want to.
   */
  async name(userUuid: string, cardUuid: string, label: string | null): Promise<CardView> {
    const { row } = await this.#ownedCard(userUuid, cardUuid);

    const updated = await this.pool.query<CardRow>(
      `UPDATE cards SET label = $2 WHERE id = $1::bigint
       RETURNING id, uuid, user_id, provider_card_id, status, currency,
                 last4, expiry_month, expiry_year, label`,
      [row.id, label],
    );

    const next = updated.rows[0];
    // The row was read under the same request a moment ago, so this is a card
    // deleted between the two — which nothing in this system does. Falling back
    // to the row we have would report the OLD label as the new one.
    if (next === undefined) throw new NotFoundException({ error: 'card_not_found' });
    return this.#toView(next);
  }

  async fund(
    userUuid: string,
    cardUuid: string,
    input: { amount: string; idempotencyKey: string },
  ): Promise<CardView> {
    await this.settings.assertServiceEnabled('cards');
    const { userId, row } = await this.#ownedCard(userUuid, cardUuid);
    this.#assertUsable(row);

    const amount = this.#parseAmount(input.amount);

    // The ledger entry goes FIRST here, unlike issuing. Moving wallet -> card
    // is what the overdraft guard protects: if the customer cannot afford it,
    // nothing should be sent to Bitnob at all. The provider call is what might
    // then fail, and a funded card account with no provider top-up is
    // recoverable by reconciliation; the reverse is money out the door.
    await this.#postCardFunding(userId, amount, `card-fund:${input.idempotencyKey}`, row.uuid);

    const outcome = await this.cards.fund({
      providerCardId: row.provider_card_id,
      amount,
      idempotencyKey: input.idempotencyKey,
    });

    if (outcome.state === 'pending') {
      // Not a failure — Bitnob answers immediately and settles later. Recorded
      // so reconciliation knows to look, rather than reported as success.
      this.#logger.log(
        `card ${row.uuid} top-up is pending at the provider (${outcome.providerReference})`,
      );
    }

    return this.get(userUuid, cardUuid);
  }

  /**
   * The card number, the CVV and the expiry.
   *
   * A PASS-THROUGH, and every decision here follows from that. The details are
   * fetched from the provider, handed to the customer, and dropped: nothing is
   * written, nothing is cached, and `003_cards.sql` has no column that could
   * hold them. "Never stored" is a property of the schema rather than a rule
   * somebody has to remember.
   *
   * WHY THIS NEEDS THE SAME CARE AS MOVING MONEY. A reveal endpoint is a PAN
   * oracle for anybody holding a stolen session — a card number, a CVV and an
   * expiry together are everything needed to spend online, and unlike a
   * transfer there is no ledger entry afterwards to notice. So it takes a PIN,
   * it is rate limited by rows that outlive a restart, and every call leaves a
   * record naming who asked and from where.
   *
   * The kill switch is deliberately NOT consulted. Pausing cards stops new
   * commitments; a customer standing at a checkout with a card they already
   * hold must still be able to read it. Same reasoning that leaves freezing
   * available while cards are paused.
   */
  async reveal(
    userUuid: string,
    cardUuid: string,
    ipAddress: string | undefined,
  ): Promise<CardSecretsView> {
    const { userId, row } = await this.#ownedCard(userUuid, cardUuid);

    if (row.status === 'terminated') {
      // Refused here as well as by the trigger. The database is what makes it
      // true; this is what makes the customer's error legible.
      throw new UnprocessableEntityException({ error: 'card_terminated' });
    }

    await this.#assertRevealAllowed(row.id, userId);

    const secrets = await this.cards.reveal(row.provider_card_id);

    // Recorded AFTER the provider answered, so a failed fetch does not spend
    // the customer's allowance — and BEFORE the value is returned, so a reveal
    // the customer received always has a record. The order is the one that
    // errs towards recording too much rather than too little.
    await this.pool.query(
      `INSERT INTO card_reveals (card_id, user_id, ip_address)
       VALUES ($1::bigint, $2::bigint, $3)`,
      [row.id, userId, ipAddress ?? null],
    );

    this.#logger.warn(`card ${row.uuid} was revealed to its owner`);

    return {
      // The only place in this codebase where a PAN crosses a service
      // boundary. It goes straight out in the response and is referenced
      // nowhere else — not logged, not in the audit detail, not in an error.
      pan: secrets.pan,
      cvv: secrets.cvv,
      expiry_month: secrets.expiryMonth,
      expiry_year: secrets.expiryYear,
      ...(secrets.nameOnCard === undefined ? {} : { name_on_card: secrets.nameOnCard }),
    };
  }

  /**
   * The ceiling on reveals, counted from rows rather than memory.
   *
   * An attacker's loop outlives a pod restart and an in-process counter does
   * not, so the limit is a count over `card_reveals` — which is also the table
   * an investigator reads, so the limit and the evidence cannot disagree.
   *
   * Two ceilings, because they catch different things. Per CARD catches
   * somebody harvesting one number; per CUSTOMER catches somebody walking a
   * stolen session through every card on the account, which the per-card limit
   * would never see.
   */
  async #assertRevealAllowed(cardId: string, userId: string): Promise<void> {
    const counts = await this.pool.query<{ for_card: string; for_user: string }>(
      `SELECT
         count(*) FILTER (WHERE card_id = $1::bigint)::text AS for_card,
         count(*)::text                                      AS for_user
         FROM card_reveals
        WHERE user_id = $2::bigint
          AND revealed_at > now() - make_interval(mins => $3::int)`,
      [cardId, userId, REVEAL_WINDOW_MINUTES],
    );

    const forCard = Number(counts.rows[0]?.for_card ?? '0');
    const forUser = Number(counts.rows[0]?.for_user ?? '0');

    if (forCard >= REVEALS_PER_CARD || forUser >= REVEALS_PER_CUSTOMER) {
      this.#logger.error(
        `reveal refused for user ${userId}: ${forCard} for this card and ${forUser} ` +
          `across their cards in the last ${REVEAL_WINDOW_MINUTES} minutes`,
      );
      throw new HttpException({ error: 'too_many_reveals' }, HttpStatus.TOO_MANY_REQUESTS);
    }
  }

  async freeze(userUuid: string, cardUuid: string): Promise<CardView> {
    const { row } = await this.#ownedCard(userUuid, cardUuid);
    this.#assertUsable(row);

    const updated = await this.cards.freeze(row.provider_card_id);
    await this.#setStatusBy(row.id, updated.status, 'customer', userUuid);
    // Recorded as the CUSTOMER's freeze, so unfreezing later can tell them
    // this was their own doing rather than an incident they slept through.
    await this.protection.record(row.id, 'customer', 'customer_request', null);
    return this.get(userUuid, cardUuid);
  }

  async unfreeze(userUuid: string, cardUuid: string): Promise<CardView> {
    const { row } = await this.#ownedCard(userUuid, cardUuid);
    if (row.status === 'terminated') {
      throw new ConflictException({ error: 'card_terminated' });
    }

    const updated = await this.cards.unfreeze(row.provider_card_id);
    await this.#setStatusBy(row.id, updated.status, 'customer', userUuid);
    // The freeze record is closed, not deleted: "was this card ever frozen
    // automatically, and when" has to stay answerable months later, which is
    // the whole reason the table is append-only.
    await this.protection.liftFreeze(row.id, row.user_id);
    return this.get(userUuid, cardUuid);
  }

  /**
   * Terminates a card and returns whatever is left on it to the wallet.
   *
   * The provider call comes first: a card we have emptied in the ledger but
   * failed to kill at Bitnob is a live card with no funds behind it, which is
   * the worse of the two failures.
   */
  async terminate(userUuid: string, cardUuid: string): Promise<CardView> {
    const { userId, row } = await this.#ownedCard(userUuid, cardUuid);
    if (row.status === 'terminated') {
      // Already done. Terminating twice is not an error — the customer got
      // what they asked for.
      return this.#toView(row);
    }

    await this.cards.terminate(row.provider_card_id);

    await this.#terminateRow(row.id, 'customer', userUuid);

    const remaining = await this.#cardBalance(userId);
    if (remaining > 0n) {
      await this.ledger.post({
        idempotencyKey: `card-terminate:${row.uuid}`,
        kind: 'card_termination',
        occurredAt: new Date(),
        description: 'card terminated, balance returned',
        metadata: { card_id: row.uuid },
        postings: [
          posting(cardAccount(userId), { amount: -remaining, currency: 'USD' }),
          posting(walletAccount(userId), { amount: remaining, currency: 'USD' }),
        ],
      });
    }

    return this.get(userUuid, cardUuid);
  }

  /**
   * A support agent freezing a card, with a reason.
   *
   * FREEZE ONLY, and terminate deliberately absent. Freezing stops spending
   * and is reversible by the customer; terminating moves their money and
   * cannot be undone, and there is no support conversation in which doing that
   * to somebody's card without them is the right call. An agent watching
   * fraudulent charges land needs the first and never the second.
   *
   * The reason is required by the CHECK in 030 as well as by the endpoint,
   * because a customer WILL ring back to ask why their card stopped working
   * and "a member of staff froze it" is not an answer.
   */
  async freezeAsStaff(cardUuid: string, staffUuid: string, reason: string): Promise<void> {
    const found = await this.pool.query<CardRow>(
      `SELECT id, uuid, user_id, provider_card_id, status, currency,
              last4, expiry_month, expiry_year, label
         FROM cards WHERE uuid = $1::uuid`,
      [cardUuid],
    );
    const row = found.rows[0];
    if (row === undefined) throw new NotFoundException({ error: 'card_not_found' });
    if (row.status === 'terminated') {
      throw new ConflictException({ error: 'card_terminated' });
    }
    if (row.status === 'frozen') return;

    const updated = await this.cards.freeze(row.provider_card_id);
    await this.#setStatusBy(row.id, updated.status, 'staff', staffUuid, reason);
    // Recorded in the protection table too, so `cards_frozen_automatically`
    // and this agree about why a card is frozen. Without it the customer's own
    // unfreeze path reads a freeze it cannot explain.
    await this.protection.record(row.id, 'staff', 'support_action', null);
  }

  /**
   * Replaces a card whose number the customer can no longer trust.
   *
   * ONE OPERATION FROM THEIR SIDE, and three underneath: the old card is
   * terminated (which returns its balance to the wallet, as termination
   * always does), a new one is issued, and the two are linked. Without the
   * link their history reads as an unexplained termination followed by an
   * unrelated new card, and the money that moved between them looks like two
   * transactions rather than one continuation.
   *
   * THE ORDER IS THE OLD CARD FIRST, deliberately, and it is the opposite of
   * what convenience suggests. Issuing first would leave a customer holding a
   * live replacement AND a live compromised card if the termination then
   * failed — which is the exact state they came here to get out of. Killing
   * the leaked number first means the worst case is a customer with no card
   * and their money in their wallet, which is recoverable by asking again.
   *
   * The replacement is funded from the wallet to the same balance the old card
   * held, so "replace this card" does not silently also mean "empty it".
   */
  async reissue(
    userUuid: string,
    cardUuid: string,
    input: { nameOnCard: string; idempotencyKey: string },
  ): Promise<CardView> {
    await this.settings.assertServiceEnabled('cards');
    const { userId, row } = await this.#ownedCard(userUuid, cardUuid);

    if (row.status === 'terminated') {
      // Already dead. Reissuing against it is still the right request — the
      // customer wants a working card — so this is not refused, but the
      // balance to carry over is whatever the card account holds now.
      this.#logger.log(`reissuing against already-terminated card ${row.uuid}`);
    }

    // What the old card held, read BEFORE terminating returns it to the
    // wallet. Read after, it would always be zero and every replacement would
    // arrive empty.
    const carried = await this.#cardBalance(userId);

    if (row.status !== 'terminated') {
      await this.cards.terminate(row.provider_card_id);
      await this.#terminateRow(row.id, 'customer', userUuid, 'replaced by a new card');
      if (carried > 0n) {
        await this.ledger.post({
          idempotencyKey: `card-terminate:${row.uuid}`,
          kind: 'card_termination',
          occurredAt: new Date(),
          description: 'card replaced, balance returned',
          metadata: { card_id: row.uuid },
          postings: [
            posting(cardAccount(userId), { amount: -carried, currency: 'USD' }),
            posting(walletAccount(userId), { amount: carried, currency: 'USD' }),
          ],
        });
      }
    }

    const providerCustomerId = await this.#providerCustomerId(userId);
    const issued = await this.cards.issue({
      ownerId: userId,
      providerCustomerId,
      nameOnCard: input.nameOnCard,
      initialFunding: { amount: 0n, currency: 'USD' },
    });

    const client = await this.pool.connect();
    let replacement: CardRow;
    try {
      await client.query('BEGIN');
      replacement = await this.#insertCard(client, userId, issued, row.id);
      // The event the INSERT trigger just wrote says 'issued' by 'system'.
      // Naming it a REISSUE is what separates "the customer wanted another
      // card" from "we replaced one whose number leaked", which are different
      // facts about the same row.
      await client.query(
        `UPDATE card_events e
            SET kind = 'reissued', actor = 'customer', actor_id = u.id
           FROM users u
          WHERE u.uuid = $2::uuid
            AND e.id = (SELECT max(id) FROM card_events WHERE card_id = $1::bigint)`,
        [replacement.id, userUuid],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      if (isUniqueViolation(error)) {
        const existing = await this.#cardByProviderId(issued.providerCardId);
        if (existing !== undefined) return this.#toView(existing);
      }
      throw error;
    } finally {
      client.release();
    }

    // Funded back to what the old card held, so replacing a card does not
    // silently empty it. Keyed on the customer's own attempt, so a retry that
    // reaches here twice funds once.
    if (carried > 0n) {
      await this.#postCardFunding(
        userId,
        { amount: carried, currency: 'USD' },
        `card-reissue:${input.idempotencyKey}`,
        replacement.uuid,
      );
    }

    return this.#toView(replacement);
  }

  /* ---------------------------------------------------------------- */

  /**
   * The name a card is issued in, read from the APPROVED identity.
   *
   * `kyc_submissions.full_name` and not `users.full_name`: one was read off a
   * document by a reviewer and the other is what somebody typed about
   * themselves. Only the first may drive a money decision, and a card is one.
   *
   * A card cannot be issued at all without `provider_customers`, which
   * approval writes in the same transaction as the tier — so by the time this
   * runs there is always an approved submission. It is still checked, because
   * "there is always one" is the kind of claim that stops being true in a
   * migration nobody connected to this file.
   */
  async #verifiedName(userId: string): Promise<string> {
    const found = await this.pool.query<{ full_name: string }>(
      `SELECT full_name FROM kyc_submissions
        WHERE user_id = $1::bigint AND status = 'approved'
        ORDER BY id DESC LIMIT 1`,
      [userId],
    );
    const name = found.rows[0]?.full_name;
    if (name === undefined || name.trim() === '') {
      throw new ConflictException({ error: 'kyc_required', product: 'card' });
    }
    return name;
  }

  /**
   * What a card costs, taken from the customer's USD wallet.
   *
   * TAX IS A LIABILITY, so the fee splits the way a transfer fee does: what we
   * keep goes to `revenue_fees` and what we owe onward goes to
   * `liability_tax_payable`. Booking the whole thing as revenue overstates what
   * the business earned and understates what it owes.
   *
   * `card_creation` has been in `entry_kind` since 001 and nothing had ever
   * posted one. This is what it was for.
   *
   * A ZERO PRICE POSTS NOTHING. The ledger refuses a zero-amount posting, and
   * an entry saying "we charged nothing" is indistinguishable from one somebody
   * forgot to write — the rule 032 records about `tax_collections`.
   */
  async #chargeIssuanceFee(userId: string, idempotencyKey: string): Promise<Money<'USD'>> {
    const cents = await this.settings.cardIssuanceFeeCents();
    const fee: Money<'USD'> = { amount: BigInt(cents), currency: 'USD' };
    if (fee.amount <= 0n) return fee;

    const split = await this.tax.splitFee(fee);

    // The fee, the tax and the wallet leg are three CONDITIONAL legs for the
    // same reason a transfer's are: a zero-rate VAT on a real fee must still
    // post the fee, and a zero leg is not a leg.
    const onEntry = async (client: PoolClient, entry: WrittenEntry): Promise<void> => {
      if (split.tax.amount <= 0n) return;
      await this.tax.record(client, {
        kind: 'vat',
        entryId: entry.entryId,
        userId,
        amount: split.tax,
        // The fee is what VAT was charged on. There is nothing else it could
        // be here — unlike a transfer, where the amount moving is the tempting
        // and wrong answer.
        baseMinor: split.gross.amount,
        rateApplied: String(await this.settings.vatBasisPoints()),
        occurredAt: new Date(),
      });
    };

    try {
      await this.ledger.post(
        {
          idempotencyKey: `card-issue-fee:${idempotencyKey}`,
          kind: 'card_creation',
          occurredAt: new Date(),
          description: 'card issuance fee',
          metadata: {},
          postings: [
            posting(walletAccount(userId), negate(split.gross)),
            ...(split.net.amount > 0n
              ? [posting({ kind: 'revenue_fees', currency: 'USD' }, split.net)]
              : []),
            ...(split.tax.amount > 0n
              ? [posting({ kind: 'liability_tax_payable', currency: 'USD' }, split.tax)]
              : []),
          ],
        },
        { onEntry },
      );
    } catch (error) {
      if (error instanceof InsufficientFundsError) {
        // 422 and no figure. Telling a caller how short they are turns this
        // into a balance oracle for a stolen session — the rule the transfer
        // endpoint follows, applied to the one other place a customer can be
        // refused for money.
        throw new UnprocessableEntityException({ error: 'insufficient_funds' });
      }
      throw error;
    }

    return split.gross;
  }

  /**
   * Giving the price back when the card never existed.
   *
   * ONLY ON A DEFINITE ANSWER. Bitnob refusing, or being unreachable, both mean
   * no card was created — so holding the money would be charging for nothing.
   * A TIMEOUT means we do not know: the card may exist, and reversing would
   * hand back the price of a card the customer is holding. That one is left
   * posted and escalated, which is the rule the purchase flow follows for
   * exactly the same reason.
   *
   * A reversal, never an edit. The original entry was a true statement — the
   * customer did pay — and the correction is a second entry naming the first.
   */
  async #refundIssuanceFee(
    userId: string,
    idempotencyKey: string,
    fee: Money<'USD'>,
    cause: unknown,
  ): Promise<void> {
    if (fee.amount <= 0n) return;

    if (cause instanceof ProviderTimeoutError) {
      this.#logger.error(
        `card issuance timed out after the fee was charged (key ${idempotencyKey}). ` +
          `The card may exist at the provider; the fee is NOT reversed and needs a person.`,
      );
      return;
    }
    if (!(cause instanceof ProviderRejectedError) && !(cause instanceof ProviderUnavailableError)) {
      // Anything else is a fault on our side of the port, and we cannot say
      // whether a card was created either. Same treatment as a timeout.
      this.#logger.error(
        `card issuance failed after the fee was charged (key ${idempotencyKey}); ` +
          `the fee is NOT reversed and needs a person.`,
      );
      return;
    }

    const charged = await this.pool.query<{ id: string }>(
      `SELECT id FROM journal_entries WHERE idempotency_key = $1`,
      [`card-issue-fee:${idempotencyKey}`],
    );
    const entryId = charged.rows[0]?.id;
    // Nothing to reverse. The fee was refused before it posted, and the error
    // the caller is about to see is the real one.
    if (entryId === undefined) return;

    const split = await this.tax.splitFee(fee);
    await this.ledger.post({
      idempotencyKey: `card-issue-fee-reversal:${idempotencyKey}`,
      kind: 'reversal',
      reversesEntryId: entryId,
      occurredAt: new Date(),
      description: 'card issuance fee returned — the card was never created',
      metadata: {},
      postings: [
        posting(walletAccount(userId), split.gross),
        ...(split.net.amount > 0n
          ? [posting({ kind: 'revenue_fees', currency: 'USD' }, negate(split.net))]
          : []),
        ...(split.tax.amount > 0n
          ? [posting({ kind: 'liability_tax_payable', currency: 'USD' }, negate(split.tax))]
          : []),
      ],
    });
  }

  async #postCardFunding(
    userId: string,
    amount: Money<'USD'>,
    idempotencyKey: string,
    cardUuid: string,
  ): Promise<void> {
    try {
      await this.ledger.post({
        idempotencyKey,
        kind: 'card_funding',
        occurredAt: new Date(),
        description: 'card funding',
        metadata: { card_id: cardUuid },
        postings: [
          posting(walletAccount(userId), negate(amount)),
          posting(cardAccount(userId), amount),
        ],
      });
    } catch (error) {
      if (error instanceof InsufficientFundsError) {
        throw new UnprocessableEntityException({ error: 'insufficient_funds' });
      }
      throw error;
    }
  }

  async #insertCard(
    client: PoolClient,
    userId: string,
    card: VirtualCard,
    replacesCardId?: string,
  ): Promise<CardRow> {
    const inserted = await client.query<CardRow>(
      `INSERT INTO cards (user_id, provider, provider_card_id, currency,
                          last4, expiry_month, expiry_year, status,
                          replaces_card_id)
       VALUES ($1::bigint, $2, $3, 'USD', $4, $5, $6, $7::card_status, $8::bigint)
       RETURNING id, uuid, user_id, provider_card_id, status, currency,
                 last4, expiry_month, expiry_year, label`,
      [
        userId,
        PROVIDER,
        card.providerCardId,
        card.last4,
        card.expiryMonth,
        card.expiryYear,
        card.status,
        replacesCardId ?? null,
      ],
    );
    const row = inserted.rows[0];
    if (row === undefined) throw new Error('card insert returned no row');
    return row;
  }

  async #setStatus(cardId: string, status: string): Promise<void> {
    await this.pool.query(`UPDATE cards SET status = $2::card_status WHERE id = $1::bigint`, [
      cardId,
      status,
    ]);
  }

  /**
   * Changes a card's status and says WHO did it, in one transaction.
   *
   * The trigger in 030 writes an event for every status change, which is what
   * makes the record impossible to skip — but a trigger cannot know whether a
   * customer, a support agent or an automatic protection caused it, so it
   * writes `system` and this completes the row.
   *
   * ONE TRANSACTION, so the two cannot diverge. Left apart, a process dying in
   * between would leave a real change attributed to nobody — and "the system
   * did it" would then be a claim the record makes about actions people took.
   */
  /**
   * Terminates a card row and says who did it, in one transaction.
   *
   * `terminated_at` and the status move together because 003's CHECK demands
   * it, and the attribution rides along for the same reason `#setStatusBy`
   * exists: a termination attributed to nobody is one nobody can explain to
   * the customer who asks why their card stopped working.
   */
  async #terminateRow(
    cardId: string,
    actor: 'customer' | 'staff',
    actorUuid: string,
    reason?: string,
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE cards SET status = 'terminated', terminated_at = now() WHERE id = $1::bigint`,
        [cardId],
      );
      await this.#attributeLatest(client, cardId, actor, actorUuid, reason);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async #setStatusBy(
    cardId: string,
    status: string,
    actor: 'customer' | 'staff',
    actorUuid: string,
    reason?: string,
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`UPDATE cards SET status = $2::card_status WHERE id = $1::bigint`, [
        cardId,
        status,
      ]);
      await this.#attributeLatest(client, cardId, actor, actorUuid, reason);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Names the actor on the event the trigger just wrote.
   *
   * Scoped to the card and to the newest row, so two concurrent changes to
   * DIFFERENT cards cannot attribute each other's. Two concurrent changes to
   * the SAME card would be a customer racing themselves, and the transaction
   * above serialises them.
   */
  async #attributeLatest(
    client: PoolClient,
    cardId: string,
    actor: 'customer' | 'staff',
    actorUuid: string,
    reason?: string,
  ): Promise<void> {
    await client.query(
      `UPDATE card_events e
          SET actor = $2::card_actor, actor_id = u.id, reason = $3
         FROM users u
        WHERE u.uuid = $4::uuid
          AND e.id = (SELECT max(id) FROM card_events WHERE card_id = $1::bigint)`,
      [cardId, actor, reason ?? null, actorUuid],
    );
  }

  /**
   * The balance shown for a card comes from the LEDGER, not from asking Bitnob.
   *
   * The ledger is the source of truth for what the customer is owed, and a
   * provider's figure can lag a settlement by days. Reconciliation compares the
   * two deliberately; the customer sees ours.
   */
  async #cardBalance(userId: string): Promise<bigint> {
    const balance = await this.ledger.balanceOf(cardAccount(userId));
    return balance?.balanceMinor ?? 0n;
  }

  async #toView(row: CardRow): Promise<CardView> {
    const balance = await this.#cardBalance(row.user_id);
    return {
      id: row.uuid,
      status: row.status,
      currency: row.currency,
      last4: row.last4,
      expiry_month: row.expiry_month,
      expiry_year: row.expiry_year,
      label: row.label,
      balance: toMajor({ amount: balance, currency: 'USD' }),
      ...(await this.#freezeContext(row)),
    };
  }

  /** The live freeze on a card, if there is one, shaped for the client. */
  async #freezeContext(row: CardRow): Promise<Pick<CardView, 'frozen'>> {
    if (row.status !== 'frozen') return {};
    const live = await this.protection.liveFreeze(row.id);
    if (live === undefined) return {};
    return {
      frozen: {
        by: live.actor,
        reason: live.reason,
        detail: live.detail,
        at: live.at.toISOString(),
      },
    };
  }

  #assertUsable(row: CardRow): void {
    if (row.status === 'terminated') throw new ConflictException({ error: 'card_terminated' });
    if (row.status === 'frozen') throw new ConflictException({ error: 'card_frozen' });
  }

  #parseAmount(raw: string): Money<'USD'> {
    let amount: Money<'USD'>;
    try {
      amount = fromMajor(raw, 'USD');
    } catch (cause) {
      throw new BadRequestException({
        error: 'invalid_amount',
        detail: cause instanceof Error ? cause.message : undefined,
      });
    }
    if (amount.amount < 0n) {
      throw new BadRequestException({ error: 'invalid_amount', detail: 'must not be negative' });
    }
    return amount;
  }

  async #activeUserId(uuid: string): Promise<string> {
    const result = await this.pool.query<{ id: string; status: string }>(
      `SELECT id, status FROM users WHERE uuid = $1`,
      [uuid],
    );
    const row = result.rows[0];
    if (row === undefined) throw new NotFoundException({ error: 'user_not_found' });
    // Checked at the point of the action, never inferred from a token.
    if (row.status !== 'active') {
      throw new ForbiddenException({ error: 'account_not_active', status: row.status });
    }
    return row.id;
  }

  /** A card belongs to exactly one customer, and the lookup is scoped by user
   *  so another customer's card uuid is a 404 rather than an authorisation
   *  question answered later. */
  async #ownedCard(userUuid: string, cardUuid: string): Promise<{ userId: string; row: CardRow }> {
    const userId = await this.#activeUserId(userUuid);
    const result = await this.pool.query<CardRow>(
      `SELECT id, uuid, user_id, provider_card_id, status, currency,
              last4, expiry_month, expiry_year, label
         FROM cards WHERE uuid = $1 AND user_id = $2::bigint`,
      [cardUuid, userId],
    );
    const row = result.rows[0];
    if (row === undefined) throw new NotFoundException({ error: 'card_not_found' });
    return { userId, row };
  }

  async #cardByProviderId(providerCardId: string): Promise<CardRow | undefined> {
    const result = await this.pool.query<CardRow>(
      `SELECT id, uuid, user_id, provider_card_id, status, currency,
              last4, expiry_month, expiry_year, label
         FROM cards WHERE provider = $1 AND provider_card_id = $2`,
      [PROVIDER, providerCardId],
    );
    return result.rows[0];
  }

  /** Bitnob issues cards to ITS customers. The mapping is created on demand and
   *  is unique per (provider, customer), so a race resolves to one row. */
  async #providerCustomerId(userId: string): Promise<string> {
    const existing = await this.pool.query<{ provider_customer_id: string }>(
      `SELECT provider_customer_id FROM provider_customers
        WHERE user_id = $1::bigint AND provider = $2`,
      [userId, PROVIDER],
    );
    const found = existing.rows[0];
    if (found !== undefined) return found.provider_customer_id;

    throw new ConflictException({
      // Deliberately not created silently here. Registering a customer with
      // Bitnob means sending them identity documents, which is a KYC step with
      // its own consent and its own audit trail -- not a side effect of
      // tapping "get a card".
      //
      // `kyc_required`, the same code crypto, gift cards and NGN accounts
      // use. This was `provider_customer_not_registered`, which describes our
      // internal plumbing rather than what the customer has to do, and it
      // meant the client needed two branches for one condition — so a
      // customer reaching for a card got a generic error while the same
      // customer reaching for crypto got a prompt to verify.
      error: 'kyc_required',
      product: 'card',
    });
  }
}

function cardAccount(userId: string): AccountRef {
  return { kind: 'customer_card', ownerId: userId, currency: 'USD' };
}

function walletAccount(userId: string): AccountRef {
  return { kind: 'customer_wallet', ownerId: userId, currency: 'USD' };
}

function negate(amount: Money<'USD'>): Money<'USD'> {
  return subtract({ amount: 0n, currency: 'USD' }, amount);
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code: unknown }).code === '23505'
  );
}
