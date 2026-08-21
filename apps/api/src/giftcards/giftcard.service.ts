import { createHash } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { Pool } from 'pg';
import { LedgerService, posting } from '@xetral/ledger';
import type { AccountRef } from '@xetral/ledger';
import { open, seal } from '@xetral/identity';
import type { Keyring } from '@xetral/identity';
import { fromMajor, subtract, toMajor } from '@xetral/shared';
import type { Currency, Money } from '@xetral/shared';
import { API_CONFIG, DATABASE, LEDGER } from '../tokens.js';
import type { ApiConfig } from '../config.js';
import { SettingsService } from '../settings/settings.service.js';
import { payoutFor } from './rate-card.js';
import type { RateCard } from './rate-card.js';
import type { QuoteBody, SubmitGiftCardBody } from './dto.js';

/**
 * Buying gift cards from customers.
 *
 * THE SHAPE OF THIS FLOW IS THE FRAUD MODEL.
 *
 * Everywhere else in the platform the customer gives us money and we give them
 * a thing. Here they give us a thing whose value we CANNOT VERIFY at the
 * moment we pay — a code that may already be redeemed, may be redeemed by the
 * seller minutes later, or may belong to a card bought with a stolen credit
 * card and voided by the issuer weeks afterwards.
 *
 * So there is no arrangement in which paying immediately is safe, and the two
 * controls follow directly:
 *
 *   1. A HUMAN approves every submission. There is no auto-approval path and
 *      no threshold below which one exists — "small" is exactly what a
 *      fraudster sends first to find where the threshold is.
 *   2. An approved payout lands HELD, in `customer_pending`, and becomes
 *      spendable only when the hold matures. That window is the difference
 *      between a clawback being recoverable and being a loss.
 *
 * And the whole thing ships behind a flag that defaults to off.
 */

export interface GiftCardView {
  readonly id: string;
  readonly brand: string;
  readonly status: string;
  readonly face_amount: string;
  readonly face_currency: string;
  readonly payout_amount: string;
  readonly payout_currency: string;
  readonly held_until: string | null;
  readonly rejection_reason: string | null;
  readonly created_at: string;
}

export interface QuoteView {
  readonly payout_amount: string;
  readonly payout_currency: string;
  readonly rate_card_id: string;
  /** Stated in the quote because a customer accepting one should know their
   *  money will not be spendable the moment it appears. */
  readonly hold_days: number;
}

interface SubmissionRow {
  id: string;
  uuid: string;
  user_id: string;
  reference: string;
  brand: string;
  status: string;
  face_amount_minor: string;
  face_currency: string;
  payout_amount_minor: string;
  payout_currency: string;
  hold_until: string | null;
  rejection_reason: string | null;
  created_at: string;
  approval_entry_id: string | null;
  card_sealed: string;
}

@Injectable()
export class GiftCardService {
  readonly #logger = new Logger(GiftCardService.name);

  constructor(
    @Inject(DATABASE) private readonly pool: Pool,
    @Inject(LEDGER) private readonly ledger: LedgerService,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(SettingsService) private readonly settings: SettingsService,
  ) {}

