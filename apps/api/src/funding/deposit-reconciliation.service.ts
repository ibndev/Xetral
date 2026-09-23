import { Inject, Injectable, Logger } from '@nestjs/common';
import type { OnApplicationShutdown } from '@nestjs/common';
import type { Pool } from 'pg';
import { LedgerService, posting } from '@xetral/ledger';
import type { DepositLookup, FundingPort, ProviderDeposit } from '@xetral/providers';
import { assertWithinCeiling, DepositCeilingError } from '@xetral/providers';
import { money } from '@xetral/shared';
import { API_CONFIG, DATABASE, FUNDING_PORT, LEDGER } from '../tokens.js';
import type { ApiConfig } from '../config.js';
import { SettingsService } from '../settings/settings.service.js';

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
    @Inject(SettingsService) private readonly settings: SettingsService,
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
    /*
     * EVERY RAIL'S ACCOUNTS, NOT JUST THE DEFAULT'S.
     *
     * This read `WHERE provider = port.provider` — and `port.provider` on the
     * switch is the configured FALLBACK. So once a single account had been
     * opened anywhere else, its lost webhooks were never looked for: the
     * sweep ran, reported nothing and found nothing, which is exactly what a
     * rail with no lost webhooks looks like. The moment naira account numbers
     * move to Flutterwave that would have been every new account on the
     * platform.
     */
    const accounts = await this.pool.query<SweptAccount>(
      `SELECT id, user_id, provider, provider_account_id, provider_customer_ref, currency
         FROM virtual_accounts
        WHERE status = 'active'
        ORDER BY id LIMIT 500`,
    );

    let credited = 0;
    let failed = 0;
    let checked = 0;

    for (const account of accounts.rows) {
      // A single-rail deployment can only ask its own rail; an account issued
      // by another is one this build cannot read, and is skipped rather than
      // asked about at a provider that never heard of it.
      if (!this.#canAsk(account.provider)) continue;
      checked += 1;
      try {
        credited += await this.#reconcile(account);
      } catch (error) {
        failed += 1;
        this.#logger.warn(
          `could not re-check ${account.provider} account ${account.provider_account_id}: ` +
            describe(error),
        );
      }
    }

    if (credited > 0) {
      this.#logger.warn(
        `credited ${credited} deposit(s) whose webhook never arrived — check webhook delivery`,
      );
    }
    return { accountsChecked: checked, credited, failed };
  }

  #canAsk(provider: string): boolean {
    const switching = this.port as { providers?: readonly string[] };
    if (switching.providers !== undefined) return switching.providers.includes(provider);
    return this.port.provider === provider;
  }

  async #list(account: SweptAccount): Promise<readonly ProviderDeposit[]> {
    const lookup = {
      providerAccountId: account.provider_account_id,
      // Paystack keys its transaction list on the CUSTOMER and Flutterwave on
      // the reference the account was opened under. Passing only the account
      // id — what this did — asked Paystack about a customer that does not
      // exist.
      providerCustomerRef: account.provider_customer_ref ?? undefined,
    };
    const switching = this.port as FundingPort & {
      listDeposits(account: DepositLookup, provider?: string): Promise<readonly ProviderDeposit[]>;
    };
    return switching.listDeposits(lookup, account.provider);
  }

  async #reconcile(account: SweptAccount): Promise<number> {
    const seen = await this.#list(account);
    let credited = 0;

    for (const deposit of seen) {
      const known = await this.pool.query(
        `SELECT 1 FROM deposits WHERE provider = $1 AND provider_reference = $2`,
        [account.provider, deposit.providerReference],
      );
      if (known.rowCount !== 0) continue;

      /*
       * THE ACCOUNT'S OWN CURRENCY, never naira by assumption. This posted
       * every deposit as NGN — so a cedi account's 500 would have become 500
       * kobo in a naira wallet, the kobo-and-cents mistake with a customer's
       * balance on the end of it. A deposit that disagrees with its account is
       * left for the webhook path, which holds it in suspense with the reason.
       */
      if (deposit.currency !== account.currency) {
        this.#logger.error(
          `deposit ${deposit.providerReference} is ${deposit.currency} on a ` +
            `${account.currency} account and was NOT credited by the sweep`,
        );
        continue;
      }

      // The ceiling is published in kobo and says something about naira only
      // — and it is read from SETTINGS, as the webhook reads it, so raising it
      // for one expected transfer is not undone by the sweep.
      if (deposit.currency === 'NGN') {
        try {
          assertWithinCeiling(deposit.amountMinor, await this.settings.depositCeilingKobo());
        } catch (error) {
          if (error instanceof DepositCeilingError) {
            // Same rule as the webhook path: above the ceiling is a decision
            // for a person. The sweep will keep finding it until one is made,
            // which is the correct amount of nagging.
            this.#logger.error(
              `deposit ${deposit.providerReference} found by reconciliation is above the ` +
                `ceiling and was NOT credited: ${error.message}`,
            );
            continue;
          }
          throw error;
        }
      }

      const currency = deposit.currency;
      const posted = await this.ledger.post({
        // The SAME key the webhook would have used, so if the webhook arrives
        // late the ledger recognises it as a replay rather than crediting
        // twice. That shared derivation is the whole reason this is safe.
        idempotencyKey: `${account.provider}:${deposit.providerReference}`,
        kind: 'wallet_funding',
        occurredAt: deposit.occurredAt,
        description: `${currency} deposit found by reconciliation`,
        metadata: { provider_reference: deposit.providerReference, source: 'reconciliation' },
        postings: [
          posting(
            { kind: 'customer_wallet', ownerId: account.user_id, currency },
            money(deposit.amountMinor, currency),
          ),
          posting({ kind: 'provider_float', currency }, money(-deposit.amountMinor, currency)),
        ],
      });

      await this.pool.query(
        `INSERT INTO deposits
           (provider, provider_reference, user_id, virtual_account_id, amount_minor,
            currency, sender_name, sender_bank, sender_account, status, entry_id)
         VALUES ($1, $2, $3::bigint, $4::bigint, $5::bigint, $6, $7, $8, $9, 'credited', $10::bigint)
         ON CONFLICT (provider, provider_reference) DO NOTHING`,
        [
          account.provider,
          deposit.providerReference,
          account.user_id,
          account.id,
          deposit.amountMinor.toString(),
          currency,
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

interface SweptAccount {
  readonly id: string;
  readonly user_id: string;
  readonly provider: string;
  readonly provider_account_id: string;
  readonly provider_customer_ref: string | null;
  readonly currency: string;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
