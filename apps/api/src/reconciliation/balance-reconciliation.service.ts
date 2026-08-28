import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { OnApplicationShutdown } from '@nestjs/common';
import type { Pool } from 'pg';
import type { CardPort, ProviderBalancePort } from '@xetral/providers';
import { ProviderError } from '@xetral/providers';
import { API_CONFIG, CARD_PORT, DATABASE, PROVIDER_BALANCE_PORT } from '../tokens.js';
import type { ApiConfig } from '../config.js';
import { SettingsService } from '../settings/settings.service.js';
import { NotificationService } from '../notifications/notification.service.js';

/**
 * Does the provider agree with us about the TOTAL?
 *
 * WHAT THIS CATCHES THAT NOTHING ELSE DOES. Four sweeps already ask about
 * individual transactions, and each is correct. None of them can see money that
 * was never a transaction on our side — a fee deducted from the float, a
 * settlement applied and never announced, a credit made outside our flow. Those
 * leave the books internally consistent and quietly wrong about what we hold.
 * `ledger_drift` compares our materialised balances against our own postings;
 * this is the only thing that compares our postings against reality.
 *
 * IT RECORDS AND NEVER CORRECTS, which is the whole design. Posting an
 * adjustment to make the ledger match the provider would invent money on the
 * strength of a number that is routinely and legitimately stale: a Bitnob card
 * authorisation and its settlement are two events up to fourteen business days
 * apart, so a card that differs today may simply have an open hold. Every one
 * of those would become a fabricated entry indistinguishable from a real one.
 * A person decides; this writes down what each side said.
 */

/* Distinct from every other sweep's key. */
const SWEEP_LOCK_KEY = 8_264_100_009;

export interface BalanceSweepReport {
  readonly checked: number;
  readonly differences: number;
  readonly skipped: number;
  /** Card holds past the settlement window with no outcome recorded. */
  readonly stuckHolds: number;
}

@Injectable()
export class BalanceReconciliationService implements OnApplicationShutdown {
  readonly #logger = new Logger(BalanceReconciliationService.name);
  #timer: NodeJS.Timeout | undefined;

  constructor(
    @Inject(DATABASE) private readonly pool: Pool,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(SettingsService) private readonly settings: SettingsService,
    @Inject(NotificationService) private readonly notifications: NotificationService,
    @Optional() @Inject(PROVIDER_BALANCE_PORT) private readonly balances?: ProviderBalancePort,
    @Optional() @Inject(CARD_PORT) private readonly cards?: CardPort,
  ) {}

  start(): void {
    const everySeconds = this.config.balanceReconcileIntervalSeconds;
    if (everySeconds === undefined) {
      this.#logger.warn(
        'BALANCE_RECONCILE_INTERVAL_SECONDS is not set: nothing compares what Bitnob ' +
          'says it holds against what the ledger says we hold. Transaction sweeps ' +
          'cannot see money that was never a transaction here. Set it on exactly one ' +
          'instance.',
      );
      return;
    }
    if (this.balances === undefined) {
      this.#logger.warn('no provider balance port configured: balance reconciliation is off.');
      return;
    }