  /**
   * The flag, checked at the top of every entry point.
   *
   * Not a route that 404s and not a module left unregistered: the routes exist,
   * are covered by the policy audit and are exercised by tests, so turning the
   * feature on is a configuration change rather than a deploy of untested
   * code. That is the entire point of shipping it disabled — the risk is off,
   * the code is reviewed.
   */
  async #assertEnabled(): Promise<void> {
    if (!(await this.settings.giftCardsEnabled())) {
      throw new ServiceUnavailableException({ error: 'gift_cards_disabled' });
    }
  }

  async quote(body: QuoteBody): Promise<QuoteView> {
    await this.#assertEnabled();
    const faceCurrency = this.#currency(body.face_currency);
    const face = this.#parseAmount(body.face_amount, faceCurrency);
    const rate = await this.#liveRate(body, face.amount);
    const payoutCurrency = this.#currency(rate.payout_currency);

    return {
      payout_amount: toMajor(payoutFor(face.amount, rate, payoutCurrency)),
      payout_currency: rate.payout_currency,
      rate_card_id: rate.id,
      hold_days: await this.settings.giftCardHoldDays(),
    };
  }

  async submit(userUuid: string, body: SubmitGiftCardBody): Promise<GiftCardView> {
    await this.#assertEnabled();
    const userId = await this.#activeUserId(userUuid);

    const existing = await this.#byKey(userId, body.idempotency_key);
    if (existing !== undefined) return this.#toView(existing);

    const faceCurrency = this.#currency(body.face_currency);
    const face = this.#parseAmount(body.face_amount, faceCurrency);
    const rate = await this.#liveRate(body, face.amount);
    const payoutCurrency = this.#currency(rate.payout_currency);
    const payout = payoutFor(face.amount, rate, payoutCurrency);

    if (payout.amount <= 0n) {
      throw new BadRequestException({ error: 'payout_would_be_zero' });
    }

    // NO LEDGER ENTRY HERE. A submission is an offer, not a transaction —
    // nothing moves until a human approves it, and writing a provisional entry
    // now would put money in a customer's pending balance for a card nobody
    // has looked at.
    const inserted = await this.pool.query<{ id: string }>(
      `INSERT INTO giftcard_submissions
         (user_id, reference, idempotency_key, rate_card_id, face_amount_minor,
          face_currency, payout_amount_minor, payout_currency, card_sealed)
       VALUES ($1::bigint, $2, $3, $4::bigint, $5::bigint, $6, $7::bigint, $8, $9)
       ON CONFLICT (user_id, idempotency_key) DO NOTHING
       RETURNING id`,
      [
        userId,
        referenceFor(userUuid, body.idempotency_key),
        body.idempotency_key,
        rate.id,
        face.amount.toString(),
        body.face_currency,
        payout.amount.toString(),
        rate.payout_currency,
        // The card itself never touches a row in the clear.
        seal(body.card_code, this.#keyring()),
      ],
    );

    const row = inserted.rows[0];
    if (row === undefined) {
      // Two identical submissions raced. The loser reads the winner's row:
      // from the customer's side this was one submission sent twice.
      const raced = await this.#byKey(userId, body.idempotency_key);
      if (raced === undefined) throw new Error('gift card insert returned no row');
      return this.#toView(raced);
    }

    return this.#toView(await this.#reload(row.id));
  }

  async list(userUuid: string): Promise<readonly GiftCardView[]> {
    await this.#assertEnabled();
    const userId = await this.#activeUserId(userUuid);
    const rows = await this.pool.query<SubmissionRow>(
      `${SELECT_SUBMISSION} WHERE s.user_id = $1::bigint ORDER BY s.id DESC LIMIT 100`,
      [userId],
    );
    return rows.rows.map((r) => this.#toView(r));
  }

  /* ----------------------------- review ----------------------------- */

  async queue(): Promise<readonly Record<string, unknown>[]> {
    await this.#assertEnabled();
    const rows = await this.pool.query(
      `SELECT submission_uuid, brand, country, card_type,
              face_amount_minor::text, face_currency,
              payout_amount_minor::text, payout_currency,
              created_at, waiting_for::text
         FROM giftcard_review_queue LIMIT 200`,
    );
    return rows.rows as Record<string, unknown>[];
  }

  /**
   * The card code, revealed to a reviewer so they can check its balance.
   *
   * Separate from the queue listing on purpose: a queue that returned every
   * code would put a page of bearer instruments into a browser tab, a log and
   * a screenshot every time somebody glanced at the backlog. Reading one is a
   * deliberate act against one submission.
   */
  async revealCard(submissionUuid: string, reviewerUuid: string): Promise<{ card_code: string }> {
    await this.#assertEnabled();
    const row = await this.#byUuid(submissionUuid);
    if (row.status !== 'pending_review') {
      throw new ConflictException({ error: 'already_reviewed', status: row.status });
    }
    this.#logger.log(`reviewer ${reviewerUuid} revealed gift card ${submissionUuid}`);
    return { card_code: open(row.card_sealed, this.#keyring()) };
  }

  /**
   * Approve: pay the customer, into a hold.
   *
   * The ledger entry is written BEFORE the row is updated, deliberately. If
   * the process dies between them the submission stays `pending_review` with a
   * posted entry, and a retry replays the same idempotency key — the ledger
   * answers `replayed: true` and the row is updated. The other order would
   * mark a card approved with the customer never paid, which nothing would
   * ever detect.
   */
  async approve(submissionUuid: string, reviewerUuid: string): Promise<GiftCardView> {
    await this.#assertEnabled();
    const reviewerId = await this.#activeUserId(reviewerUuid);
    const row = await this.#byUuid(submissionUuid);

    if (row.status !== 'pending_review') {
      throw new ConflictException({ error: 'already_reviewed', status: row.status });
    }
    // Also a CHECK in the schema. Refused here as well so the reviewer gets an
    // explanation rather than a constraint violation.
    if (row.user_id === reviewerId) {
      throw new ForbiddenException({ error: 'cannot_review_own_submission' });
    }

    const currency = this.#currency(row.payout_currency);
    const payout: Money<Currency> = {
      amount: BigInt(row.payout_amount_minor),
      currency,
    };

    const posted = await this.ledger.post({
      idempotencyKey: `giftcard-approve:${row.reference}`,
      kind: 'giftcard_purchase',
      occurredAt: new Date(),
      description: `gift card purchase (${row.brand})`,
      metadata: { reference: row.reference, reviewer: reviewerUuid },
      postings: [
        // Into PENDING, not the wallet. This is the hold.
        posting(pendingAccount(row.user_id, currency), payout),
        posting({ kind: 'asset_giftcard_inventory', currency }, negate(payout)),
      ],
    });

    const holdDays = await this.settings.giftCardHoldDays();
    const holdUntil = new Date(Date.now() + holdDays * 86_400_000);

    await this.pool.query(
      `UPDATE giftcard_submissions
          SET status = 'approved', reviewed_by = $2::bigint, reviewed_at = now(),
              hold_until = $3, approval_entry_id = $4::bigint
        WHERE id = $1::bigint`,
      [row.id, reviewerId, holdUntil.toISOString(), posted.entryId],
    );

    return this.#toView(await this.#reload(row.id));
  }

  async reject(
    submissionUuid: string,
    reviewerUuid: string,
    reason: string,
  ): Promise<GiftCardView> {
    await this.#assertEnabled();
    const reviewerId = await this.#activeUserId(reviewerUuid);
    const row = await this.#byUuid(submissionUuid);

    if (row.status !== 'pending_review') {
      throw new ConflictException({ error: 'already_reviewed', status: row.status });
    }
    if (row.user_id === reviewerId) {
      throw new ForbiddenException({ error: 'cannot_review_own_submission' });
    }

    // No ledger entry, because none was ever written. A rejected card costs
    // the customer nothing and leaves no trace in their balance.
    await this.pool.query(
      `UPDATE giftcard_submissions
          SET status = 'rejected', reviewed_by = $2::bigint, reviewed_at = now(),
              rejection_reason = $3
        WHERE id = $1::bigint`,
      [row.id, reviewerId, reason],
    );

    return this.#toView(await this.#reload(row.id));
  }

  /**
   * Take the money back, while it is still held.
   *
   * By APPENDING a reversal naming the approval, never by editing it. The
   * schema refuses this once the hold has been released, and that refusal is
   * the point: after release the money may already be spent, so a clawback
   * would overdraw a customer who did nothing wrong.
   */
  async clawback(
    submissionUuid: string,
    reviewerUuid: string,
    reason: string,
  ): Promise<GiftCardView> {
    await this.#assertEnabled();
    const row = await this.#byUuid(submissionUuid);

    if (row.status !== 'approved') {
      throw new ConflictException({ error: 'not_clawable', status: row.status });
    }
    if (row.approval_entry_id === null) {
      throw new Error(`gift card ${row.id} is approved with no entry to reverse`);
    }

    const currency = this.#currency(row.payout_currency);
    const payout: Money<Currency> = { amount: BigInt(row.payout_amount_minor), currency };

    await this.ledger.post({
      idempotencyKey: `giftcard-clawback:${row.reference}`,
      kind: 'reversal',
      reversesEntryId: row.approval_entry_id,
      occurredAt: new Date(),
      description: `gift card clawed back (${row.brand})`,
      metadata: { reference: row.reference, reason, reviewer: reviewerUuid },
      postings: [
        posting(pendingAccount(row.user_id, currency), negate(payout)),
        posting({ kind: 'asset_giftcard_inventory', currency }, payout),
      ],
    });

    await this.pool.query(
      `UPDATE giftcard_submissions
          SET status = 'clawed_back', clawback_reason = $2 WHERE id = $1::bigint`,
      [row.id, reason],
    );

    return this.#toView(await this.#reload(row.id));
  }

  /* ------------------------------ helpers ------------------------------ */

  /**
   * The live rate for this card, in the band its face value falls into.
   *
   * Gift card rates genuinely differ by denomination — a $500 card is worth
   * proportionally less than a $25 one because it is harder to resell — so a
   * face value outside every published band is refused rather than quoted at
   * the nearest one.
   */
  async #liveRate(
    query: { brand: string; country: string; card_type: string; face_currency: string },
    faceMinor: bigint,
  ): Promise<RateCard> {
    const result = await this.pool.query<RateCard>(
      `SELECT id::text, brand, country, card_type, face_currency, payout_currency,
              payout_rate_minor::text, min_face_minor::text, max_face_minor::text
         FROM giftcard_rate_cards
        WHERE retired_at IS NULL
          AND brand = $1 AND country = $2 AND card_type = $3 AND face_currency = $4
          AND $5::bigint BETWEEN min_face_minor AND max_face_minor
        ORDER BY effective_from DESC
        LIMIT 1`,
      [query.brand, query.country, query.card_type, query.face_currency, faceMinor.toString()],
    );

    const rate = result.rows[0];
    if (rate === undefined) {
      throw new NotFoundException({ error: 'no_rate_for_card' });
    }
    return rate;
  }

  #keyring(): Keyring {
    const keyring = this.config.encryptionKeyring;
    if (keyring === undefined) {
      throw new ServiceUnavailableException({ error: 'encryption_not_configured' });
    }
    return keyring;
  }

  #currency(code: string): Currency {
    // The registry is the authority on what a currency is; an unknown code
    // must not reach a Money value.
    const known = ['NGN', 'USD', 'GBP', 'EUR', 'JPY', 'USDT', 'BTC'];
    if (!known.includes(code)) {
      throw new BadRequestException({ error: 'unsupported_currency', currency: code });
    }
    return code as Currency;
  }

  #parseAmount(raw: string, currency: Currency): Money<Currency> {
    let amount: Money<Currency>;
    try {
      amount = fromMajor(raw, currency);
    } catch (cause) {
      throw new BadRequestException({
        error: 'invalid_amount',
        detail: cause instanceof Error ? cause.message : undefined,
      });
    }
    if (amount.amount <= 0n) {
      throw new BadRequestException({ error: 'invalid_amount', detail: 'must be positive' });
    }
    return amount;
  }

  #toView(row: SubmissionRow): GiftCardView {
    return {
      id: row.uuid,
      brand: row.brand,
      status: row.status,
      face_amount: toMajor({
        amount: BigInt(row.face_amount_minor),
        currency: row.face_currency as Currency,
      }),
      face_currency: row.face_currency,
      payout_amount: toMajor({
        amount: BigInt(row.payout_amount_minor),
        currency: row.payout_currency as Currency,
      }),
      payout_currency: row.payout_currency,
      held_until: row.hold_until,
      rejection_reason: row.rejection_reason,
      created_at: row.created_at,
      // The card code is deliberately NOT here. A customer listing their own
      // submissions has no need of it, and a response that carries one ends up
      // cached, logged and screenshotted.
    };
  }

  async #reload(id: string): Promise<SubmissionRow> {
    const result = await this.pool.query<SubmissionRow>(
      `${SELECT_SUBMISSION} WHERE s.id = $1::bigint`,
      [id],
    );
    const row = result.rows[0];
    if (row === undefined) throw new NotFoundException({ error: 'submission_not_found' });
    return row;
  }

  async #byUuid(uuid: string): Promise<SubmissionRow> {
    const result = await this.pool.query<SubmissionRow>(
      `${SELECT_SUBMISSION} WHERE s.uuid = $1`,
      [uuid],
    );
    const row = result.rows[0];
    if (row === undefined) throw new NotFoundException({ error: 'submission_not_found' });
    return row;
  }

  async #byKey(userId: string, key: string): Promise<SubmissionRow | undefined> {
    const result = await this.pool.query<SubmissionRow>(
      `${SELECT_SUBMISSION} WHERE s.user_id = $1::bigint AND s.idempotency_key = $2`,
      [userId, key],
    );
    return result.rows[0];
  }

  async #activeUserId(uuid: string): Promise<string> {
    const result = await this.pool.query<{ id: string; status: string }>(
      `SELECT id, status FROM users WHERE uuid = $1`,
      [uuid],
    );
    const row = result.rows[0];
    if (row === undefined) throw new NotFoundException({ error: 'user_not_found' });
    if (row.status !== 'active') {
      throw new ForbiddenException({ error: 'account_not_active', status: row.status });
    }
    return row.id;
  }
}

const SELECT_SUBMISSION = `
  SELECT s.id, s.uuid, s.user_id, s.reference, r.brand, s.status,
         s.face_amount_minor, s.face_currency, s.payout_amount_minor,
         s.payout_currency, s.hold_until, s.rejection_reason, s.created_at,
         s.approval_entry_id, s.card_sealed
    FROM giftcard_submissions s
    JOIN giftcard_rate_cards r ON r.id = s.rate_card_id`;

/**
 * Derived, never generated — the same rule as a purchase reference and for the
 * same reason: the approval entry can be posted before the row that names it
 * is updated, so a retry must arrive at the same ledger idempotency key.
 */
export function referenceFor(userUuid: string, key: string): string {
  const digest = createHash('sha256').update(`giftcard:${userUuid}:${key}`).digest('hex');
  return `gc${digest.slice(0, 24)}`;
}

const pendingAccount = (userId: string, currency: Currency): AccountRef => ({
  kind: 'customer_pending',
  ownerId: userId,
  currency,
});

function negate<C extends Currency>(amount: Money<C>): Money<C> {
  return subtract({ amount: 0n, currency: amount.currency }, amount);
}
