import { Inject, Injectable, Logger } from '@nestjs/common';
import type { OnApplicationShutdown } from '@nestjs/common';
import type { Pool } from 'pg';
import { ProviderRejectedError } from '@xetral/providers';
import type { PayoutPort } from '@xetral/providers';
import { API_CONFIG, DATABASE, PAYOUT_PORT } from '../tokens.js';
import type { ApiConfig } from '../config.js';
import { PayoutService, type PayoutRow } from './payout.service.js';

/**
 * THE SWEEP THAT WAS NEVER WRITTEN, AND THE MONEY THAT SAT IN IT.
 *
 * THE FAILURE THIS EXISTS FOR, reported by a customer who sent money to their
 * own bank account: the balance went down and nothing arrived. Nothing was
 * lost — the reserve moved wallet → `customer_pending`, which is exactly what
 * it is supposed to do — and nothing was ever going to give it back.
 *
 * `payout.service.ts` says, at the timeout it declines to act on, "the row
 * stays `reserved` and the reconciliation sweep ASKS". Purchases have that
 * sweep. Deposits have one. Crypto withdrawals and crypto deposits each have
 * one. Bank payouts did not: the sentence described a component that was
 * never built, so a timed-out payout stayed `reserved` for ever, the money
 * stayed in pending, `ledger_drift` reported nothing because the books
 * balance perfectly, and the only thing that could see it was
 * `bank_payouts_stuck` — a view that COUNTS.
 *
 * WHY A BLIND AUTO-REVERSAL WOULD BE WORSE THAN THE BUG.
 *
 * The obvious fix — give the money back after an hour — pays the customer
 * twice whenever the bank actually sent it. A bank transfer cannot be
 * recalled, so that is a real loss and it happens precisely on the payouts
 * that DID work but answered slowly. The rule this codebase follows
 * everywhere is that a timeout means we do not know, and the answer to not
 * knowing is to ASK rather than to guess.
 *
 * So this sweep reverses on two grounds and no others:
 *
 *   1. THE PROVIDER NEVER GOT AS FAR AS A PAYOUT. `provider_payout_id` is
 *      NULL, so `send()` never returned one. A payout is quote → initialize →
 *      finalize and ONLY THE LAST MOVES MONEY; without an id from it, there is
 *      nothing at the provider that could have paid anybody. This is the
 *      common case and the one the customer hit, and it is safe.
 *
 *   2. THE PROVIDER SAYS IT FAILED. A definite answer, relayed.
 *
 * Anything else — pending, unreachable, an answer we do not understand —
 * keeps its money held and is asked again next time. Past
 * `RECONCILE_STALE_SECONDS` it is ESCALATED to a person rather than decided,
 * because by then both remaining answers can be the wrong one. That is the
 * rule `reconciliation.service.ts` states for purchases, and money leaving to
 * a bank is the flow where it matters most.
 */

interface HeldPayout extends PayoutRow {
  provider_quote_id: string | null;
  provider: string;
}

export interface PayoutReconciliationReport {
  readonly examined: number;
  readonly settled: number;
  readonly reversed: number;
  readonly stillPending: number;
  readonly stale: number;
  readonly failed: number;
}

const EMPTY: PayoutReconciliationReport = {
  examined: 0,
  settled: 0,
  reversed: 0,
  stillPending: 0,
  stale: 0,
  failed: 0,
};

/**
 * Its OWN advisory key, distinct from every other sweep's.
 *
 * Sharing one would make the deposit sweep and this one exclude each other for
 * no reason — and worse, a long deposit pass would silently mean payouts are
 * never examined, which is invisible because both report success.
 */
const SWEEP_LOCK_KEY = 8_843_120_431n;

/** Long enough that a payout still in flight is not disturbed. `send()`
 *  itself times out well inside this. */
const DEFAULT_GRACE_SECONDS = 300;

@Injectable()
export class PayoutReconciliationService implements OnApplicationShutdown {
  readonly #logger = new Logger(PayoutReconciliationService.name);
  #timer: NodeJS.Timeout | undefined;

