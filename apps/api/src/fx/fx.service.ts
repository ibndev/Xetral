import { createHash } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { Pool } from 'pg';
import { InsufficientFundsError, LedgerService, posting } from '@xetral/ledger';
import type { PostingIntent } from '@xetral/ledger';
import { convertWithSpread, displayRate, ProviderTimeoutError } from '@xetral/providers';
import type { FxPort, FxRate } from '@xetral/providers';
import { exponentOf, fromMajor, money, toMajor } from '@xetral/shared';
import type { Currency, Money } from '@xetral/shared';
import { API_CONFIG, DATABASE, FX_PORT, LEDGER } from '../tokens.js';
import type { ApiConfig } from '../config.js';
import type { ConvertBody, FxQuoteBody } from './dto.js';
import { PublishedRateService } from './published-rate.service.js';
import { AffordabilityService } from '../wallet/affordability.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { SpendingLimitService } from '../wallet/spending-limits.service.js';

/**
 * Converting between currencies, and sending across them.
 *
 * ONE JOURNAL ENTRY, TWO CURRENCIES. This is the first flow that spans two,
 * and it is exactly what Phase 1's per-currency balance invariant was written
 * for: each currency sums to zero on its own, so a mistake in kobo cannot be
 * cancelled out by an opposite mistake in cents.
 *
 *   NGN legs:  wallet -X,  provider_float +(X - spread),  revenue_fx_spread +spread
 *   USD legs:  provider_float -Y,  wallet +Y
 *
 * There is no `reserved` state, unlike a purchase. The provider swap and the
 * ledger entry both complete or the request fails — and the ordering is
 * deliberate: the provider is asked FIRST, because a swap we cannot fund is a
 * refusal, while a ledger entry for a swap that did not happen is a lie.
 */

export interface FxQuoteView {
  readonly from: string;
  readonly to: string;
  readonly amount: string;
  readonly receives: string;
  readonly spread: string;
  readonly rate: string;
  readonly expires_at: string;
}

export interface FxTradeView {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly amount: string;
  readonly received: string;
  readonly spread: string;
  readonly recipient: string | null;
  readonly created_at: string;
}

interface TradeRow {
  id: string;
  uuid: string;
  base_currency: string;
  base_minor: string;
  quote_currency: string;
  quote_minor: string;
  spread_minor: string;
  recipient_email: string | null;
  created_at: string;
}

interface SpreadPolicy {
  id: string;
  spread_basis_points: number;
  min_base_minor: string;
}

@Injectable()
export class FxService {
  readonly #logger = new Logger(FxService.name);

  constructor(
    @Inject(DATABASE) private readonly pool: Pool,
    @Inject(LEDGER) private readonly ledger: LedgerService,
    @Inject(FX_PORT) private readonly port: FxPort,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(AffordabilityService) private readonly affordability: AffordabilityService,
    @Inject(SettingsService) private readonly settings: SettingsService,
    @Inject(SpendingLimitService) private readonly limits: SpendingLimitService,
    @Inject(PublishedRateService) private readonly published: PublishedRateService,
  ) {}