    this.#logger.log(`comparing provider balances every ${everySeconds}s`);
    this.#timer = setInterval(() => {
      void this.sweep().catch((error: unknown) => {
        this.#logger.error(`balance sweep failed: ${describe(error)}`);
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
   * A session advisory lock, for the reason every sweep here holds one:
   * `pool.query` runs each statement in its own implicit transaction, so
   * `SELECT ... FOR UPDATE SKIP LOCKED` would release before any provider was
   * asked while reading as though it guarded the work.
   */
  async sweep(): Promise<BalanceSweepReport> {
    const empty = { checked: 0, differences: 0, skipped: 0, stuckHolds: 0 };
    if (this.balances === undefined) return empty;

    const lock = await this.pool.connect();
    try {
      const acquired = await lock.query<{ ok: boolean }>(
        `SELECT pg_try_advisory_lock($1::bigint) AS ok`,
        [SWEEP_LOCK_KEY],
      );
      if (acquired.rows[0]?.ok !== true) return empty;

      try {
        return await this.#sweepLocked();
      } finally {
        await lock.query(`SELECT pg_advisory_unlock($1::bigint)`, [SWEEP_LOCK_KEY]);
      }
    } finally {
      lock.release();
    }
  }

  async #sweepLocked(): Promise<BalanceSweepReport> {
    const tolerance = BigInt(await this.settings.balanceToleranceMinor());
    let checked = 0;
    let differences = 0;
    let skipped = 0;

    /* ---- the float, per currency ---- */
    try {
      for (const held of await this.balances!.floatBalances()) {
        checked += 1;
        // The ledger's own figure. `provider_float` is DEBIT-normal and holds a
        // positive balance when the provider owes us, so the two are directly
        // comparable without a sign flip — but the sign is taken from the
        // stored balance rather than assumed here.
        const ours = await this.#ledgerFloat(held.currency);
        if (
          await this.#record('provider_float', held.currency, held.currency, held.amount, ours, tolerance)
        ) {
          differences += 1;
        }
      }
    } catch (error) {
      // An unreachable provider is NOT a discrepancy. Recording one would fill
      // the queue with findings about our own connectivity, and the real one
      // would be lost among them — the same rule the purchase sweep follows
      // when a provider refuses a connection.
      if (error instanceof ProviderError) {
        this.#logger.warn(`could not read provider balances: ${error.message}`);
        skipped += 1;
      } else {
        throw error;
      }
    }

    /* ---- each live card ---- */
    if (this.cards !== undefined) {
      const live = await this.pool.query<{ uuid: string; provider_card_id: string; ledger_minor: string }>(
        `SELECT c.uuid, c.provider_card_id,
                COALESCE(b.balance_minor, 0)::text AS ledger_minor
           FROM cards c
           LEFT JOIN accounts a
                  ON a.kind = 'customer_card' AND a.owner_type = 'user'
                 AND a.owner_id = c.user_id AND a.currency = 'USD'
           LEFT JOIN account_balances b ON b.account_id = a.id
          -- A TERMINATED card is skipped: its balance at the provider is dead,
          -- so a difference there is expected rather than a finding.
          WHERE c.status <> 'terminated'
          LIMIT 500`,
      );

      for (const card of live.rows) {
        try {
          const remote = await this.cards.get(card.provider_card_id);
          checked += 1;
          if (
            await this.#record(
              'card',
              card.uuid,
              'USD',
              remote.balance.amount,
              BigInt(card.ledger_minor),
              tolerance,
            )
          ) {
            differences += 1;
          }
        } catch (error) {
          if (error instanceof ProviderError) {
            skipped += 1;
            continue;
          }
          throw error;
        }
      }
    }

    if (differences > 0) {
      this.#logger.error(
        `${differences} balance discrepancy(ies) recorded; read provider_balance_drift`,
      );
      await this.#alert(differences);
    }

