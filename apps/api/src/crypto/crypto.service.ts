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
import type { Pool } from 'pg';
import { InsufficientFundsError, LedgerService, posting } from '@xetral/ledger';
import { assertValidAddress, InvalidAddressError, ProviderTimeoutError } from '@xetral/providers';
import type { CryptoNetwork, CryptoPort, WithdrawalReceipt } from '@xetral/providers';
import { fromMajor, money, toMajor } from '@xetral/shared';
import type { Currency, Money } from '@xetral/shared';
import { API_CONFIG, CRYPTO_PORT, DATABASE, LEDGER } from '../tokens.js';
import type { ApiConfig } from '../config.js';
import type { CryptoQuoteBody, WithdrawBody } from './dto.js';
import { AffordabilityService } from '../wallet/affordability.service.js';

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
    private readonly affordability: AffordabilityService,
  ) {}

  /** The customer's deposit address, issued once and returned for ever after. */
  async addressFor(
    userUuid: string,
    asset: Currency,
    network: CryptoNetwork,
  ): Promise<CryptoAddressView> {
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
    const userId = await this.#activeUserId(userUuid);
    const asset = body.asset as Currency;

    const existing = await this.#byKey(userId, body.idempotency_key);
    if (existing !== undefined) return toView(existing);

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

    const reserved = await this.#reserve(userId, body, reference, amount, quote.feeMinor, total);

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
      if (error instanceof ProviderTimeoutError) {
        // We do NOT know whether it was broadcast. Reversing could refund a
        // transaction that is already on a chain and gone; retrying could send
        // twice. The row stays reserved and reconciliation asks.
        this.#logger.warn(
          `withdrawal ${reference} timed out; left reserved for reconciliation`,
        );
        return toView(await this.#reload(reserved.id));
      }
      // A definite refusal — nothing was broadcast.
      await this.#fail(reserved, describe(error));
      return toView(await this.#reload(reserved.id));
    }

    await this.applyReceipt(await this.#reload(reserved.id), receipt);
    return toView(await this.#reload(reserved.id));
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
      await this.pool.query(
        `UPDATE crypto_withdrawals
            SET status = 'broadcast', tx_hash = COALESCE(tx_hash, $2),
                provider_reference = COALESCE(provider_reference, $3)
          WHERE id = $1::bigint AND status = 'reserved'`,
        [row.id, receipt.txHash ?? null, receipt.providerReference],
      );
      return;
    }

    // Confirmed: the hold becomes a real spend.
    const asset = row.asset as Currency;
    const total = money(BigInt(row.amount_minor) + BigInt(row.fee_minor), asset);

    const posted = await this.ledger.post({
      idempotencyKey: `crypto-withdraw-settle:${row.reference}`,
      kind: 'crypto_withdrawal',
      occurredAt: new Date(),
      description: `${row.asset} withdrawal confirmed`,
      metadata: { reference: row.reference, tx_hash: receipt.txHash ?? '' },
      postings: [
        posting(pendingAccount(row.user_id, asset), money(-total.amount, asset)),
        posting({ kind: 'provider_float', currency: asset }, total),
      ],
    });

    await this.pool.query(
      `UPDATE crypto_withdrawals
          SET status = 'broadcast', tx_hash = COALESCE(tx_hash, $2),
              provider_reference = COALESCE(provider_reference, $3)
        WHERE id = $1::bigint AND status = 'reserved'`,
      [row.id, receipt.txHash ?? null, receipt.providerReference],
    );
    await this.pool.query(
      `UPDATE crypto_withdrawals
          SET status = 'confirmed', settle_entry_id = $2::bigint
        WHERE id = $1::bigint AND status = 'broadcast'`,
      [row.id, posted.entryId],
    );
  }

  /* ------------------------------------------------------------------ */

  async #reserve(
    userId: string,
    body: WithdrawBody,
    reference: string,
    amount: Money<Currency>,
    feeMinor: bigint,
    total: Money<Currency>,
  ): Promise<WithdrawalRow> {
    const asset = body.asset as Currency;

    let entryId: string;
    try {
      const posted = await this.ledger.post({
        idempotencyKey: `crypto-withdraw-reserve:${reference}`,
        kind: 'crypto_withdrawal',
        occurredAt: new Date(),
        description: `${body.asset} withdrawal reserved`,
        metadata: { reference, chain: body.network },
        postings: [
          posting(walletAccount(userId, asset), money(-total.amount, asset)),
          posting(pendingAccount(userId, asset), total),
        ],
      });
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
    if (row !== undefined) return this.#reload(row.id);

    const raced = await this.#byKey(userId, body.idempotency_key);
    if (raced === undefined) throw new Error('withdrawal insert returned no row');
    return raced;
  }

  /** Gives the money back by appending a reversal naming the reservation. */
  async #fail(row: WithdrawalRow, reason: string): Promise<void> {
    const asset = row.asset as Currency;
    const total = money(BigInt(row.amount_minor) + BigInt(row.fee_minor), asset);

    await this.ledger.post({
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
    });

    await this.pool.query(
      `UPDATE crypto_withdrawals SET status = 'failed', failure_reason = $2
        WHERE id = $1::bigint AND status IN ('reserved', 'broadcast')`,
      [row.id, reason],
    );
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
    if (row === undefined) throw new ConflictException({ error: 'kyc_required' });
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
    failure_reason: row.failure_reason,
  };
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
