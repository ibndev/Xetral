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
import type { AccountRef } from '@xetral/ledger';
import type { CardPort, VirtualCard } from '@xetral/providers';
import { fromMajor, subtract, toMajor } from '@xetral/shared';
import type { Money } from '@xetral/shared';
import { CARD_PORT, DATABASE, LEDGER } from '../tokens.js';
import { CardProtectionService } from './card-protection.service.js';
import { SettingsService } from '../settings/settings.service.js';

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
  ) {}

  async list(userUuid: string): Promise<readonly CardView[]> {
    const userId = await this.#activeUserId(userUuid);
    const rows = await this.pool.query<CardRow>(
      `SELECT id, uuid, user_id, provider_card_id, status, currency,
              last4, expiry_month, expiry_year
         FROM cards WHERE user_id = $1::bigint ORDER BY id DESC`,
      [userId],
    );
    return Promise.all(rows.rows.map(async (row) => this.#toView(row)));
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
    input: { nameOnCard: string; initialFunding: string; idempotencyKey: string },
  ): Promise<CardView> {
    await this.settings.assertServiceEnabled('cards');
    const userId = await this.#activeUserId(userUuid);
    const amount = this.#parseAmount(input.initialFunding);

    const providerCustomerId = await this.#providerCustomerId(userId);

    const issued = await this.cards.issue({
      ownerId: userId,
      providerCustomerId,
      nameOnCard: input.nameOnCard,
      initialFunding: amount,
    });

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

    if (amount.amount > 0n) {
      await this.#postCardFunding(userId, amount, `card-issue:${input.idempotencyKey}`, row.uuid);
    }
    return this.#toView(row);
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
    await this.#setStatus(row.id, updated.status);
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
    await this.#setStatus(row.id, updated.status);
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

    await this.pool.query(
      `UPDATE cards SET status = 'terminated', terminated_at = now() WHERE id = $1::bigint`,
      [row.id],
    );

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

  /* ---------------------------------------------------------------- */

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

  async #insertCard(client: PoolClient, userId: string, card: VirtualCard): Promise<CardRow> {
    const inserted = await client.query<CardRow>(
      `INSERT INTO cards (user_id, provider, provider_card_id, currency,
                          last4, expiry_month, expiry_year, status)
       VALUES ($1::bigint, $2, $3, 'USD', $4, $5, $6, $7::card_status)
       RETURNING id, uuid, user_id, provider_card_id, status, currency,
                 last4, expiry_month, expiry_year`,
      [
        userId,
        PROVIDER,
        card.providerCardId,
        card.last4,
        card.expiryMonth,
        card.expiryYear,
        card.status,
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
              last4, expiry_month, expiry_year
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
              last4, expiry_month, expiry_year
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
