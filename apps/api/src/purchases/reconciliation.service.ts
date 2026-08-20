import { Inject, Injectable, Logger } from '@nestjs/common';
import type { OnApplicationShutdown } from '@nestjs/common';
import type { Pool } from 'pg';
import type { FulfilmentPort, ServiceKind } from '@xetral/providers';
import { API_CONFIG, CLOCK, DATABASE, FULFILMENT_PORTS } from '../tokens.js';
import type { Clock } from '../tokens.js';
import type { ApiConfig } from '../config.js';
import { PurchaseOutcome } from './purchase-outcome.js';
import type { ReservedPurchase } from './purchase-outcome.js';

/**
 * Resolving the purchases nobody was left listening for.
 *
 * A purchase reserves the customer's money and then asks a provider. When the
 * provider answers, the request handler settles or reverses and that is the
 * end of it. When the provider does NOT answer — a timeout, a dropped
 * connection, a pod restarted mid-request — the row stays `reserved`, which is
 * the correct thing to do at that moment and an unacceptable thing to leave
 * for ever: the customer's money is held against an outcome nobody will ever
 * look up.
 *
 * That is what this closes. It is the other half of "a timeout settles nothing
 * and reverses nothing": the first half is refusing to guess, and the second
 * half is going back later to find out.
 *
 * WHAT IT WILL NOT DO
 * -------------------
 * It never *decides* an outcome. Every resolution here comes from the provider
 * saying what happened. A held purchase whose provider still says `pending`
 * stays held, however old it is — a worker that reversed on age alone would
 * refund delivered electricity tokens on a bad afternoon, and the money would
 * be gone in both directions at once.
 *
 * Rows older than `staleAfterSeconds` are therefore ESCALATED, not resolved:
 * logged loudly so a human decides. That is deliberately not an automated
 * action, because by then the automated actions have all been tried.
 */

/** How long a reserved purchase is left alone before we ask about it.
 *
 *  Not zero: the row is written before the provider is called, so a purchase a
 *  second old is almost certainly still in flight in a request handler that is
 *  about to settle it. Asking now races that handler for no benefit. */
const DEFAULT_GRACE_SECONDS = 120;

/** How many to work per pass. Bounded so one sweep cannot hold a connection
 *  for minutes or hammer a provider that is already having a bad day. */
const BATCH_SIZE = 50;

/** Arbitrary but fixed: every instance must pick the same number for the lock
 *  to mean anything. */
const SWEEP_LOCK_KEY = 8_264_100_001;

const EMPTY_REPORT: ReconciliationReport = {
  examined: 0,
  settled: 0,
  reversed: 0,
  stillPending: 0,
  stale: 0,
  failed: 0,
};

export interface ReconciliationReport {
  readonly examined: number;
  readonly settled: number;
  readonly reversed: number;
  readonly stillPending: number;
  readonly stale: number;
  readonly failed: number;
}

@Injectable()
export class ReconciliationService implements OnApplicationShutdown {
  readonly #logger = new Logger(ReconciliationService.name);
  #timer: NodeJS.Timeout | undefined;