    /* ---- holds that never resolved ---- */
    //
    // On this sweep rather than its own, deliberately. It asks the same
    // question — does the provider agree with us — and every worker interval
    // is one more thing an operator can forget to set on exactly one instance.
    // This one's absence would be invisible: the money sits in
    // `customer_pending`, the ledger balances perfectly, and nothing reports a
    // thing.
    const stuckHolds = await this.#stuckHolds();
    if (stuckHolds > 0) {
      this.#logger.error(
        `${stuckHolds} card hold(s) past the settlement window with no outcome; ` +
          `read card_holds_stuck`,
      );
      await this.#alertStuckHolds(stuckHolds);
    }

    return { checked, differences, skipped, stuckHolds };
  }

  /**
   * How many holds are past the window with no settlement and no expiry.
   *
   * COUNTED AND NEVER RESOLVED. The two things this could do automatically are
   * both wrong: settling it invents a spend the provider never confirmed, and
   * expiring it hands money back that may have been spent. A hold this old is
   * either a lost webhook or an expiry nobody told us about, and by the time
   * it is this old, guessing is exactly what a person is needed to avoid — the
   * same rule the purchase reconciler follows about a provider that still says
   * `pending`.
   */
  async #stuckHolds(): Promise<number> {
    const result = await this.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM card_holds_stuck`,
    );
    return Number(result.rows[0]?.n ?? '0');
  }

  /** What our books say the provider holds, in minor units. */
  async #ledgerFloat(currency: string): Promise<bigint> {
    const result = await this.pool.query<{ minor: string }>(
      `SELECT COALESCE(SUM(b.balance_minor), 0)::text AS minor
         FROM accounts a
         JOIN account_balances b ON b.account_id = a.id
        WHERE a.kind = 'provider_float' AND a.currency = $1`,
      [currency],
    );
    return BigInt(result.rows[0]?.minor ?? '0');
  }

  /**
   * Writes a finding, and returns whether one was written.
   *
   * ONLY DIFFERENCES ARE STORED. A row per agreement would be a table that
   * grows by thousands a day and hides the handful that matter — and "they
   * agreed" is already the assumption the ledger is built on. The absence of a
   * row IS the pass.
   */
  async #record(
    scope: 'provider_float' | 'card',
    subject: string,
    currency: string,
    providerMinor: bigint,
    ledgerMinor: bigint,
    tolerance: bigint,
  ): Promise<boolean> {
    const difference = providerMinor - ledgerMinor;
    const magnitude = difference < 0n ? -difference : difference;
    if (magnitude <= tolerance) return false;

    await this.pool.query(
      `INSERT INTO provider_balance_checks
         (provider, scope, subject, currency, provider_minor, ledger_minor, difference_minor)
       VALUES ($1, $2::balance_scope, $3, $4, $5::bigint, $6::bigint, $7::bigint)`,
      [
        this.balances?.provider ?? 'unknown',
        scope,
        subject,
        currency,
        providerMinor.toString(),
        ledgerMinor.toString(),
        difference.toString(),
      ],
    );
    return true;
  }

  /**
   * Tells operations, once per sweep rather than once per finding.
   *
   * A discrepancy the provider caused tends to affect every card at once, and
   * one email per card would be the mail bomb that makes the next real alert
   * get filtered.
   */
  async #alert(count: number): Promise<void> {
    const to = this.config.operationsEmail;
    if (to === undefined) return;

    await this.notifications.enqueueDetached({
      userId: null,
      recipient: to,
      idempotencyKey: `balance-drift:${new Date().toISOString().slice(0, 13)}`,
      request: {
        kind: 'operations_alert',
        headline: `${count} provider balance discrepancy(ies)`,
        detail:
          'What the provider says it holds does not match the ledger. Nothing has been ' +
          'adjusted — read provider_balance_drift and resolve each one.',
        occurrences: String(count),
        severity: 'error',
        fingerprint: 'balance-drift',
      },
    });
  }

  async #alertStuckHolds(count: number): Promise<void> {
    const to = this.config.operationsEmail;
    if (to === undefined) return;

    await this.notifications.enqueueDetached({
      userId: null,
      recipient: to,
      // Keyed by the hour, like the drift alert: a sweep every few minutes
      // must not mail somebody every few minutes about the same holds.
      idempotencyKey: `stuck-holds:${new Date().toISOString().slice(0, 13)}`,
      request: {
        kind: 'operations_alert',
        headline: `${count} card hold(s) never settled`,
        detail:
          'Money is sitting in customer_pending past the provider settlement window. ' +
          'The customer cannot spend it and the ledger balances, so nothing else ' +
          'reports this. Nothing has been resolved automatically — read ' +
          'card_holds_stuck and ask Bitnob what happened to each.',
        occurrences: String(count),
        severity: 'error',
        fingerprint: 'stuck-card-holds',
      },
    });
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
