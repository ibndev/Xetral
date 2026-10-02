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
  UnprocessableEntityException,
} from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { InsufficientFundsError, LedgerService, posting } from '@xetral/ledger';
import {
  assertValidAddress,
  InvalidAddressError,
  providerDidNothing,
} from '@xetral/providers';
import type { CryptoNetwork, CryptoPort, WithdrawalReceipt } from '@xetral/providers';
import { fromMajor, money, toMajor } from '@xetral/shared';
import type { Currency, Money } from '@xetral/shared';
import { API_CONFIG, CRYPTO_PORT, DATABASE, LEDGER } from '../tokens.js';
import type { ApiConfig } from '../config.js';
import type { CryptoQuoteBody, WithdrawBody } from './dto.js';
import { AffordabilityService } from '../wallet/affordability.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { SpendingLimitService } from '../wallet/spending-limits.service.js';
import { NotificationService } from '../notifications/notification.service.js';

/**
 * On-chain deposits and withdrawals.
 *
 * The two halves fail in opposite directions and are designed against
 * different mistakes.
 *
 * A DEPOSIT arrives without asking us and is not final when first seen, so the
 * risk is crediting too early — handled by holding it in `customer_pending`
 * until the confirmation threshold, which is checked in the database.
 *
 * A WITHDRAWAL is irreversible the moment it is broadcast, so the risk is
 * sending at all: to a wrong address, twice, or for a fee the customer never
 * agreed to. Everything before the send is the entire safety mechanism,
 * because nothing after it exists.
 */

export interface CryptoAddressView {
  readonly asset: string;
  readonly network: string;
  readonly address: string;
  readonly memo: string | null;
}

export interface CryptoQuoteView {
  readonly asset: string;
  readonly network: string;
  readonly amount: string;
  readonly fee: string;
  readonly total: string;
  readonly expires_at: string;
}

export interface WithdrawalView {
  readonly id: string;
  readonly asset: string;
  readonly network: string;
  readonly destination: string;
  readonly amount: string;
  readonly fee: string;
  readonly status: string;
  readonly tx_hash: string | null;
  readonly failure_reason: string | null;
}

interface WithdrawalRow {
  id: string;
  uuid: string;
  user_id: string;
  reference: string;
  asset: string;
  network: string;
  destination: string;
  amount_minor: string;
  fee_minor: string;
  status: string;
  tx_hash: string | null;
  failure_reason: string | null;
  reserve_entry_id: string;
}

@Injectable()
export class CryptoService {
  readonly #logger = new Logger(CryptoService.name);

  constructor(
    @Inject(DATABASE) private readonly pool: Pool,
    @Inject(LEDGER) private readonly ledger: LedgerService,
    @Inject(CRYPTO_PORT) private readonly port: CryptoPort,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(AffordabilityService) private readonly affordability: AffordabilityService,
    @Inject(SettingsService) private readonly settings: SettingsService,
    @Inject(SpendingLimitService) private readonly limits: SpendingLimitService,
    @Inject(NotificationService) private readonly notifications: NotificationService,
  ) {}