  constructor(
    @Inject(DATABASE) private readonly pool: Pool,
    @Inject(PAYOUT_PORT) private readonly port: PayoutPort,
    @Inject(PayoutService) private readonly payouts: PayoutService,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
  ) {}

  start(): void {
    const everySeconds = this.config.payoutReconcileIntervalSeconds;
    if (everySeconds === undefined) {
      /*
       * OFF BY DEFAULT AND LOUD ABOUT IT, because the failure is silent in the
       * worst direction: with nothing sweeping, a customer's money sits held
       * and every other check stays green. Exactly one instance should set it
       * — duplicate sweeps are safe (the advisory lock serialises them and the
       * ledger's idempotency key makes a repeated posting a replay) but asking
       * a provider about the same payout from four processes is rate-limited
       * at best.
       */
      this.#logger.warn(
        'PAYOUT_RECONCILE_INTERVAL_SECONDS is not set, so nothing resolves a payout whose ' +
          'provider never answered. The money stays in customer_pending and the customer ' +
          'sees a balance that went down with nothing arriving. Set it on exactly one instance.',
      );
      return;
    }

    this.#logger.log(`reconciling held bank payouts every ${everySeconds}s`);
    this.#timer = setInterval(() => {
      void this.sweep().catch((error: unknown) => {
        // A failed sweep must never kill the timer: the queue is a database
        // view, so the rows it did not reach are still there next time.
        this.#logger.error(`payout reconciliation sweep failed: ${describe(error)}`);
      });
    }, everySeconds * 1000);
    this.#timer.unref();
  }

  onApplicationShutdown(): void {
    if (this.#timer !== undefined) clearInterval(this.#timer);
  }

  /** One pass. Exposed so a test can drive it and an operator can trigger one. */
  async sweep(): Promise<PayoutReconciliationReport> {
    const lock = await this.pool.connect();
    try {
      const acquired = await lock.query<{ ok: boolean }>(
        `SELECT pg_try_advisory_lock($1::bigint) AS ok`,
        [SWEEP_LOCK_KEY.toString()],
      );
      if (acquired.rows[0]?.ok !== true) return EMPTY;

      try {
        return await this.#sweepLocked();
      } finally {
        await lock.query(`SELECT pg_advisory_unlock($1::bigint)`, [SWEEP_LOCK_KEY.toString()]);
      }
    } finally {
      lock.release();
    }
  }

  async #sweepLocked(): Promise<PayoutReconciliationReport> {
    const graceSeconds = this.config.reconcileGraceSeconds ?? DEFAULT_GRACE_SECONDS;
    const staleSeconds = this.config.reconcileStaleSeconds;

    const held = await this.#claim(graceSeconds);
    let settled = 0;
    let reversed = 0;
    let stillPending = 0;
    let stale = 0;
    let failed = 0;

    for (const row of held) {
      const heldForSeconds = (Date.now() - row.created_at.getTime()) / 1000;
      try {
        const outcome = await this.#resolve(row);
        if (outcome === 'settled') settled += 1;
        else if (outcome === 'reversed') reversed += 1;
        else stillPending += 1;

        if (outcome === 'pending' && staleSeconds !== undefined && heldForSeconds > staleSeconds) {
          stale += 1;
          this.#escalate(row, heldForSeconds, 'the provider still reports it as pending');
        }
      } catch (error) {
        failed += 1;
        // Asking failed. The row keeps its money held and the next pass tries
        // again — an unreachable provider is not a failed payout.
        this.#logger.warn(`could not reconcile payout ${row.reference}: ${describe(error)}`);
        if (staleSeconds !== undefined && heldForSeconds > staleSeconds) {
          stale += 1;
          this.#escalate(row, heldForSeconds, describe(error));
        }
      }
    }

    if (held.length > 0) {
      this.#logger.log(
        `reconciled ${held.length} payout(s): ${settled} settled, ${reversed} reversed, ` +
          `${stillPending} still pending, ${failed} unreachable`,
      );
    }
    return { examined: held.length, settled, reversed, stillPending, stale, failed };
  }

  /* ------------------------------------------------------------------ */

  async #resolve(row: HeldPayout): Promise<'settled' | 'reversed' | 'pending'> {
    /*
     * NO PAYOUT ID MEANS NO PAYOUT, and this is the branch that gives the
     * customer their money back.
     *
     * `send()` returns the provider's id for the transfer. Without one, the
     * call that MOVES MONEY either never happened or never answered — and a
     * payout is quote → initialize → finalize, with only the last moving
     * anything, which is why those ids are separate columns rather than one
     * "provider reference": collapsed, they could not say which call a dying
     * process got through, and that is the only question that matters here.
     *
     * A quote id without a payout id is the same answer: quoted, possibly
     * initialized, never finalized.
     */
    if (row.provider_payout_id === null) {
      await this.payouts.fail(
        row,
        'the provider never returned a payout id, so nothing was ever sent',
      );
      this.#logger.warn(
        `payout ${row.reference} reversed: no provider payout id after ` +
          `${Math.round((Date.now() - row.created_at.getTime()) / 60000)} minutes, so the ` +
          `transfer was never finalised and the money is back in the customer's wallet`,
      );
      return 'reversed';
    }

    let receipt;
    try {
      receipt = await this.port.status(row.provider_payout_id);
    } catch (error) {
      /*
       * A REJECTION IS AN ANSWER. "No such payout" from a provider that issued
       * us the id is them saying it does not exist — reversible. Every other
       * error is us being unable to ask, which is not an outcome.
       */
      if (error instanceof ProviderRejectedError) {
        await this.payouts.fail(row, `the provider refused it: ${error.message}`);
        return 'reversed';
      }
      throw error;
    }

    // `state`, not `status`: the receipt describes what the PROVIDER did, and
    // `bank_payouts.status` is what WE recorded. Naming them the same thing is
    // how a settle gets written from the wrong one.
    if (receipt.state === 'failed') {
      await this.payouts.fail(row, receipt.failureReason ?? 'the provider reported it failed');
      return 'reversed';
    }
    if (receipt.state === 'completed' || receipt.state === 'sent') {
      // Settling is idempotent: `applyReceipt` guards on `status = 'reserved'`
      // and the ledger key makes a repeated posting a replay.
      await this.payouts.applyReceipt(row, receipt);
      return 'settled';
    }
    return 'pending';
  }

  /**
   * The queue, as a plain SELECT.
   *
   * `FOR UPDATE SKIP LOCKED` would protect nothing: `pool.query` runs each
   * statement in its own implicit transaction, so those row locks release the
   * moment this returns — before a single provider has been asked — while
   * reading in review as though they guarded the work that follows. The
   * session advisory lock held across the whole sweep is the mutual exclusion.
   */
  async #claim(graceSeconds: number): Promise<readonly HeldPayout[]> {
    const rows = await this.pool.query<HeldPayout>(
      `SELECT id::text, uuid, user_id::text, reference, status::text, country,
              bank_code, bank_name, account_number, account_name, narration,
              currency, amount_minor::text, fee_minor::text, tax_minor::text,
              provider_quote_id, provider_payout_id, provider, failure_reason,
              reserve_entry_id::text, created_at
         FROM bank_payouts
        WHERE status IN ('reserved', 'sent')
          AND created_at < now() - make_interval(secs => $1)
        ORDER BY created_at
        LIMIT 100`,
      [graceSeconds],
    );
    return rows.rows;
  }

  /**
   * Held past the point where a sweep should keep deciding on its own.
   *
   * Deliberately NOT an automated action. By the time a payout has been
   * pending this long, every automated answer has been tried and both
   * remaining ones can be the wrong one — so it goes to `/admin/recovery`
   * with its age, and a person decides with a button.
   */
  #escalate(row: HeldPayout, heldForSeconds: number, reason: string): void {
    this.#logger.error(
      `PAYOUT ${row.reference} HAS BEEN HELD FOR ${Math.round(heldForSeconds / 3600)}h ` +
        `and needs a person: ${reason}. ${row.amount_minor} ${row.currency} is in ` +
        `customer_pending for user ${row.user_id}. Resolve it on /admin/recovery.`,
    );
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
