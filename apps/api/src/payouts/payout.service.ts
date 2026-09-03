import { createHash } from 'node:crypto';
import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { InsufficientFundsError, LedgerService, posting } from '@xetral/ledger';
import { ProviderRejectedError, ProviderTimeoutError } from '@xetral/providers';
import type { PayoutBank, PayoutPort, PayoutReceipt } from '@xetral/providers';
import { applyBasisPoints, fromMajor, money, toMajor } from '@xetral/shared';
import type { Currency, Money } from '@xetral/shared';
import { DATABASE, LEDGER, PAYOUT_PORT } from '../tokens.js';
import type { LookupQuery, PayoutBody } from './dto.js';
import { AffordabilityService } from '../wallet/affordability.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { SpendingLimitService } from '../wallet/spending-limits.service.js';
import { TaxService } from '../tax/tax.service.js';
import { NotificationService } from '../notifications/notification.service.js';

/**
 * Sending money to somebody's bank account.
 *
 * THE SHAPE IS PHASE 9'S, and reusing it is the point rather than a shortcut.
 * A bank payout and an on-chain withdrawal ask the same question — money is
 * leaving, to somewhere we cannot reach into, through a provider that answers
 * slowly — so the order of operations is identical and so is the rule about a
 * timeout:
 *
 *   1. Look the beneficiary up. The BANK says who holds the account.
 *   2. Reserve amount + fee. The overdraft guard and the daily ceiling decide.
 *   3. Only then send.
 *
 * WHAT IS DIFFERENT is step 1, and it has no analogue anywhere else here. A
 * crypto address either checksums or does not; a bank account number that
 * passes every format check can still belong to a stranger. So the name shown
 * on the confirmation screen is the one the bank returned, it is stored on the
 * row, and it is what is sent to the provider — a confirmation against a name
 * the sender typed themselves confirms nothing.
 */

export interface PayoutView {
  readonly id: string;
  readonly status: string;
  readonly currency: string;
  readonly amount: string;
  readonly fee: string;
  readonly bank_name: string;
  readonly account_number: string;
  readonly account_name: string;
  readonly narration: string | null;
  readonly failure_reason: string | null;
  readonly created_at: string;
}

export interface PayoutRow {
  id: string;
  uuid: string;
  user_id: string;
  reference: string;
  status: string;
  country: string;
  bank_code: string;
  bank_name: string;
  account_number: string;
  account_name: string;
  narration: string | null;
  currency: string;
  amount_minor: string;
  fee_minor: string;
  tax_minor: string;
  provider_payout_id: string | null;
  failure_reason: string | null;
  reserve_entry_id: string;
  created_at: Date;
}

/**
 * Ours, and DERIVED rather than generated.
 *
 * The reserve entry is posted before the payout row exists, so a crash in that
 * gap leaves a retry with no row to find. A derived reference makes the retry
 * reuse the same ledger idempotency key and the ledger answers `replayed:
 * true`; a random one pays twice, only under a crash — which is the hardest
 * double payment to reproduce and the easiest to ship. 004's finding 1, on the
 * flow where the money cannot be clawed back.
 */
export function payoutReferenceFor(userUuid: string, idempotencyKey: string): string {
  const digest = createHash('sha256')
    .update(`${userUuid}:${idempotencyKey}`)
    .digest('hex')
    .slice(0, 32);
  return `xetral-payout-${digest}`;
}

@Injectable()
export class PayoutService {
  readonly #logger = new Logger(PayoutService.name);

  constructor(
    @Inject(DATABASE) private readonly pool: Pool,
    @Inject(LEDGER) private readonly ledger: LedgerService,
    @Inject(PAYOUT_PORT) private readonly port: PayoutPort,
    @Inject(AffordabilityService) private readonly affordability: AffordabilityService,
    @Inject(SettingsService) private readonly settings: SettingsService,
    @Inject(SpendingLimitService) private readonly limits: SpendingLimitService,
    @Inject(TaxService) private readonly tax: TaxService,
    @Inject(NotificationService) private readonly notifications: NotificationService,
  ) {}