  /**
   * OUR RATE IF WE HAVE PUBLISHED ONE, otherwise the provider's.
   *
   * The order is the decision. A pair we price is a pair we are the
   * counterparty for — there is nobody to ask — and a pair we have not priced
   * is one a provider quotes, exactly as before. Reversing this would let a
   * provider's number override a price an operator deliberately set, which is
   * the opposite of what publishing one means.
   */
  async #rateFor(from: Currency, to: Currency): Promise<{ rate: FxRate; ours: boolean }> {
    const ours = await this.published.rateFor(from, to);
    if (ours !== undefined) return { rate: ours, ours: true };
    return { rate: await this.port.rate(from, to), ours: false };
  }

  async quote(body: FxQuoteBody): Promise<FxQuoteView> {
    await this.settings.assertServiceEnabled('fx');
    const from = body.from as Currency;
    const to = body.to as Currency;
    if (from === to) throw new BadRequestException({ error: 'same_currency' });

    const amount = this.#parseAmount(body.amount, from);
    const policy = await this.#policy(from, to);

    if (amount.amount < BigInt(policy.min_base_minor)) {
      throw new UnprocessableEntityException({
        error: 'below_minimum',
        minimum: toMajor(money(BigInt(policy.min_base_minor), from)),
      });
    }

    const { rate } = await this.#rateFor(from, to);
    const converted = this.#convert(amount, rate, policy.spread_basis_points);

    return {
      from: body.from,
      to: body.to,
      amount: toMajor(amount),
      receives: toMajor(money(converted.quoteMinor, to)),
      spread: toMajor(money(converted.spreadMinor, from)),
      // The EFFECTIVE rate the customer got, spread included — the number that
      // describes what happened to their money, not the market mid.
      rate: effectiveRate(converted.quoteMinor, amount.amount, from, to),
      expires_at: rate.expiresAt.toISOString(),
    };
  }

  async list(userUuid: string): Promise<readonly FxTradeView[]> {
    const userId = await this.#activeUserId(userUuid);
    const rows = await this.pool.query<TradeRow>(
      `SELECT t.id, t.uuid, t.base_currency, t.base_minor, t.quote_currency,
              t.quote_minor, t.spread_minor, r.email AS recipient_email, t.created_at
         FROM fx_trades t
         LEFT JOIN users r ON r.id = t.recipient_user_id
        WHERE t.user_id = $1::bigint
        ORDER BY t.id DESC LIMIT 100`,
      [userId],
    );
    return rows.rows.map(toView);
  }

  /**
   * Convert, or remit.
   *
   * A remittance is the same trade with the quote-currency leg credited to
   * somebody else. It is deliberately not a conversion followed by a transfer:
   * two entries would leave a window in which the money exists in a wallet the
   * sender never meant to hold it in, and a crash in that window strands it
   * there.
   */
  /**
   * ONE implementation for converting and remitting, because they are the same
   * entry with one leg pointed elsewhere. Two copies of these postings would be
   * two sets of assumptions about the ledger, and a remittance is ONE entry
   * precisely so a crash cannot strand money in a wallet the sender never meant
   * to hold.
   *
   * What differs is the ROUTE, not the arithmetic: converting declares
   * `pin: false` and its schema has no recipient, remitting declares
   * `pin: true` and requires one. See `dto.ts`.
   */
  async convert(
    userUuid: string,
    body: ConvertBody & { readonly recipient?: string },
  ): Promise<FxTradeView> {
    await this.settings.assertServiceEnabled('fx');
    const userId = await this.#activeUserId(userUuid);
    const from = body.from as Currency;
    const to = body.to as Currency;
    if (from === to) throw new BadRequestException({ error: 'same_currency' });

    const existing = await this.#byKey(userId, body.idempotency_key);
    if (existing !== undefined) return toView(existing);

    const amount = this.#parseAmount(body.amount, from);
    const policy = await this.#policy(from, to);

    if (amount.amount < BigInt(policy.min_base_minor)) {
      throw new UnprocessableEntityException({
        error: 'below_minimum',
        minimum: toMajor(money(BigInt(policy.min_base_minor), from)),
      });
    }

    const recipientId =
      body.recipient === undefined ? undefined : await this.#recipientId(body.recipient, userId);

    // BEFORE the rate call. The base amount is what leaves the wallet — the
    // spread comes off it rather than being added to it — so a wallet that
    // cannot cover the amount cannot cover the trade, whatever the rate turns
    // out to be. Refusing here costs a customer with an empty wallet nothing
    // but the truth, immediately, instead of two seconds of spinner and a
    // provider round trip to reach the same answer.
    //
    // The overdraft guard still decides at write time. See
    // AffordabilityService for why this is not the forbidden pre-check.
    await this.affordability.assertWalletCanCover(userId, amount);

    const { rate, ours } = await this.#rateFor(from, to);
    const converted = this.#convert(amount, rate, policy.spread_basis_points);

    if (body.min_received !== undefined) {
      const floor = this.#parseAmount(body.min_received, to);
      if (converted.quoteMinor < floor.amount) {
        // Rates move between quote and request. Delivering materially less
        // than the customer accepted is taking the difference on a
        // technicality.
        throw new ConflictException({
          error: 'rate_moved',
          receives: toMajor(money(converted.quoteMinor, to)),
        });
      }
    }

    const reference = referenceFor(userUuid, body.idempotency_key);

    /*
     * THE PROVIDER FIRST — WHERE THERE IS ONE.
     *
     * A swap we cannot fund is a refusal the customer can be told about; a
     * ledger entry for a swap that never happened is a lie reconciliation has
     * to unpick later. That ordering is unchanged for every pair a provider
     * quotes.
     *
     * A PAIR WE PRICED HAS NO PROVIDER TO ASK. Publishing a rate is the
     * decision to be the counterparty: the swap is settled out of our own
     * float in both currencies, which is exactly what the postings below
     * already do. Calling `port.convert` here would ask Bitnob to execute an
     * NGN→GHS trade it does not offer, and the refusal would arrive as
     * `fx_failed` on the one corridor an operator had just gone to the
     * trouble of pricing.
     *
     * The fill is then the quote, because we are the one filling it.
     */
    let execution: { filledQuoteMinor: bigint } | undefined;
    if (ours) {
      execution = { filledQuoteMinor: converted.quoteMinor };
    } else {
    try {
      execution = await this.port.convert(from, to, amount, reference);
    } catch (error) {
      if (error instanceof ProviderTimeoutError) {
        // We do not know whether the swap happened. Posting would risk
        // crediting a customer twice on retry; not posting risks a swap we
        // paid for and did not pass on. The trade is NOT recorded, and the
        // provider's own reference — derived from ours — makes a retry
        // idempotent on their side.
        this.#logger.warn(`fx trade ${reference} timed out; not recorded`);
        throw new ConflictException({ error: 'fx_outcome_unknown', reference });
      }
      throw new UnprocessableEntityException({ error: 'fx_failed', detail: describe(error) });
    }
    }

    // Believe the numbers over the label: the provider says what it actually
    // filled, and the customer receives that rather than the quote.
    const receivedMinor =
      execution.filledQuoteMinor < converted.quoteMinor
        ? execution.filledQuoteMinor
        : converted.quoteMinor;

    const trade = await this.#post(
      userId,
      recipientId,
      body,
      reference,
      amount,
      money(receivedMinor, to),
      converted.spreadMinor,
      policy,
      converted.appliedNumerator,
      converted.appliedDenominator,
    );

    return toView(trade);
  }

  /* ------------------------------------------------------------------ */

  /** Builds and posts the two-currency entry, then records the trade. */
  async #post(
    userId: string,
    recipientId: string | undefined,
    body: ConvertBody,
    reference: string,
    sold: Money<Currency>,
    received: Money<Currency>,
    spreadMinor: bigint,
    policy: SpreadPolicy,
    numerator: bigint,
    denominator: bigint,
  ): Promise<TradeRow> {
    const from = sold.currency;
    const to = received.currency;
    const creditedTo = recipientId ?? userId;

    const postings: PostingIntent[] = [
      // BASE side. Split three ways so the margin is visible as revenue rather
      // than hidden inside what the provider was paid.
      posting(wallet(userId, from), money(-sold.amount, from)),
      posting({ kind: 'provider_float', currency: from }, money(sold.amount - spreadMinor, from)),
      // QUOTE side.
      posting({ kind: 'provider_float', currency: to }, money(-received.amount, to)),
      posting(wallet(creditedTo, to), received),
    ];

    // A zero-amount posting is refused by the ledger, so a zero spread must
    // produce no leg at all rather than a leg of nothing.
    if (spreadMinor > 0n) {
      postings.splice(2, 0, posting({ kind: 'revenue_fx_spread', currency: from }, money(spreadMinor, from)));
    }

    let entryId: string;
    try {
      /*
       * Capped on `sold` — the BASE amount, what actually leaves the wallet —
       * rather than on what arrives. The kobo ceiling therefore applies to a
       * conversion out of naira and is skipped in the other direction, which is
       * the same rule every other kobo limit here follows. The hourly COUNT
       * applies either way, because a count carries no units.
       *
       * A precondition on the entry's own transaction, not a check around it:
       * two conversions arriving together would each find room and both post.
       */
      const precondition = await this.limits.precondition({
        userId,
        scope: 'fx',
        amount: sold,
        idempotencyKey: `fx-trade:${reference}`,
      });

      const posted = await this.ledger.post(
        {
          idempotencyKey: `fx-trade:${reference}`,
          kind: 'fx_trade',
          occurredAt: new Date(),
          description: `${from} -> ${to}${recipientId === undefined ? '' : ' (remittance)'}`,
          metadata: { reference, from, to },
          postings,
        },
        precondition === undefined ? {} : { precondition },
      );
      entryId = posted.entryId;
    } catch (error) {
      if (error instanceof InsufficientFundsError) {
        // No figure — the same rule as a wallet transfer.
        throw new UnprocessableEntityException({ error: 'insufficient_funds' });
      }
      throw error;
    }

    const inserted = await this.pool.query<{ id: string }>(
      `INSERT INTO fx_trades
         (user_id, reference, idempotency_key, base_currency, base_minor,
          quote_currency, quote_minor, rate_numerator, rate_denominator,
          spread_minor, spread_policy_id, recipient_user_id, entry_id)
       VALUES ($1::bigint, $2, $3, $4, $5::bigint, $6, $7::bigint, $8::bigint,
               $9::bigint, $10::bigint, $11::bigint, $12::bigint, $13::bigint)
       ON CONFLICT (user_id, idempotency_key) DO NOTHING
       RETURNING id`,
      [
        userId,
        reference,
        body.idempotency_key,
        from,
        sold.amount.toString(),
        to,
        received.amount.toString(),
        numerator.toString(),
        denominator.toString(),
        spreadMinor.toString(),
        policy.id,
        recipientId ?? null,
        entryId,
      ],
    );

    const row = inserted.rows[0];
    if (row !== undefined) return this.#reload(row.id);

    const raced = await this.#byKey(userId, body.idempotency_key);
    if (raced === undefined) throw new Error('fx trade insert returned no row');
    return raced;
  }

  #convert(
    amount: Money<Currency>,
    rate: FxRate,
    spreadBasisPoints: number,
  ): ReturnType<typeof convertWithSpread> {
    try {
      return convertWithSpread(amount, rate, spreadBasisPoints);
    } catch (error) {
      if (error instanceof RangeError) {
        throw new UnprocessableEntityException({ error: 'not_convertible', detail: error.message });
      }
      throw error;
    }
  }

  async #policy(from: Currency, to: Currency): Promise<SpreadPolicy> {
    const result = await this.pool.query<SpreadPolicy>(
      `SELECT id::text, spread_basis_points, min_base_minor::text
         FROM fx_spread_policies
        WHERE base_currency = $1 AND quote_currency = $2 AND retired_at IS NULL`,
      [from, to],
    );
    const row = result.rows[0];
    if (row === undefined) {
      // No published price means we do not trade this pair. Quoting one from
      // a default would be inventing a price nobody reviewed.
      throw new NotFoundException({ error: 'pair_not_supported', pair: `${from}/${to}` });
    }
    return row;
  }

  async #recipientId(identifier: string, senderId: string): Promise<string> {
    const result = await this.pool.query<{ id: string; status: string }>(
      `SELECT id, status FROM users WHERE lower(email) = lower($1)`,
      [identifier],
    );
    const row = result.rows[0];
    if (row === undefined) throw new NotFoundException({ error: 'recipient_not_found' });
    if (row.status !== 'active') {
      throw new UnprocessableEntityException({ error: 'recipient_not_active' });
    }
    if (row.id === senderId) {
      // Also a CHECK in the schema. Refused here so the customer gets an
      // explanation rather than a constraint violation.
      throw new BadRequestException({ error: 'recipient_is_sender' });
    }
    return row.id;
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

  async #reload(id: string): Promise<TradeRow> {
    const result = await this.pool.query<TradeRow>(
      `SELECT t.id, t.uuid, t.base_currency, t.base_minor, t.quote_currency,
              t.quote_minor, t.spread_minor, r.email AS recipient_email, t.created_at
         FROM fx_trades t LEFT JOIN users r ON r.id = t.recipient_user_id
        WHERE t.id = $1::bigint`,
      [id],
    );
    const row = result.rows[0];
    if (row === undefined) throw new NotFoundException({ error: 'trade_not_found' });
    return row;
  }

  async #byKey(userId: string, key: string): Promise<TradeRow | undefined> {
    const result = await this.pool.query<TradeRow>(
      `SELECT t.id, t.uuid, t.base_currency, t.base_minor, t.quote_currency,
              t.quote_minor, t.spread_minor, r.email AS recipient_email, t.created_at
         FROM fx_trades t LEFT JOIN users r ON r.id = t.recipient_user_id
        WHERE t.user_id = $1::bigint AND t.idempotency_key = $2`,
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

function toView(row: TradeRow): FxTradeView {
  const base = row.base_currency as Currency;
  const quote = row.quote_currency as Currency;
  return {
    id: row.uuid,
    from: row.base_currency,
    to: row.quote_currency,
    amount: toMajor(money(BigInt(row.base_minor), base)),
    received: toMajor(money(BigInt(row.quote_minor), quote)),
    spread: toMajor(money(BigInt(row.spread_minor), base)),
    recipient: row.recipient_email,
    created_at: row.created_at,
  };
}

/**
 * How many major units of `to` per one major unit of `from`, for display.
 *
 * DELEGATES TO `displayRate`, and used to be a second copy of it. Both did
 * `Number(a) / Number(b)` then `toFixed(2)`, and both were wrong the same way:
 * USD per naira is 0.000606, which two decimal places renders as **"0.00"** —
 * so a customer converting naira to dollars was shown a rate of zero.
 *
 * Two copies of one calculation is the thing this codebase says not to do, and
 * this is why: they drifted into being wrong together, and fixing one would
 * have left the other. All rate arithmetic lives in `fx/rate-math.ts`.
 */
function effectiveRate(
  quoteMinor: bigint,
  baseMinor: bigint,
  from: Currency,
  to: Currency,
): string {
  return displayRate(
    {
      base: from,
      quote: to,
      numerator: quoteMinor,
      denominator: baseMinor,
      // Not read by `displayRate`; the shape is the port's and this is a
      // rendering of an executed conversion rather than a live quote.
      expiresAt: new Date(0),
    },
    exponentOf(from),
    exponentOf(to),
  );
}

/** Derived, never generated — the same rule as everywhere else money moves. */
export function referenceFor(userUuid: string, key: string): string {
  const digest = createHash('sha256').update(`fx:${userUuid}:${key}`).digest('hex');
  return `fx${digest.slice(0, 24)}`;
}

const wallet = (userId: string, currency: Currency) =>
  ({ kind: 'customer_wallet', ownerId: userId, currency }) as const;

function describe(error: unknown): string {
  return error instanceof Error ? error.message : 'the provider refused the conversion';
}
