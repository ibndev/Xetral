import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { InsufficientFundsError, LedgerService, posting } from '@xetral/ledger';
import type { AccountRef, LedgerIntent, WrittenEntry } from '@xetral/ledger';
import { applyBasisPoints, fromMajor, subtract, toMajor } from '@xetral/shared';
import type { Currency, Money } from '@xetral/shared';
import { API_CONFIG, DATABASE, LEDGER } from '../tokens.js';
import type { ApiConfig } from '../config.js';
import { SettingsService } from '../settings/settings.service.js';
import { SpendingLimitService } from './spending-limits.service.js';
import { NotificationService } from '../notifications/notification.service.js';
import { TaxService } from '../tax/tax.service.js';
import type { TransferRequest } from './dto.js';

export interface TransferResult {
  readonly entry_id: string;
  readonly amount: string;
  readonly fee: string;
  readonly currency: string;
  readonly replayed: boolean;
}

export interface BalanceView {
  readonly currency: string;
  readonly spendable: string;
  readonly pending: string;
  readonly total: string;
}

@Injectable()
export class WalletService {
  constructor(
    @Inject(DATABASE) private readonly pool: Pool,
    @Inject(LEDGER) private readonly ledger: LedgerService,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(SettingsService) private readonly settings: SettingsService,
    @Inject(SpendingLimitService) private readonly limits: SpendingLimitService,
    @Inject(NotificationService) private readonly notifications: NotificationService,
    @Inject(TaxService) private readonly tax: TaxService,
  ) {}

  async balances(userUuid: string): Promise<readonly BalanceView[]> {
    const userId = await this.#userIdOf(userUuid);
    const balances = await this.ledger.walletBalances(userId);

    return balances.map((b) => {
      const currency = b.currency as Currency;
      return {
        currency: b.currency,
        // Formatted per currency, never with a hardcoded two decimal places.
        spendable: toMajor({ amount: b.spendableMinor, currency }),
        pending: toMajor({ amount: b.pendingMinor, currency }),
        total: toMajor({ amount: b.totalMinor, currency }),
      };
    });
  }

  async history(
    userUuid: string,
    currency: Currency,
    options: { readonly limit: number; readonly before?: string },
  ): Promise<{
    readonly entries: readonly Record<string, unknown>[];
    readonly next_cursor: string | null;
  }> {
    const userId = await this.#userIdOf(userUuid);
    const rows = await this.ledger.history(userId, currency, options);

    return {
      entries: rows.map((row) => ({
        id: row.entryUuid,
        kind: row.kind,
        description: row.description,
        amount: toMajor({ amount: row.amountMinor, currency }),
        currency: row.currency,
        occurred_at: row.occurredAt.toISOString(),
        // What later happened to it. A customer whose charge was reversed or
        // refunded previously read a debit and an unexplained credit, with
        // nothing saying the two were the same event.
        status: row.status,
        answered_by: row.answeredBy,
      })),
      next_cursor: rows.length === options.limit ? (rows[rows.length - 1]?.postingId ?? null) : null,
    };
  }