  /** The customer's deposit address, issued once and returned for ever after. */
  async addressFor(
    userUuid: string,
    asset: Currency,
    network: CryptoNetwork,
  ): Promise<CryptoAddressView> {
    await this.settings.assertServiceEnabled('crypto');
    const userId = await this.#activeUserId(userUuid);

    const existing = await this.pool.query<{
      asset: string;
      network: string;
      address: string;
      memo: string | null;
    }>(
      `SELECT asset, network::text, address, memo FROM crypto_addresses
        WHERE user_id = $1::bigint AND asset = $2 AND network = $3::crypto_network AND active`,
      [userId, asset, network],
    );
    const found = existing.rows[0];
    if (found !== undefined) return found;

    const providerCustomerId = await this.#providerCustomerId(userId);

    const issued = await this.port.createDepositAddress({
      providerCustomerId,
      asset,
      network,
      // Derived, so a retry after a timeout asks for the same address rather
      // than opening a second place money can arrive that nobody watches.
      idempotencyKey: `xetral-cx-${userId}-${asset}-${network}`,
    });

    const inserted = await this.pool.query<{
      asset: string;
      network: string;
      address: string;
      memo: string | null;
    }>(
      `INSERT INTO crypto_addresses
         (user_id, provider, provider_address_id, asset, network, address, memo)
       VALUES ($1::bigint, $2, $3, $4, $5::crypto_network, $6, $7)
       ON CONFLICT (user_id, asset, network) WHERE (active) DO NOTHING
       RETURNING asset, network::text, address, memo`,
      [
        userId,
        this.port.provider,
        issued.providerAddressId,
        asset,
        network,
        issued.address,
        issued.memo ?? null,
      ],
    );

    const row = inserted.rows[0];
    if (row !== undefined) return row;

    // Two requests raced; the loser reads the winner's row.
    const raced = await this.pool.query<{
      asset: string;
      network: string;
      address: string;
      memo: string | null;
    }>(
      `SELECT asset, network::text, address, memo FROM crypto_addresses
        WHERE user_id = $1::bigint AND asset = $2 AND network = $3::crypto_network AND active`,
      [userId, asset, network],
    );
    const settled = raced.rows[0];
    if (settled === undefined) throw new Error('crypto address insert returned no row');
    return settled;
  }

  /** What sending would cost. Called before the customer commits, so the
   *  number they approve is the number they pay. */
  async quote(body: CryptoQuoteBody): Promise<CryptoQuoteView> {
    await this.settings.assertServiceEnabled('crypto');
    const asset = body.asset as Currency;
    const amount = this.#parseAmount(body.amount, asset);
    const quote = await this.port.quoteWithdrawal(asset, body.network, amount);

    return {
      asset: body.asset,
      network: body.network,
      amount: toMajor(amount),
      fee: toMajor(money(quote.feeMinor, asset)),
      total: toMajor(money(amount.amount + quote.feeMinor, asset)),
      expires_at: quote.expiresAt.toISOString(),
    };
  }

  async listWithdrawals(userUuid: string): Promise<readonly WithdrawalView[]> {
    const userId = await this.#activeUserId(userUuid);
    const rows = await this.pool.query<WithdrawalRow>(
      `${SELECT_WITHDRAWAL} WHERE user_id = $1::bigint ORDER BY id DESC LIMIT 100`,
      [userId],
    );
    return rows.rows.map(toView);
  }

