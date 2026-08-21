import { Inject, Injectable, Logger } from '@nestjs/common';
import type { OnApplicationShutdown } from '@nestjs/common';
import type { Pool } from 'pg';
import { LedgerService, posting } from '@xetral/ledger';
import type { FundingPort } from '@xetral/providers';
import { assertWithinCeiling, DepositCeilingError } from '@xetral/providers';
import { money } from '@xetral/shared';
import { API_CONFIG, DATABASE, FUNDING_PORT, LEDGER } from '../tokens.js';
import type { ApiConfig } from '../config.js';

/**
 * Finding deposits whose webhook never arrived.
 *
 * This is the failure a bank rail cannot otherwise detect. A customer
 * transfers money, the provider records it, the webhook is lost — and no
 * amount of waiting fixes it, because nothing is retrying. The customer sees
 * nothing and has no way to prove they sent it. So the answer is to ASK, the
 * same shape as purchase reconciliation one layer down.
 *
 * It only ever ADDS deposits that the provider says happened and we have no
 * record of. It never removes or adjusts one: a deposit we recorded and the
 * provider has since forgotten is a dispute for a human, not a reversal for a
 * worker.
 */

const SWEEP_LOCK_KEY = 8_264_100_003;

export interface DepositSweepReport {
  readonly accountsChecked: number;
  readonly credited: number;
  readonly failed: number;
}

@Injectable()
export class DepositReconciliationService implements OnApplicationShutdown {
  readonly #logger = new Logger(DepositReconciliationService.name);
  #timer: NodeJS.Timeout | undefined;

  constructor(
    @Inject(DATABASE) private readonly pool: Pool,
    @Inject(LEDGER) private readonly ledger: LedgerService,
    @Inject(FUNDING_PORT) private readonly port: FundingPort,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
  ) {}

  start(): void {
    const everySeconds = this.config.depositReconcileIntervalSeconds;
    if (everySeconds === undefined) {
      this.#logger.warn(
        'DEPOSIT_RECONCILE_INTERVAL_SECONDS is not set: a lost deposit webhook will ' +
          'never be noticed by this instance. Exactly one instance must set it.',
      );
      return;
    }

    this.#logger.log(`re-checking deposits every ${everySeconds}s`);
    this.#timer = setInterval(() => {
      void this.sweep().catch((error: unknown) => {
        this.#logger.error(`deposit sweep failed: ${describe(error)}`);
      });
    }, everySeconds * 1000);
    this.#timer.unref();
  }

  onApplicationShutdown(): void {
    if (this.#timer !== undefined) clearInterval(this.#timer);
  }

  async sweep(): Promise<DepositSweepReport> {
    const lock = await this.pool.connect();
    try {
      const acquired = await lock.query<{ ok: boolean }>(
        `SELECT pg_try_advisory_lock($1::bigint) AS ok`,
        [SWEEP_LOCK_KEY],
      );
      if (acquired.rows[0]?.ok !== true) {
        return { accountsChecked: 0, credited: 0, failed: 0 };
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

  async #sweepLocked(): Promise<DepositSweepReport> {
    const accounts = await this.pool.query<{
      id: string;
      user_id: string;
      provider_account_id: string;
    }>(
      `SELECT id, user_id, provider_account_id FROM virtual_accounts
        WHERE status = 'active' AND provider = $1
        ORDER BY id LIMIT 500`,
      [this.port.provider],
    );

    let credited = 0;
    let failed = 0;

    for (const account of accounts.rows) {
      try {
        credited += await this.#reconcile(account);
      } catch (error) {
        failed += 1;
        this.#logger.warn(
          `could not re-check account ${account.provider_account_id}: ${describe(error)}`,
        );
      }
    }

    if (credited > 0) {
      this.#logger.warn(
        `credited ${credited} deposit(s) whose webhook never arrived — check webhook delivery`,
      );
    }
    return { accountsChecked: accounts.rows.length, credited, failed };
  }

  async #reconcile(account: {
    id: string;
    user_id: string;
    provider_account_id: string;
  }): Promise<number> {
    const seen = await this.port.listDeposits(account.provider_account_id);
    let credited = 0;

    for (const deposit of seen) {
      const known = await this.pool.query(
        `SELECT 1 FROM deposits WHERE provider = $1 AND provider_reference = $2`,
        [this.port.provider, deposit.providerReference],
      );
      if (known.rowCount !== 0) continue;

      try {
        assertWithinCeiling(deposit.amountMinor, this.config.depositCeilingKobo);
      } catch (error) {
        if (error instanceof DepositCeilingError) {
          // Same rule as the webhook path: above the ceiling is a decision for
          // a person. The sweep will keep finding it until one is made, which
          // is the correct amount of nagging.
          this.#logger.error(
            `deposit ${deposit.providerReference} found by reconciliation is above the ` +
              `ceiling and was NOT credited: ${error.message}`,
          );
          continue;
        }
        throw error;
      }

      const amount = money(deposit.amountMinor, 'NGN');
      const posted = await this.ledger.post({
        // The SAME key the webhook would have used, so if the webhook arrives
        // late the ledger recognises it as a replay rather than crediting
        // twice. That shared derivation is the whole reason this is safe.
        idempotencyKey: `${this.port.provider}:${deposit.providerReference}`,
        kind: 'wallet_funding',
        occurredAt: deposit.occurredAt,
        description: 'NGN deposit found by reconciliation',
        metadata: { provider_reference: deposit.providerReference, source: 'reconciliation' },
        postings: [
          posting({ kind: 'customer_wallet', ownerId: account.user_id, currency: 'NGN' }, amount),
          posting({ kind: 'provider_float', currency: 'NGN' }, money(-deposit.amountMinor, 'NGN')),
        ],
      });

      await this.pool.query(
        `INSERT INTO deposits
           (provider, provider_reference, user_id, virtual_account_id, amount_minor,
            currency, sender_name, sender_bank, sender_account, status, entry_id)
         VALUES ($1, $2, $3::bigint, $4::bigint, $5::bigint, 'NGN', $6, $7, $8, 'credited', $9::bigint)
         ON CONFLICT (provider, provider_reference) DO NOTHING`,
        [
          this.port.provider,
          deposit.providerReference,
          account.user_id,
          account.id,
          deposit.amountMinor.toString(),
          deposit.senderName ?? null,
          deposit.senderBank ?? null,
          deposit.senderAccount ?? null,
          posted.entryId,
        ],
      );

      if (!posted.replayed) credited += 1;
    }

    return credited;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
