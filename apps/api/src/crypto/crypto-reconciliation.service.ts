import { Inject, Injectable, Logger } from '@nestjs/common';
import type { OnApplicationShutdown } from '@nestjs/common';
import type { Pool } from 'pg';
import type { CryptoPort } from '@xetral/providers';
import { API_CONFIG, CRYPTO_PORT, DATABASE } from '../tokens.js';
import type { ApiConfig } from '../config.js';
import { CryptoService } from './crypto.service.js';

/**
 * Resolving withdrawals whose outcome nobody told us.
 *
 * A send that timed out is the dangerous case: it may be on a chain and
 * unrecallable, or it may never have left. Reversing would refund money that
 * is gone; retrying would send twice. So the row stays `reserved` and this
 * asks the provider — the same authority-to-relay-only rule as purchase
 * reconciliation, with worse consequences for guessing.
 *
 * It also picks up `broadcast` withdrawals still waiting to confirm, which is
 * ordinary progress rather than a failure.
 */

const SWEEP_LOCK_KEY = 8_264_100_004;

export interface CryptoSweepReport {
  readonly examined: number;
  readonly resolved: number;
  readonly failed: number;
}

interface PendingRow {
  id: string;
  reference: string;
  status: string;
}

@Injectable()
export class CryptoReconciliationService implements OnApplicationShutdown {
  readonly #logger = new Logger(CryptoReconciliationService.name);
  #timer: NodeJS.Timeout | undefined;

  constructor(
    @Inject(DATABASE) private readonly pool: Pool,
    @Inject(CRYPTO_PORT) private readonly port: CryptoPort,
    @Inject(CryptoService) private readonly crypto: CryptoService,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
  ) {}

  start(): void {
    const everySeconds = this.config.cryptoReconcileIntervalSeconds;
    if (everySeconds === undefined) {
      this.#logger.warn(
        'CRYPTO_RECONCILE_INTERVAL_SECONDS is not set: a withdrawal whose outcome is ' +
          'unknown will stay held for ever on this instance. Exactly one must set it.',
      );
      return;
    }

    this.#logger.log(`re-checking crypto withdrawals every ${everySeconds}s`);
    this.#timer = setInterval(() => {
      void this.sweep().catch((error: unknown) => {
        this.#logger.error(`crypto sweep failed: ${describe(error)}`);
      });
    }, everySeconds * 1000);
    this.#timer.unref();
  }

  onApplicationShutdown(): void {
    if (this.#timer !== undefined) clearInterval(this.#timer);
  }

  async sweep(): Promise<CryptoSweepReport> {
    const lock = await this.pool.connect();
    try {
      const acquired = await lock.query<{ ok: boolean }>(
        `SELECT pg_try_advisory_lock($1::bigint) AS ok`,
        [SWEEP_LOCK_KEY],
      );
      if (acquired.rows[0]?.ok !== true) return { examined: 0, resolved: 0, failed: 0 };
      try {
        return await this.#sweepLocked();
      } finally {
        await lock.query(`SELECT pg_advisory_unlock($1::bigint)`, [SWEEP_LOCK_KEY]);
      }
    } finally {
      lock.release();
    }
  }

  async #sweepLocked(): Promise<CryptoSweepReport> {
    const pending = await this.pool.query<PendingRow>(
      `SELECT withdrawal_id::text AS id, reference, status::text
         FROM crypto_withdrawals_pending LIMIT 100`,
    );

    let resolved = 0;
    let failed = 0;

    for (const row of pending.rows) {
      try {
        const receipt = await this.port.withdrawalStatus(row.reference);
        const before = row.status;

        const current = await this.pool.query<Parameters<CryptoService['applyReceipt']>[0]>(
          `SELECT id, uuid, user_id, reference, asset, network::text, destination,
                  amount_minor, fee_minor, status::text, tx_hash, failure_reason,
                  reserve_entry_id
             FROM crypto_withdrawals WHERE id = $1::bigint`,
          [row.id],
        );
        const withdrawal = current.rows[0];
        if (withdrawal === undefined) continue;

        await this.crypto.applyReceipt(withdrawal, receipt);

        const after = await this.pool.query<{ status: string }>(
          `SELECT status::text FROM crypto_withdrawals WHERE id = $1::bigint`,
          [row.id],
        );
        if (after.rows[0]?.status !== before) resolved += 1;
      } catch (error) {
        // An unreachable provider is not a failed withdrawal. Treating it as
        // one would refund transactions that are already on a chain.
        failed += 1;
        this.#logger.warn(`could not reconcile withdrawal ${row.reference}: ${describe(error)}`);
      }
    }

    if (resolved > 0) this.#logger.log(`resolved ${resolved} crypto withdrawal(s)`);
    return { examined: pending.rows.length, resolved, failed };
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