  /** Banks a customer may send to. */
  async banks(country: string): Promise<readonly PayoutBank[]> {
    return this.port.banks(country);
  }

  /**
   * Who the bank says holds this account.
   *
   * NO TRANSACTION PIN, deliberately, and for the reason raising a dispute
   * takes none: nothing is destroyed by asking, and the customer most likely
   * to check a name twice is one who is being careful. It IS rate limited, by
   * the ordinary authenticated ceiling — a lookup endpoint with no limit is a
   * way to walk a bank's account space and harvest names.
   */
  async lookup(query: LookupQuery): Promise<{ account_name: string }> {
    try {
      const found = await this.port.lookup(
        query.country,
        query.bank_code,
        query.account_number,
      );
      return { account_name: found.accountName };
    } catch (error) {
      if (error instanceof ProviderRejectedError) {
        // Their refusal, relayed as "no such account" rather than as a fault.
        // A rejection is not ill health — 037's rule — and a customer's typo
        // must not count toward a provider's failure rate.
        throw new NotFoundException({ error: 'account_not_found' });
      }
      throw error;
    }
  }

  async list(userUuid: string): Promise<readonly PayoutView[]> {
    const userId = await this.#activeUserId(userUuid);
    const rows = await this.pool.query<PayoutRow>(
      `SELECT * FROM bank_payouts WHERE user_id = $1::bigint
        ORDER BY created_at DESC LIMIT 50`,
      [userId],
    );
    return rows.rows.map(toView);
  }

  /**
   * Send it.
   *
   * The provider call happens exactly once and only after the money is held.
   * Everything before it is the safety mechanism, because after it there is
   * nothing.
   */
  async send(userUuid: string, body: PayoutBody): Promise<PayoutView> {
    await this.settings.assertServiceEnabled('payouts');
    const userId = await this.#activeUserId(userUuid);
    const currency = body.currency as Currency;

    const existing = await this.#byKey(userId, body.idempotency_key);
    if (existing !== undefined) return toView(existing);

    const amount = this.#parseAmount(body.amount, currency);

    /*
     * THE NAME IS RE-FETCHED HERE, not taken from the request.
     *
     * The client has already looked it up to show a confirmation screen, and
     * it would be easy to let it pass the answer back. That would make the
     * whole control a formality: anything a client sends is something an
     * attacker with a stolen session sends too, and the point of the lookup is
     * to produce a claim the sender did not author. One extra round trip
     * against a payment that cannot be recalled is not a cost worth saving.
     */
    const beneficiary = await this.lookupOrRefuse(body);

    // The same basis-point fee a wallet transfer charges, applied to the same
    // shape. Rounded UP, stated at the call site, because every rounding
    // choice moves money to somebody and must be visible in review.
    const feeGross = applyBasisPoints(
      amount,
      await this.settings.transferFeeBasisPoints(),
      'up',
    );
    const split = await this.tax.splitFee(feeGross);
    const total = money(amount.amount + split.gross.amount, currency);

    /*
     * BEFORE the provider is asked, and it is not the pre-check CLAUDE.md
     * forbids — the overdraft guard still decides inside the ledger's own
     * transaction. This only refuses what the guard would certainly refuse,
     * and it does so without spending a round trip to reach an answer we
     * already hold. See AffordabilityService.
     */
    await this.affordability.assertWalletCanCover(userId, total);

    const reference = payoutReferenceFor(userUuid, body.idempotency_key);
    const reserved = await this.#reserve(
      userId,
      body,
      beneficiary,
      reference,
      amount,
      split,
      total,
    );

