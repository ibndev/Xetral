import { Inject, Injectable, Logger } from '@nestjs/common';
import type { OnApplicationShutdown } from '@nestjs/common';
import type { Pool } from 'pg';
import { LedgerService, posting } from '@xetral/ledger';
import type { CryptoPort, ProviderCryptoDeposit } from '@xetral/providers';
import { money } from '@xetral/shared';
import type { Currency } from '@xetral/shared';
import { API_CONFIG, CRYPTO_PORT, DATABASE, LEDGER } from '../tokens.js';
import type { ApiConfig } from '../config.js';

/**
 * Finding crypto deposits whose webhook never arrived.
 *
 * THE GAP THIS CLOSES. Withdrawals had a sweep from the day they shipped;
 * deposits did not. A deposit webhook that is lost is money sitting on a chain
 * that never reaches a balance — the customer sent it, the block confirmed it,
 * the provider recorded it, and nothing in Xetral would ever notice. Waiting
 * does not help because nothing is retrying. The only remedy is to ASK, which
 * is what `DepositReconciliationService` does for naira and what this does for
 * chains.
 *
 * TWO PHASES, LIKE THE WEBHOOK. A deposit is `seen` when the provider first
 * reports it and `confirmed` once it has enough confirmations for the chain.
 * The sweep must be able to enter at either point, because the lost event
 * could have been either: it credits the unspendable pending balance for a
 * deposit it has never heard of, and separately promotes a deposit already
 * held whose confirmation event went missing.
 *
 * IT ONLY EVER ADDS. A deposit we recorded and the provider has since stopped
 * reporting is a reorg question for a person, not a reversal for a worker
 * running at 4am against money nobody is watching.
 */

/* Distinct from the other sweeps' keys so two different workers cannot lock
   each other out. */
const SWEEP_LOCK_KEY = 8_264_100_005;

export interface CryptoDepositSweepReport {
  readonly addressesChecked: number;
  /** Deposits credited to pending that we had never heard of. */
  readonly seen: number;
  /** Deposits promoted from pending to spendable. */
  readonly confirmed: number;
  readonly failed: number;
}

interface AddressRow {
  id: string;
  user_id: string;
  address: string;
  asset: string;
  network: string;
}

interface DepositRow {
  id: string;
  status: string;
  required_confirmations: number;
  amount_minor: string;
  asset: string;
}

@Injectable()
export class CryptoDepositReconciliationService implements OnApplicationShutdown {
  readonly #logger = new Logger(CryptoDepositReconciliationService.name);
  #timer: NodeJS.Timeout | undefined;

  constructor(
    @Inject(DATABASE) private readonly pool: Pool,
    @Inject(LEDGER) private readonly ledger: LedgerService,
    @Inject(CRYPTO_PORT) private readonly port: CryptoPort,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
  ) {}

  start(): void {
    const everySeconds = this.config.cryptoDepositReconcileIntervalSeconds;
    if (everySeconds === undefined) {
      this.#logger.warn(
        'CRYPTO_DEPOSIT_RECONCILE_INTERVAL_SECONDS is not set: a lost crypto deposit ' +
          'webhook will never be noticed by this instance, and the money will sit on a ' +
          'chain without ever reaching a balance. Exactly one instance must set it.',
      );
      return;
    }