  /**
   * A customer-to-customer transfer.
   *
   * Deliberately does NOT pre-check the sender's balance. Between a check and
   * the write another request can spend the same money, so the overdraft guard
   * in the database is the only one that can be trusted — this builds the entry
   * and lets the constraint decide. A pre-check would be a second, weaker copy
   * of the same rule plus a race.
   */
  async transfer(senderUuid: string, request: TransferRequest): Promise<TransferResult> {
    const currency = request.currency;
    const amount = this.#parseAmount(request.amount, currency);

    const sender = await this.#activeUser(senderUuid);
    const recipient = await this.#recipientByIdentifier(request.recipient);

    if (recipient.id === sender.id) {
      throw new BadRequestException({ error: 'cannot_transfer_to_self' });
    }

    // Rounding is stated explicitly at the call site, because every rounding
    // choice moves money to someone and this one moves it to us. 'up' means a
    // sub-minor-unit fee is charged rather than forgone.
    // From platform_settings, so changing a fee is an audited row rather than
    // a deploy. The environment value remains the fallback for the moments
    // before the seed has run on a fresh database.
    const fee = applyBasisPoints(
      amount,
      await this.settings.transferFeeBasisPoints(),
      'up',
    );

    /*
     * PART OF THE FEE IS NOT OURS.
     *
     * VAT on a service fee is collected for the FIRS and owed to the FIRS, so
     * it goes to `liability_tax_payable` and never to `revenue_fees`. Booking
     * it as revenue overstates what the business earned and understates what
     * it owes — both errors pointing the flattering way.
     *
     * The split is INCLUSIVE by default, so the customer pays exactly what
     * they paid before and only the books change. That is what makes this safe
     * to ship without a pricing decision behind it.
     */
    const split = await this.tax.splitFee(fee);

    /*
     * The transfer levy, which is OFF by default and changes what the customer
     * pays when it is not. Whether it applies to a wallet like this one is a
     * question for a Nigerian tax adviser, so the machinery is here and the
     * decision is not.
     */
    const levy = await this.tax.levyOn(amount);

    const debit = {
      amount: amount.amount + split.gross.amount + levy.amount,
      currency,
    };

    const senderWallet: AccountRef = {
      kind: 'customer_wallet',
      ownerId: sender.id,
      currency,
    };
    const recipientWallet: AccountRef = {
      kind: 'customer_wallet',
      ownerId: recipient.id,
      currency,
    };

    const intent: LedgerIntent = {
      // Namespaced so a client-chosen key cannot collide with a provider's.
      idempotencyKey: `transfer:${request.idempotency_key}`,
      kind: 'wallet_transfer',
      occurredAt: new Date(),
      description: `transfer to ${maskIdentifier(request.recipient)}`,
      metadata: { sender_id: sender.id, recipient_id: recipient.id },
      postings: [
        posting(senderWallet, negate(debit)),
        posting(recipientWallet, amount),
        // A zero-amount posting is refused by the ledger, so each leg below
        // only exists when there is something in it. That is why the fee, the
        // tax and the levy are three conditionals rather than one: a zero-rate
        // VAT on a real fee must still post the fee.
        ...(split.net.amount > 0n
          ? [posting({ kind: 'revenue_fees', currency }, split.net)]
          : []),
        ...(split.tax.amount > 0n
          ? [posting({ kind: 'liability_tax_payable', currency }, split.tax)]
          : []),
        ...(levy.amount > 0n
          ? [posting({ kind: 'liability_tax_payable', currency }, levy)]
          : []),
      ],
    };

    // The ledger package knows nothing about HTTP, deliberately — it is used
    // by webhook handlers and jobs as well as by this controller. Translating
    // its errors is the caller's job, and this is the caller.
    //
    // The daily ceiling wraps the posting rather than preceding it, so the
    // check and the write are serialised for this customer. Note what it
    // counts: the full DEBIT, fee included, because that is what leaves the
    // wallet and what a stolen session would drain.
    //
    // The daily ceiling is a PRECONDITION on the entry rather than a check
    // around it, so it runs inside the ledger's transaction and cannot race
    // the posting it is guarding. Note what it counts: the full DEBIT, fee
    // included, because that is what leaves the wallet and what a stolen
    // session would drain.
    const precondition = await this.limits.precondition({
      userId: sender.id,
      scope: 'transfer',
      amount: debit,
      idempotencyKey: intent.idempotencyKey,
      // For the velocity rules. Stated by the caller rather than read out of
      // the intent's metadata, so the control cannot be switched off by a flow
      // that forgets a key.
      recipientId: recipient.id,
    });

    // The receipt is enqueued on the ENTRY'S OWN transaction, so a receipt
    // cannot exist for money that did not move and money cannot move without
    // one being owed. `onEntry` is deliberately not called on a replay, which
    // is exactly right here: a customer retrying a timed-out transfer must not
    // be told twice that they sent money once.
    const onEntry = async (client: PoolClient, entry: WrittenEntry): Promise<void> => {
      /*
       * WHAT WAS COLLECTED, RECORDED AGAINST WHAT MOVED IT — and on the
       * entry's own transaction, so neither half can exist without the other.
       * Written apart, the posting and the record drift, and the drift is
       * discovered while filing a return rather than by
       * `tax_remittance_drift`.
       *
       * Only what actually posted is recorded. A zero leg is not posted, so a
       * zero collection is not recorded: a row saying "we collected nothing"
       * is indistinguishable from one somebody forgot to write.
       */
      if (split.tax.amount > 0n) {
        await this.tax.record(client, {
          kind: 'vat',
          entryId: entry.entryId,
          userId: sender.id,
          amount: split.tax,
          // The fee is the base VAT was charged on, not the transfer amount.
          baseMinor: split.net.amount,
          rateApplied: `${await this.settings.vatBasisPoints()}bp`,
          occurredAt: intent.occurredAt,
        });
      }
      if (levy.amount > 0n) {
        await this.tax.record(client, {
          kind: 'transfer_levy',
          entryId: entry.entryId,
          userId: sender.id,
          amount: levy,
          // A flat levy is charged ON the transfer, so that is its base.
          baseMinor: amount.amount,
          rateApplied: 'flat',
          occurredAt: intent.occurredAt,
        });
      }

      if (sender.email === null) return;
      await this.notifications.enqueueBestEffort(client, {
        userId: sender.id,
        recipient: sender.email,
        // The ledger key, reused. It is already unique per transfer and
        // already survives a retry — inventing a second identity for the same
        // event is how the two drift apart under exactly the conditions that
        // make idempotency matter.
        idempotencyKey: `receipt:${intent.idempotencyKey}`,
        request: {
          kind: 'transfer_sent',
          amount: toMajor(amount),
          currency,
          reference: request.idempotency_key,
        },
      });
    };

    let posted;
    try {
      posted = await this.ledger.post(
        intent,
        precondition === undefined ? { onEntry } : { precondition, onEntry },
      );
    } catch (error) {
      if (error instanceof InsufficientFundsError) {
        // 422, not 400: the request was well-formed and understood, and the
        // reason it cannot be carried out is a fact about the account rather
        // than a mistake in the payload. The body carries no figure — see
        // InsufficientFundsError.
        throw new UnprocessableEntityException({ error: 'insufficient_funds' });
      }
      await this.#alertOnVelocityRefusal(sender, error);
      throw error;
    }

    return {
      entry_id: posted.entryUuid,
      amount: toMajor(amount),
      fee: toMajor(fee),
      currency,
      replayed: posted.replayed,
    };
  }