    let receipt: PayoutReceipt;
    try {
      receipt = await this.port.send({
        country: body.country,
        bankCode: body.bank_code,
        accountNumber: body.account_number,
        accountName: beneficiary.accountName,
        amount,
        narration: body.narration,
        reference,
      });
    } catch (error) {
      if (error instanceof ProviderTimeoutError) {
        /*
         * WE DO NOT KNOW. Reversing would refund a transfer that may already
         * be in the beneficiary's account; retrying would send it twice. The
         * row stays `reserved` and the reconciliation sweep ASKS — the same
         * rule as a crypto withdrawal, a purchase and an FX swap, and here it
         * is the one that protects a customer from paying their landlord
         * twice.
         */
        this.#logger.warn(
          `payout ${reference} timed out; left reserved for reconciliation`,
        );
        return toView(await this.#reload(reserved.id));
      }
      // A definite refusal. Nothing left.
      await this.fail(reserved, describe(error));
      return toView(await this.#reload(reserved.id));
    }

    await this.applyReceipt(await this.#reload(reserved.id), receipt);
    return toView(await this.#reload(reserved.id));
  }

  /** The lookup, refusing rather than guessing. Shared by the route and `send`. */
  async lookupOrRefuse(body: PayoutBody): Promise<{ accountName: string }> {
    try {
      const found = await this.port.lookup(
        body.country,
        body.bank_code,
        body.account_number,
      );
      return { accountName: found.accountName };
    } catch (error) {
      if (error instanceof ProviderRejectedError) {
        throw new NotFoundException({ error: 'account_not_found' });
      }
      throw error;
    }
  }

  /**
   * Records what the provider says happened.
   *
   * Shared by the request path and the reconciliation sweep, so both resolve a
   * payout the same way. Two copies of "how a payout settles" would drift, and
   * the copy that drifts is the one that only runs at 4am against money nobody
   * is watching — 006's finding 12.
   */
  async applyReceipt(row: PayoutRow, receipt: PayoutReceipt): Promise<void> {
    if (receipt.state === 'failed') {
      await this.fail(row, receipt.failureReason ?? 'the provider did not say');
      return;
    }

    if (row.status === 'reserved') {
      await this.#settle(row, receipt.providerPayoutId);
    }

    if (receipt.state === 'completed') {
      await this.pool.query(
        `UPDATE bank_payouts SET status = 'completed'
          WHERE id = $1::bigint AND status = 'sent'`,
        [row.id],
      );
    }
  }

  /**
   * The hold becomes a real payment: pending -> provider_float.
   *
   * The fee legs ride on the SAME entry, so a payout cannot exist without its
   * fee and a fee cannot exist without its payout. The tax is a LIABILITY and
   * never revenue — 032's rule, and both errors of getting it wrong point the
   * flattering way.
   */
  async #settle(row: PayoutRow, providerPayoutId: string): Promise<void> {
    const currency = row.currency as Currency;
    const amount = BigInt(row.amount_minor);
    const feeGross = BigInt(row.fee_minor);
    const taxMinor = BigInt(row.tax_minor);
    const feeNet = feeGross - taxMinor;

    const posted = await this.ledger.post({
      idempotencyKey: `bank-payout-settle:${row.reference}`,
      kind: 'wallet_withdrawal',
      occurredAt: new Date(),
      description: `bank payout to ${row.bank_name}`,
      metadata: { reference: row.reference, provider_payout_id: providerPayoutId },
      postings: [
        // The whole hold leaves pending...
        posting(pendingAccount(row.user_id, currency), money(-(amount + feeGross), currency)),
        // ...the payout goes to the provider...
        posting({ kind: 'provider_float', currency }, money(amount, currency)),
        // ...and the fee splits, but only where there is one. A zero-amount
        // posting is refused by the ledger, and a row saying zero is
        // indistinguishable from one somebody forgot to write.
        ...(feeNet > 0n
          ? [posting({ kind: 'revenue_fees', currency }, money(feeNet, currency))]
          : []),
        ...(taxMinor > 0n
          ? [posting({ kind: 'liability_tax_payable', currency }, money(taxMinor, currency))]
          : []),
      ],
    },
    {
      /*
       * THE RECEIPT IS WRITTEN ON THE ENTRY'S OWN TRANSACTION.
       *
       * Sending inside the transaction would mail a receipt for money that
       * then rolls back; enqueueing after it loses the message when the
       * process dies in the gap. A row written here has neither problem —
       * 012's rule, and `onEntry` is what makes it available. It must not
       * take a connection of its own: it is inside a transaction holding one,
       * and a second would deadlock the pool at `pool.max` writers.
       */
      onEntry: async (client, entry) => {
        const email = await this.#emailFor(client, row.user_id);
        if (email === undefined) return;
        await this.notifications.enqueueBestEffort(client, {
          userId: row.user_id,
          recipient: email,
          // The ledger key, reused. Inventing a second identity for the same
          // event is how the two drift apart under exactly the conditions
          // that make idempotency matter.
          idempotencyKey: `receipt:bank-payout-settle:${row.reference}`,
          request: {
            kind: 'transfer_sent',
            amount: toMajor(money(amount, currency)),
            currency,
            reference: entry.entryUuid,
          },
        });
      },
    });

    // Guarded on `status = 'reserved'`, so a redelivered receipt cannot move a
    // payout that has already settled.
    await this.pool.query(
      `UPDATE bank_payouts
          SET status = 'sent', provider_payout_id = $2, settle_entry_id = $3::bigint
        WHERE id = $1::bigint AND status = 'reserved'`,
      [row.id, providerPayoutId, posted.entryId],
    );

  }

  /** Reads on the entry's OWN connection — never taking one of its own, which
   *  inside a transaction holding one would deadlock the pool at `pool.max`. */
  async #emailFor(client: PoolClient, userId: string): Promise<string | undefined> {
    const rows = await client.query<{ email: string | null }>(
      `SELECT email FROM users WHERE id = $1::bigint`,
      [userId],
    );
    return rows.rows[0]?.email ?? undefined;
  }