    this.#logger.log(`re-checking crypto deposits every ${everySeconds}s`);
    this.#timer = setInterval(() => {
      void this.sweep().catch((error: unknown) => {
        this.#logger.error(`crypto deposit sweep failed: ${describe(error)}`);
      });
    }, everySeconds * 1000);
    this.#timer.unref();
  }

  onApplicationShutdown(): void {
    if (this.#timer !== undefined) clearInterval(this.#timer);
  }

  /**
   * One pass.
   *
   * A session advisory lock rather than `SELECT ... FOR UPDATE SKIP LOCKED`:
   * `pool.query` runs each statement in its own implicit transaction, so those
   * row locks would be released the moment the claim query returned — before a
   * single provider had been asked — while reading in review as though they
   * guarded the work that follows.
   */
  async sweep(): Promise<CryptoDepositSweepReport> {
    const lock = await this.pool.connect();
    try {
      const acquired = await lock.query<{ ok: boolean }>(
        `SELECT pg_try_advisory_lock($1::bigint) AS ok`,
        [SWEEP_LOCK_KEY],
      );
      if (acquired.rows[0]?.ok !== true) {
        // Another instance is already sweeping. Duplicate sweeps are safe —
        // the shared idempotency key makes a repeat posting a replay — but
        // asking a provider about the same address from four processes is
        // rate-limited at best.
        return { addressesChecked: 0, seen: 0, confirmed: 0, failed: 0 };
      }
      try {
        return await this.#sweepLocked();
      } finally {
        await lock.query(`SELECT pg_advisory_unlock($1::bigint)`, [SWEEP_LOCK_KEY]);
      }
    } finally {
      lock.release();
    }
  }

  async #sweepLocked(): Promise<CryptoDepositSweepReport> {
    const addresses = await this.pool.query<AddressRow>(
      `SELECT id, user_id, address, asset, network::text AS network
         FROM crypto_addresses
        WHERE provider = $1
        ORDER BY id LIMIT 500`,
      [this.port.provider],
    );

    let seen = 0;
    let confirmed = 0;
    let failed = 0;

    for (const address of addresses.rows) {
      try {
        const result = await this.#reconcile(address);
        seen += result.seen;
        confirmed += result.confirmed;
      } catch (error) {
        // One unreachable address must not stop the sweep. An outage is not a
        // failed deposit — the row keeps whatever state it has and the next
        // pass asks again.
        failed += 1;
        this.#logger.warn(`could not re-check address ${address.address}: ${describe(error)}`);
      }
    }

    if (seen > 0 || confirmed > 0) {
      this.#logger.warn(
        `crypto reconciliation credited ${seen} unseen deposit(s) and confirmed ` +
          `${confirmed} — check webhook delivery`,
      );
    }
    return { addressesChecked: addresses.rows.length, seen, confirmed, failed };
  }

  async #reconcile(address: AddressRow): Promise<{ seen: number; confirmed: number }> {
    const reported = await this.port.listDeposits(address.address);
    let seen = 0;
    let confirmed = 0;

    for (const deposit of reported) {
      // The asset the ADDRESS is for, not the one in the payload. An address
      // is issued for one asset on one chain, and believing the provider over
      // the address would let a mislabelled row credit the wrong balance —
      // the same rule the webhook parser applies.
      if (deposit.asset !== address.asset) {
        this.#logger.error(
          `provider reported a ${deposit.asset} deposit on a ${address.asset} address ` +
            `(${deposit.providerReference}); skipped`,
        );
        continue;
      }
      if (deposit.amountMinor <= 0n) continue;

      const known = await this.pool.query<DepositRow>(
        `SELECT id, status::text AS status, required_confirmations,
                amount_minor::text AS amount_minor, asset
           FROM crypto_deposits
          WHERE provider = $1 AND provider_reference = $2`,
        [this.port.provider, deposit.providerReference],
      );
      const row = known.rows[0];

      if (row === undefined) {
        await this.#recordSeen(address, deposit);
        seen += 1;
        continue;
      }

      if (row.status === 'seen' && deposit.confirmations >= row.required_confirmations) {
        await this.#promote(row, address, deposit);
        confirmed += 1;
      }
    }

    return { seen, confirmed };
  }

  /** A deposit nobody told us about: into pending, visible and not spendable. */
  async #recordSeen(address: AddressRow, deposit: ProviderCryptoDeposit): Promise<void> {
    const asset = address.asset as Currency;
    const amount = money(deposit.amountMinor, asset);

    const required = this.config.confirmationsFor(asset, address.network);

    const posted = await this.ledger.post({
      // The SAME key the webhook would have used. That shared derivation is
      // the entire reason a sweep and a late redelivery cannot both credit —
      // and it is keyed on the DEPOSIT rather than the delivery, because a
      // lost webhook has no event id for this sweep to know.
      idempotencyKey: `${this.port.provider}:${deposit.providerReference}:seen`,
      kind: 'crypto_deposit',
      occurredAt: deposit.occurredAt,
      description: `${asset} deposit found by reconciliation`,
      metadata: {
        tx_hash: deposit.txHash,
        chain: address.network,
        phase: 'seen',
        source: 'reconciliation',
      },
      postings: [
        posting({ kind: 'customer_pending', ownerId: address.user_id, currency: asset }, amount),
        posting({ kind: 'provider_float', currency: asset }, money(-deposit.amountMinor, asset)),
      ],
    });

    await this.pool.query(
      `INSERT INTO crypto_deposits
         (provider, provider_reference, user_id, address_id, tx_hash, output_index,
          asset, network, amount_minor, confirmations, required_confirmations,
          status, seen_entry_id)
       VALUES ($1, $2, $3::bigint, $4::bigint, $5, $6, $7, $8::crypto_network,
               $9::bigint, $10, $11, 'seen', $12::bigint)
       ON CONFLICT (provider, provider_reference) DO NOTHING`,
      [
        this.port.provider,
        deposit.providerReference,
        address.user_id,
        address.id,
        deposit.txHash,
        deposit.outputIndex ?? 0,
        asset,
        address.network,
        deposit.amountMinor.toString(),
        deposit.confirmations,
        required,
        posted.entryId,
      ],
    );
  }

  /**
   * A deposit we hold in pending whose confirmation event never came.
   *
   * The threshold read is the one stored ON THE ROW, not the current config.
   * Raising the requirement later must not un-confirm money already credited,
   * and lowering it must not retroactively promote deposits that were held
   * under the stricter rule.
   */
  async #promote(
    row: DepositRow,
    address: AddressRow,
    deposit: ProviderCryptoDeposit,
  ): Promise<void> {
    const asset = address.asset as Currency;
    const amountMinor = BigInt(row.amount_minor);
    const amount = money(amountMinor, asset);

    const posted = await this.ledger.post({
      idempotencyKey: `${this.port.provider}:${deposit.providerReference}:confirmed`,
      kind: 'crypto_deposit',
      occurredAt: deposit.occurredAt,
      description: `${asset} deposit confirmed by reconciliation`,
      metadata: {
        tx_hash: deposit.txHash,
        chain: address.network,
        phase: 'confirmed',
        source: 'reconciliation',
      },
      postings: [
        posting(
          { kind: 'customer_pending', ownerId: address.user_id, currency: asset },
          money(-amountMinor, asset),
        ),
        posting({ kind: 'customer_wallet', ownerId: address.user_id, currency: asset }, amount),
      ],
    });

    // Guarded on `status = 'seen'`, so a webhook landing between the read and
    // this write cannot produce a second promotion.
    await this.pool.query(
      `UPDATE crypto_deposits
          SET status = 'confirmed',
              confirmations = GREATEST(confirmations, $2),
              confirmed_entry_id = $3::bigint
        WHERE id = $1::bigint AND status = 'seen'`,
      [row.id, deposit.confirmations, posted.entryId],
    );
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