  /**
   * Tells the customer when a velocity rule refused a transfer.
   *
   * THIS IS THE POINT OF THE CONTROL, not a courtesy on top of it. A refusal a
   * customer did not cause is the first evidence they will get that somebody
   * else is signed in as them, and the rule stopping the money is worth much
   * less if nobody is told it fired.
   *
   * DETACHED, and it has to be. The precondition threw, so the ledger's
   * transaction is being rolled back — a message enqueued on that client would
   * be rolled back with it, and the alert about a blocked transfer would exist
   * only in the case where nothing was blocked.
   *
   * Keyed on the customer and the Lagos day, so an attacker hammering a
   * refused transfer sends the customer ONE email rather than turning our own
   * alerting into a mail bomb aimed at the person we are protecting.
   */
  async #alertOnVelocityRefusal(
    sender: { readonly id: string; readonly email: string | null },
    error: unknown,
  ): Promise<void> {
    if (sender.email === null) return;
    const code = velocityCodeOf(error);
    if (code === undefined) return;

    await this.notifications.enqueueDetached({
      userId: sender.id,
      recipient: sender.email,
      idempotencyKey: `velocity:${sender.id}:${code}:${lagosDay()}`,
      request: { kind: 'transfer_blocked', reason: code },
    });
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

  async #userIdOf(uuid: string): Promise<string> {
    const result = await this.pool.query<{ id: string }>(
      `SELECT id FROM users WHERE uuid = $1`,
      [uuid],
    );
    const row = result.rows[0];
    if (row === undefined) throw new NotFoundException({ error: 'user_not_found' });
    return row.id;
  }

  /**
   * Status is checked HERE, at the point of the action, and never inferred from
   * the presence of a token. A frozen account's access token stays valid until
   * it expires; freezing has to bite before the money moves, not at the next
   * refresh.
   */
  async #activeUser(uuid: string): Promise<{ id: string; email: string | null }> {
    const result = await this.pool.query<{ id: string; status: string; email: string | null }>(
      `SELECT id, status, email FROM users WHERE uuid = $1`,
      [uuid],
    );
    const row = result.rows[0];
    if (row === undefined) throw new NotFoundException({ error: 'user_not_found' });
    if (row.status !== 'active') {
      throw new ForbiddenException({ error: 'account_not_active', status: row.status });
    }
    return { id: row.id, email: row.email };
  }

  async #recipientByIdentifier(identifier: string): Promise<{ id: string }> {
    const result = await this.pool.query<{ id: string; status: string }>(
      `SELECT id, status FROM users
        WHERE lower(email) = lower($1) OR phone = $1
        LIMIT 1`,
      [identifier],
    );
    const row = result.rows[0];

    // "No such recipient" and "that recipient is closed" are the same answer.
    // Distinguishing them turns a transfer form into a way to test which phone
    // numbers belong to customers.
    if (row === undefined || row.status === 'closed') {
      throw new NotFoundException({ error: 'recipient_not_found' });
    }
    return { id: row.id };
  }
}

function negate<C extends Currency>(amount: Money<C>): Money<C> {
  return subtract({ amount: 0n, currency: amount.currency }, amount);
}

/** Keeps enough for the sender to recognise the recipient, without writing a
 *  full phone number or email into a metadata column and every log line. */
function maskIdentifier(identifier: string): string {
  if (identifier.includes('@')) {
    const [local = '', domain = ''] = identifier.split('@');
    return `${local.slice(0, 2)}***@${domain}`;
  }
  return `***${identifier.slice(-4)}`;
}

/**
 * The velocity code inside a refusal, or undefined if this was something else.
 *
 * Matched on the codes rather than on the exception class, because the
 * precondition throws from inside the ledger's transaction and only the body
 * says which rule fired. Anything unrecognised returns undefined and nobody is
 * emailed — a refusal for insufficient funds is the customer's own doing and
 * telling them somebody may be in their account would be a false alarm, which
 * is the one thing a security alert cannot afford to be.
 */
function velocityCodeOf(error: unknown): 'too_many_transfers' | 'too_many_new_recipients' | undefined {
  if (!(error instanceof UnprocessableEntityException)) return undefined;
  const response: unknown = error.getResponse();
  const code =
    typeof response === 'object' && response !== null && 'error' in response
      ? (response as { error?: unknown }).error
      : undefined;

  return code === 'too_many_transfers' || code === 'too_many_new_recipients' ? code : undefined;
}

/**
 * Today, in Lagos, as `YYYY-MM-DD`.
 *
 * The same day boundary the limits themselves use. An alert keyed on a UTC day
 * would let a second email through at 1am local, which is exactly when a drain
 * is running and exactly when a second identical email helps nobody.
 */
function lagosDay(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Lagos',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}