  /** Gives the money back by APPENDING a reversal naming the reservation. */
  async fail(row: PayoutRow, reason: string): Promise<void> {
    const currency = row.currency as Currency;
    const total = money(BigInt(row.amount_minor) + BigInt(row.fee_minor), currency);

    await this.ledger.post({
      idempotencyKey: `bank-payout-reverse:${row.reference}`,
      kind: 'reversal',
      reversesEntryId: row.reserve_entry_id,
      occurredAt: new Date(),
      description: 'bank payout failed',
      metadata: { reference: row.reference, reason },
      postings: [
        posting(pendingAccount(row.user_id, currency), money(-total.amount, currency)),
        posting(walletAccount(row.user_id, currency), total),
      ],
    });

    await this.pool.query(
      `UPDATE bank_payouts SET status = 'failed', failure_reason = $2
        WHERE id = $1::bigint AND status IN ('reserved', 'sent')`,
      [row.id, reason],
    );
  }

  /* ------------------------------------------------------------------ */

  async #reserve(
    userId: string,
    body: PayoutBody,
    beneficiary: { accountName: string },
    reference: string,
    amount: Money<Currency>,
    split: { gross: Money<Currency>; tax: Money<Currency> },
    total: Money<Currency>,
  ): Promise<PayoutRow> {
    const currency = body.currency as Currency;

    let entryId: string;
    try {
      /*
       * The daily ceiling, as a PRECONDITION on the ledger's own transaction
       * under a per-customer advisory lock — never as a check around it. Two
       * payouts arriving together would otherwise each read the day's total,
       * each find room, and both leave.
       *
       * On the RESERVE, not the settle: by the time a payout settles it has
       * been sent, and refusing it would be a statement about money already
       * gone.
       */
      const precondition = await this.limits.precondition({
        userId,
        scope: 'transfer',
        amount: total,
        idempotencyKey: `bank-payout-reserve:${reference}`,
      });

      const posted = await this.ledger.post(
        {
          idempotencyKey: `bank-payout-reserve:${reference}`,
          kind: 'wallet_withdrawal',
          occurredAt: new Date(),
          description: `bank payout reserved`,
          metadata: { reference, bank_code: body.bank_code },
          postings: [
            posting(walletAccount(userId, currency), money(-total.amount, currency)),
            posting(pendingAccount(userId, currency), total),
          ],
        },
        precondition === undefined ? {} : { precondition },
      );
      entryId = posted.entryId;
    } catch (error) {
      if (error instanceof InsufficientFundsError) {
        // NO FIGURE. Returning "you have ₦4,300" to a caller that asked to
        // send ₦5,000 turns this into a balance oracle for a stolen session.
        throw new UnprocessableEntityException({ error: 'insufficient_funds' });
      }
      throw error;
    }

    const banks = await this.port.banks(body.country);
    const bankName =
      banks.find((bank: PayoutBank) => bank.code === body.bank_code)?.name ?? body.bank_code;

    const inserted = await this.pool.query<{ id: string }>(
      `INSERT INTO bank_payouts
         (user_id, reference, idempotency_key, country, bank_code, bank_name,
          account_number, account_name, narration, currency, amount_minor,
          fee_minor, tax_minor, reserve_entry_id)
       VALUES ($1::bigint, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::bigint,
               $12::bigint, $13::bigint, $14::bigint)
       ON CONFLICT (user_id, idempotency_key) DO NOTHING
       RETURNING id`,
      [
        userId,
        reference,
        body.idempotency_key,
        body.country,
        body.bank_code,
        bankName,
        body.account_number,
        beneficiary.accountName,
        body.narration ?? null,
        body.currency,
        amount.amount.toString(),
        split.gross.amount.toString(),
        split.tax.amount.toString(),
        entryId,
      ],
    );

    const row = inserted.rows[0];
    if (row !== undefined) return this.#reload(row.id);

    const raced = await this.#byKey(userId, body.idempotency_key);
    if (raced === undefined) throw new Error('payout insert returned no row');
    return raced;
  }

  #parseAmount(raw: string, currency: Currency): Money<Currency> {
    try {
      return fromMajor(raw, currency);
    } catch (cause) {
      throw new BadRequestException({
        error: 'invalid_amount',
        detail: cause instanceof Error ? cause.message : undefined,
      });
    }
  }

  async #activeUserId(userUuid: string): Promise<string> {
    const rows = await this.pool.query<{ id: string }>(
      `SELECT id FROM users WHERE uuid = $1::uuid AND status = 'active'`,
      [userUuid],
    );
    const row = rows.rows[0];
    if (row === undefined) throw new NotFoundException({ error: 'not_found' });
    return row.id;
  }

  async #byKey(userId: string, key: string): Promise<PayoutRow | undefined> {
    const rows = await this.pool.query<PayoutRow>(
      `SELECT * FROM bank_payouts WHERE user_id = $1::bigint AND idempotency_key = $2`,
      [userId, key],
    );
    return rows.rows[0];
  }

  async #reload(id: string): Promise<PayoutRow> {
    const rows = await this.pool.query<PayoutRow>(
      `SELECT * FROM bank_payouts WHERE id = $1::bigint`,
      [id],
    );
    const row = rows.rows[0];
    if (row === undefined) throw new NotFoundException({ error: 'not_found' });
    return row;
  }
}

function walletAccount(userId: string, currency: Currency) {
  return { kind: 'customer_wallet' as const, ownerId: userId, currency };
}

function pendingAccount(userId: string, currency: Currency) {
  return { kind: 'customer_pending' as const, ownerId: userId, currency };
}

function toView(row: PayoutRow): PayoutView {
  const currency = row.currency as Currency;
  return {
    id: row.uuid,
    status: row.status,
    currency: row.currency,
    amount: toMajor(money(BigInt(row.amount_minor), currency)),
    fee: toMajor(money(BigInt(row.fee_minor), currency)),
    bank_name: row.bank_name,
    account_number: row.account_number,
    account_name: row.account_name,
    narration: row.narration,
    failure_reason: row.failure_reason,
    created_at: row.created_at.toISOString(),
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : 'the provider refused';
}