  /**
   * Send crypto off-platform.
   *
   * THE ORDER IS THE SAFETY MECHANISM, and it is the same reserve-then-act
   * shape as a purchase, with the stakes raised: there is no provider to
   * appeal to afterwards.
   *
   *   1. Validate the address, with its checksum.
   *   2. Quote the fee and refuse if it moved past what the customer agreed.
   *   3. Reserve amount + fee. The overdraft guard decides.
   *   4. Only then send.
   */
  async withdraw(userUuid: string, body: WithdrawBody): Promise<WithdrawalView> {
    await this.settings.assertServiceEnabled('crypto');
    const userId = await this.#activeUserId(userUuid);
    const asset = body.asset as Currency;

    const existing = await this.#byKey(userId, body.idempotency_key);
    if (existing !== undefined) return refuseIfFailed(toView(existing));

    // Before anything else. A wrong address cannot be undone, and the
    // checksum is what turns a transposed character into a rejected request
    // rather than a lost balance.
    try {
      assertValidAddress(body.destination, body.network);
    } catch (error) {
      if (error instanceof InvalidAddressError) {
        throw new BadRequestException({ error: 'invalid_address', detail: error.message });
      }
      throw error;
    }

    const amount = this.#parseAmount(body.amount, asset);

    // BEFORE the quote, which is a network call to Bitnob. A customer who
    // cannot cover the amount cannot cover amount + fee either — fees are
    // never negative — so this refuses only what the overdraft guard would
    // certainly refuse, and it does so without spending a round trip or a
    // rate-limit slot to reach an answer we already held.
    //
    // The guard still decides. See AffordabilityService for why this is not
    // the pre-check CLAUDE.md forbids.
    await this.affordability.assertWalletCanCover(userId, amount);

    const quote = await this.port.quoteWithdrawal(asset, body.network, amount);

    if (body.max_fee !== undefined) {
      const ceiling = this.#parseAmount(body.max_fee, asset);
      if (quote.feeMinor > ceiling.amount) {
        // Fees move between the quote and the request. Charging past what the
        // customer approved is taking money on a technicality.
        throw new ConflictException({
          error: 'fee_moved',
          fee: toMajor(money(quote.feeMinor, asset)),
        });
      }
    }

    const reference = referenceFor(userUuid, body.idempotency_key);
    const total = money(amount.amount + quote.feeMinor, asset);

    const { row: reserved, created } = await this.#reserve(
      userId,
      body,
      reference,
      amount,
      quote.feeMinor,
      total,
    );
    /* ONLY THE REQUEST THAT WROTE THE ROW SENDS — a second submission of one
       attempt reserves as a replay and loses the row insert, and sending again
       is how one withdrawal reaches the chain twice or a duplicate refusal
       reverses the one that went. */
    if (!created) return refuseIfFailed(toView(await this.#reload(reserved.id)));

    let receipt: WithdrawalReceipt;
    try {
      receipt = await this.port.send({
        asset,
        network: body.network,
        destination: body.destination,
        memo: body.memo,
        amount,
        feeMinor: quote.feeMinor,
        reference,
      });
    } catch (error) {
      if (!providerDidNothing(error)) {
        // We do NOT know whether it was broadcast — after a timeout, and
        // equally after a 5xx, a reset or a reply we could not read. This was
        // a timeout alone, so a 502 from a gateway refunded a withdrawal that
        // could already be on a chain. Reversing could refund a transaction
        // that is gone; retrying could send twice. The row stays reserved and
        // reconciliation asks by our reference.
        this.#logger.warn(
          `withdrawal ${reference}: outcome unknown (${describe(error)}); left reserved for reconciliation`,
        );
        return toView(await this.#reload(reserved.id));
      }
      // A definite refusal, or a request that never left — nothing was broadcast.
      await this.#fail(reserved, describe(error));
      this.#logger.warn(`withdrawal ${reference} refused: ${describe(error)}`);
      return refuseIfFailed(toView(await this.#reload(reserved.id)));
    }

    await this.applyReceipt(await this.#reload(reserved.id), receipt);
    return refuseIfFailed(toView(await this.#reload(reserved.id)));
  }

  /**
   * Records what the provider says happened. Shared by the request path and
   * the reconciliation sweep, so both resolve a withdrawal the same way.
   */
  async applyReceipt(row: WithdrawalRow, receipt: WithdrawalReceipt): Promise<void> {
    if (receipt.state === 'failed') {
      await this.#fail(row, receipt.failureReason ?? 'the provider gave no reason');
      return;
    }

    if (receipt.state === 'broadcast') {
      // On a chain and unrecallable. The money stays held until it confirms.
      await this.#markBroadcast(row, receipt);
      return;
    }

    // Confirmed: the hold becomes a real spend.
    const asset = row.asset as Currency;
    const total = money(BigInt(row.amount_minor) + BigInt(row.fee_minor), asset);

    /*
     * ON THE CHAIN, AND DECIDED UNDER A LOCK ON THE ROW.
     *
     * Settling and reversing are two ledger keys, and the request path, the
     * webhook and the sweep each act on a row they read earlier. A
     * confirmation arriving after the sweep had reversed a withdrawal posted
     * its settlement anyway — out of `customer_pending`, which is shared with
     * every deposit still awaiting confirmations — and only then did 007's
     * trigger refuse the status change. The coins left and the customer was
     * refunded. Now the row is locked and re-read on the entry's own
     * transaction, a withdrawal that is not `broadcast` (or was reversed) is
     * left alone, and the status moves with the posting.
     */
    await this.#markBroadcast(row, receipt);
    let posted;
    try {
      posted = await this.ledger.post({
      idempotencyKey: `crypto-withdraw-settle:${row.reference}`,
      kind: 'crypto_withdrawal',
      occurredAt: new Date(),
      description: `${row.asset} withdrawal confirmed`,
      metadata: { reference: row.reference, tx_hash: receipt.txHash ?? '' },
      postings: [
        posting(pendingAccount(row.user_id, asset), money(-total.amount, asset)),
        posting({ kind: 'provider_float', currency: asset }, total),
      ],
    }, {
      precondition: async (client) => {
        const locked = await lockWithdrawal(client, row.id);
        if (locked.status !== 'broadcast' || locked.reversed) throw new WithdrawalDecided();
      },
      onEntry: async (client, entry) => {
        await markConfirmed(client, row.id, entry.entryId);
      },
    });
    } catch (error) {
      if (error instanceof WithdrawalDecided) return;
      throw error;
    }

    if (posted.replayed) await markConfirmed(this.pool, row.id, posted.entryId);
  }

  /**
   * Moves a withdrawal to `broadcast`, and tells the customer once.
   *
   * Both paths into this state go through here — the provider answering
   * "broadcast" and the provider answering "confirmed" without ever having
   * reported the intermediate step — so there is one place that decides what
   * broadcasting means and one place that alerts on it.
   *
   * The alert fires on the TRANSITION, which is what `rowCount` reports: the
   * UPDATE is guarded on `status = 'reserved'`, so a redelivered receipt for a
   * withdrawal already broadcast changes no rows and mails nothing. This is
   * the one outbound money movement that cannot be recalled by anybody, so it
   * is the one a customer most needs to hear about while it is happening.
   */
  async #markBroadcast(row: WithdrawalRow, receipt: WithdrawalReceipt): Promise<void> {
    const updated = await this.pool.query(
      `UPDATE crypto_withdrawals
          SET status = 'broadcast', tx_hash = COALESCE(tx_hash, $2),
              provider_reference = COALESCE(provider_reference, $3)
        WHERE id = $1::bigint AND status = 'reserved'`,
      [row.id, receipt.txHash ?? null, receipt.providerReference],
    );
    if ((updated.rowCount ?? 0) === 0) return;

    const target = await this.pool.query<{ email: string | null }>(
      `SELECT email FROM users WHERE id = $1::bigint`,
      [row.user_id],
    );
    const email = target.rows[0]?.email;
    if (email === null || email === undefined) return;

    const asset = row.asset as Currency;
    await this.notifications.enqueueDetached({
      userId: row.user_id,
      recipient: email,
      idempotencyKey: `receipt:crypto_withdrawal:${row.reference}`,
      request: {
        kind: 'crypto_withdrawal_sent',
        amount: toMajor(money(BigInt(row.amount_minor), asset)),
        asset: row.asset,
        address: row.destination,
        network: row.network,
      },
    });
  }

  /* ------------------------------------------------------------------ */

  async #reserve(
    userId: string,
    body: WithdrawBody,
    reference: string,
    amount: Money<Currency>,
    feeMinor: bigint,
    total: Money<Currency>,
  ): Promise<{ row: WithdrawalRow; created: boolean }> {
    const asset = body.asset as Currency;

    let entryId: string;
    try {
      /*
       * THE ONLY MOVEMENT HERE NOBODY CAN RECALL, and until now the only one
       * with no ceiling. The guard runs as a precondition on the ledger's own
       * transaction under a per-customer advisory lock — never as a check
       * around it — because two withdrawals arriving together would otherwise
       * each read the day's total, each find room, and both go on a chain.
       *
       * On the RESERVE, not the settle. By the time a withdrawal settles it has
       * been broadcast and refusing it would be a statement about money that
       * has already gone.
       */
      const precondition = await this.limits.precondition({
        userId,
        scope: 'crypto_withdrawal',
        amount: total,
        idempotencyKey: `crypto-withdraw-reserve:${reference}`,
      });

      const posted = await this.ledger.post(
        {
          idempotencyKey: `crypto-withdraw-reserve:${reference}`,
          kind: 'crypto_withdrawal',
          occurredAt: new Date(),
          description: `${body.asset} withdrawal reserved`,
          metadata: { reference, chain: body.network },
          postings: [
            posting(walletAccount(userId, asset), money(-total.amount, asset)),
            posting(pendingAccount(userId, asset), total),
          ],
        },
        precondition === undefined ? {} : { precondition },
      );
      entryId = posted.entryId;
    } catch (error) {
      if (error instanceof InsufficientFundsError) {
        // No figure, deliberately: the same rule as a wallet transfer. A
        // balance oracle for a stolen session is worse than a vague error.
        throw new UnprocessableEntityException({ error: 'insufficient_funds' });
      }
      throw error;
    }

    const inserted = await this.pool.query<{ id: string }>(
      `INSERT INTO crypto_withdrawals
         (user_id, reference, idempotency_key, asset, network, destination, memo,
          amount_minor, fee_minor, reserve_entry_id)
       VALUES ($1::bigint, $2, $3, $4, $5::crypto_network, $6, $7, $8::bigint, $9::bigint, $10::bigint)
       ON CONFLICT (user_id, idempotency_key) DO NOTHING
       RETURNING id`,
      [
        userId,
        reference,
        body.idempotency_key,
        body.asset,
        body.network,
        body.destination,
        body.memo ?? null,
        amount.amount.toString(),
        feeMinor.toString(),
        entryId,
      ],
    );

    const row = inserted.rows[0];
    if (row !== undefined) return { row: await this.#reload(row.id), created: true };

    const raced = await this.#byKey(userId, body.idempotency_key);
    if (raced === undefined) throw new Error('withdrawal insert returned no row');
    return { row: raced, created: false };
  }

  /** Gives the money back by appending a reversal naming the reservation. */
  async #fail(row: WithdrawalRow, reason: string): Promise<void> {
    const asset = row.asset as Currency;
    const total = money(BigInt(row.amount_minor) + BigInt(row.fee_minor), asset);

    let posted;
    try {
      posted = await this.ledger.post({
      idempotencyKey: `crypto-withdraw-reverse:${row.reference}`,
      kind: 'reversal',
      reversesEntryId: row.reserve_entry_id,
      occurredAt: new Date(),
      description: `${row.asset} withdrawal failed`,
      metadata: { reference: row.reference, reason },
      postings: [
        posting(pendingAccount(row.user_id, asset), money(-total.amount, asset)),
        posting(walletAccount(row.user_id, asset), total),
      ],
    }, {
      precondition: async (client) => {
        const locked = await lockWithdrawal(client, row.id);
        if (
          (locked.status !== 'reserved' && locked.status !== 'broadcast') ||
          locked.settled
        ) {
          throw new WithdrawalDecided();
        }
      },
      onEntry: async (client) => {
        await markWithdrawalFailed(client, row.id, reason);
      },
    });
    } catch (error) {
      if (error instanceof WithdrawalDecided) return;
      throw error;
    }

    if (posted.replayed) await markWithdrawalFailed(this.pool, row.id, reason);
  }

  #parseAmount(raw: string, asset: Currency): Money<Currency> {
    let amount: Money<Currency>;
    try {
      amount = fromMajor(raw, asset);
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

  async #reload(id: string): Promise<WithdrawalRow> {
    const result = await this.pool.query<WithdrawalRow>(
      `${SELECT_WITHDRAWAL} WHERE id = $1::bigint`,
      [id],
    );
    const row = result.rows[0];
    if (row === undefined) throw new NotFoundException({ error: 'withdrawal_not_found' });
    return row;
  }

  async #byKey(userId: string, key: string): Promise<WithdrawalRow | undefined> {
    const result = await this.pool.query<WithdrawalRow>(
      `${SELECT_WITHDRAWAL} WHERE user_id = $1::bigint AND idempotency_key = $2`,
      [userId, key],
    );
    return result.rows[0];
  }

  async #providerCustomerId(userId: string): Promise<string> {
    const result = await this.pool.query<{ provider_customer_id: string }>(
      `SELECT provider_customer_id FROM provider_customers
        WHERE user_id = $1::bigint AND provider = $2`,
      [userId, this.port.provider],
    );
    const row = result.rows[0];
    if (row === undefined) throw new ConflictException({ error: 'kyc_required', product: 'crypto' });
    return row.provider_customer_id;
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

const SELECT_WITHDRAWAL = `
  SELECT id, uuid, user_id, reference, asset, network::text, destination,
         amount_minor, fee_minor, status::text, tx_hash, failure_reason,
         reserve_entry_id
    FROM crypto_withdrawals`;

function toView(row: WithdrawalRow): WithdrawalView {
  const asset = row.asset as Currency;
  return {
    id: row.uuid,
    asset: row.asset,
    network: row.network,
    destination: row.destination,
    amount: toMajor(money(BigInt(row.amount_minor), asset)),
    fee: toMajor(money(BigInt(row.fee_minor), asset)),
    status: row.status,
    tx_hash: row.tx_hash,
    /* NEVER THE ROW'S OWN SENTENCE — the provider's words, or a reviewer's
       note, are an operator's (006). The list printed them to the customer. */
    failure_reason: row.status === 'failed' ? 'It did not go through, and your money was returned.' : null,
  };
}

/**
 * A withdrawal that failed is a REFUSAL on the request that made it, not a 200
 * carrying `status: "failed"`. Both apps read the 200 as a success and said
 * "Sent. It is on the chain now and cannot be recalled." about money that never
 * left — the bug `payout_failed` fixed for bank payouts.
 */
function refuseIfFailed(view: WithdrawalView): WithdrawalView {
  if (view.status !== 'failed') return view;
  throw new UnprocessableEntityException({ error: 'withdrawal_failed' });
}

/** Derived, never generated — the same rule as everywhere else money moves. */
export function referenceFor(userUuid: string, key: string): string {
  const digest = createHash('sha256').update(`crypto:${userUuid}:${key}`).digest('hex');
  return `cx${digest.slice(0, 24)}`;
}

const walletAccount = (userId: string, currency: Currency) =>
  ({ kind: 'customer_wallet', ownerId: userId, currency }) as const;
const pendingAccount = (userId: string, currency: Currency) =>
  ({ kind: 'customer_pending', ownerId: userId, currency }) as const;

function describe(error: unknown): string {
  return error instanceof Error ? error.message : 'the provider refused the withdrawal';
}

/** Somebody else decided this withdrawal first. Their outcome stands. */
class WithdrawalDecided extends Error {
  constructor() {
    super('the withdrawal was already decided');
  }
}

/** Locks the row on the entry's own connection and reads what the ledger
 *  already holds for it. */
async function lockWithdrawal(
  client: PoolClient,
  withdrawalId: string,
): Promise<{ status: string; settled: boolean; reversed: boolean }> {
  const found = await client.query<{ status: string; settled: boolean; reversed: boolean }>(
    `SELECT w.status::text AS status,
            EXISTS (SELECT 1 FROM journal_entries e
                     WHERE e.idempotency_key = 'crypto-withdraw-settle:' || w.reference) AS settled,
            EXISTS (SELECT 1 FROM journal_entries e
                     WHERE e.idempotency_key = 'crypto-withdraw-reverse:' || w.reference) AS reversed
       FROM crypto_withdrawals w
      WHERE w.id = $1::bigint
        FOR UPDATE OF w`,
    [withdrawalId],
  );
  const row = found.rows[0];
  if (row === undefined) throw new NotFoundException({ error: 'not_found' });
  return row;
}

async function markConfirmed(db: Pool | PoolClient, withdrawalId: string, entryId: string): Promise<void> {
  await db.query(
    `UPDATE crypto_withdrawals
        SET status = 'confirmed', settle_entry_id = $2::bigint
      WHERE id = $1::bigint AND status = 'broadcast'`,
    [withdrawalId, entryId],
  );
}

async function markWithdrawalFailed(db: Pool | PoolClient, withdrawalId: string, reason: string): Promise<void> {
  await db.query(
    `UPDATE crypto_withdrawals SET status = 'failed', failure_reason = $2
      WHERE id = $1::bigint AND status IN ('reserved', 'broadcast')`,
    [withdrawalId, reason],
  );
}
