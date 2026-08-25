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
import type { AccountRef, LedgerIntent } from '@xetral/ledger';
import { applyBasisPoints, fromMajor, subtract, toMajor } from '@xetral/shared';
import type { Currency, Money } from '@xetral/shared';
import { API_CONFIG, DATABASE, LEDGER } from '../tokens.js';
import type { ApiConfig } from '../config.js';
import { SettingsService } from '../settings/settings.service.js';
import { SpendingLimitService } from './spending-limits.service.js';
import { NotificationService } from '../notifications/notification.service.js';
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
    const debit = { amount: amount.amount + fee.amount, currency };

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
        // A zero-amount posting is refused by the ledger, so the fee leg only
        // exists when a fee was actually charged.
        ...(fee.amount > 0n
          ? [posting({ kind: 'revenue_fees', currency }, fee)]
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
    });

    // The receipt is enqueued on the ENTRY'S OWN transaction, so a receipt
    // cannot exist for money that did not move and money cannot move without
    // one being owed. `onEntry` is deliberately not called on a replay, which
    // is exactly right here: a customer retrying a timed-out transfer must not
    // be told twice that they sent money once.
    const onEntry = async (client: PoolClient): Promise<void> => {
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