  constructor(
    @Inject(DATABASE) private readonly pool: Pool,
    @Inject(FULFILMENT_PORTS) private readonly ports: ReadonlyMap<ServiceKind, FulfilmentPort>,
    @Inject(PurchaseOutcome) private readonly outcomes: PurchaseOutcome,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Starts the periodic sweep, if this instance is configured to run one.
   *
   * Opt-in rather than automatic: several API instances behind a load balancer
   * would otherwise all sweep, and while the work is safe to duplicate (see
   * `#claim`), asking a provider about the same purchase from four processes
   * is rude at best and rate-limited at worst. One box runs it.
   */
  start(): void {
    const everySeconds = this.config.reconcileIntervalSeconds;
    if (everySeconds === undefined) {
      this.#logger.warn(
        'RECONCILE_INTERVAL_SECONDS is not set: held purchases will NOT be resolved by this ' +
          'instance. Exactly one instance must set it.',
      );
      return;
    }

    this.#logger.log(`reconciling held purchases every ${everySeconds}s`);
    this.#timer = setInterval(() => {
      void this.sweep().catch((error: unknown) => {
        // A failed sweep must never kill the timer. The next one retries, and
        // the rows it did not reach are still in the queue — that is the whole
        // point of the queue being a database view rather than in-process state.
        this.#logger.error(`reconciliation sweep failed: ${describe(error)}`);
      });
    }, everySeconds * 1000);

    // Node keeps the process alive for a pending timer, which would stop the
    // API from shutting down cleanly between sweeps.
    this.#timer.unref();
  }

  onApplicationShutdown(): void {
    if (this.#timer !== undefined) clearInterval(this.#timer);
  }

  /**
   * One pass. Exposed so a test can drive it directly rather than waiting for
   * a timer, and so an operator can trigger one without restarting the app.
   */
  async sweep(): Promise<ReconciliationReport> {
    const lock = await this.pool.connect();
    try {
      // One sweep at a time, anywhere. See #withSweepLock for why this is a
      // session advisory lock rather than row locks.
      const acquired = await lock.query<{ ok: boolean }>(
        `SELECT pg_try_advisory_lock($1::bigint) AS ok`,
        [SWEEP_LOCK_KEY],
      );
      if (acquired.rows[0]?.ok !== true) {
        this.#logger.debug('another sweep holds the reconciliation lock; skipping this pass');
        return EMPTY_REPORT;
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

  async #sweepLocked(): Promise<ReconciliationReport> {
    const graceSeconds = this.config.reconcileGraceSeconds ?? DEFAULT_GRACE_SECONDS;
    const staleSeconds = this.config.reconcileStaleSeconds;

    const held = await this.#claim(graceSeconds);
    let settled = 0;
    let reversed = 0;
    let stillPending = 0;
    let stale = 0;
    let failed = 0;

    for (const row of held) {
      const heldForSeconds = (this.clock.nowMs() - Date.parse(row.created_at)) / 1000;

      try {
        const resolved = await this.#resolve(row);
        if (resolved === 'settled') settled += 1;
        else if (resolved === 'reversed') reversed += 1;
        else stillPending += 1;

        if (resolved === 'pending' && staleSeconds !== undefined && heldForSeconds > staleSeconds) {
          stale += 1;
          this.#escalate(row, heldForSeconds, 'the provider still reports it as pending');
        }
      } catch (error) {
        failed += 1;
        // Asking failed — the provider is down, or answered something we do not
        // understand. The row keeps its money held and the next sweep tries
        // again. This is a log line, not an outcome.
        this.#logger.warn(`could not reconcile ${row.reference}: ${describe(error)}`);

        if (staleSeconds !== undefined && heldForSeconds > staleSeconds) {
          stale += 1;
          this.#escalate(row, heldForSeconds, describe(error));
        }
      }
    }

    if (held.length > 0) {
      this.#logger.log(
        `reconciled ${held.length}: ${settled} settled, ${reversed} reversed, ` +
          `${stillPending} still pending, ${failed} unreachable`,
      );
    }

    return { examined: held.length, settled, reversed, stillPending, stale, failed };
  }

  /* ------------------------------------------------------------------ */

  /** Asks the provider what happened, and does only what they said. */
  async #resolve(row: HeldPurchase): Promise<'settled' | 'reversed' | 'pending'> {
    const port = this.ports.get(row.service as ServiceKind);
    if (port === undefined) {
      // The instance sweeping is not configured for this service. Someone else
      // must resolve it; guessing from here would be resolving a purchase we
      // cannot even ask about.
      throw new Error(`no port configured for ${row.service}`);
    }

    const result = await port.status(row.reference);

    if (result.status === 'delivered') {
      await this.outcomes.settle(row, result);
      return 'settled';
    }

    if (result.status === 'failed') {
      await this.outcomes.reverse(row, result.failureReason ?? 'provider reported failure');
      return 'reversed';
    }

    // Still pending. The provider has not finished, so neither have we.
    return 'pending';
  }

  /**
   * The oldest held purchases past the grace period.
   *
   * A plain SELECT, because the mutual exclusion is the session advisory lock
   * held across the whole sweep, not row locks. `SELECT ... FOR UPDATE` here
   * would be worse than useless: `pool.query` runs each statement in its own
   * implicit transaction, so the row locks would be released the moment this
   * function returned — before a single provider had been asked — while
   * reading as though they protected the work that follows.
   *
   * The lock is belt-and-braces in any case. Double-settling is already
   * impossible: the ledger's idempotency key turns the second posting into a
   * replay, and the outcome-final trigger refuses the second UPDATE. What the
   * lock prevents is two sweeps asking a provider about the same purchase and
   * one of them logging a trigger violation that reads like a bug.
   */
  async #claim(graceSeconds: number): Promise<readonly HeldPurchase[]> {
    const result = await this.pool.query<HeldPurchase>(
      `SELECT id, user_id, reference, service, amount_minor, currency,
              reserve_entry_id, created_at
         FROM purchases
        WHERE status = 'reserved'
          AND created_at < now() - make_interval(secs => $1::double precision)
        ORDER BY created_at
        LIMIT $2`,
      [graceSeconds, BATCH_SIZE],
    );
    return result.rows;
  }

  /**
   * Says loudly that a human is needed, and does nothing else.
   *
   * There is no automated action left that is safe here. The money is held,
   * the provider will not say what happened, and both remedies — release it or
   * keep it — can be the wrong one. What an operator needs is the reference to
   * take to the provider, so that is what this prints.
   */
  #escalate(row: HeldPurchase, heldForSeconds: number, reason: string): void {
    this.#logger.error(
      `STALE HELD PURCHASE ${row.reference} (${row.service}, ${row.amount_minor} ` +
        `minor ${row.currency}) has been held ${Math.round(heldForSeconds / 3600)}h: ${reason}. ` +
        `A person must resolve this with the provider.`,
    );
  }
}

interface HeldPurchase extends ReservedPurchase {
  readonly created_at: string;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
