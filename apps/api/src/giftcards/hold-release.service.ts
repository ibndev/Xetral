import { Inject, Injectable, Logger } from '@nestjs/common';
import type { OnApplicationShutdown } from '@nestjs/common';
import type { Pool } from 'pg';
import { LedgerService, posting } from '@xetral/ledger';
import type { Currency, Money } from '@xetral/shared';
import { API_CONFIG, DATABASE, LEDGER } from '../tokens.js';
import type { ApiConfig } from '../config.js';

/**
 * Releasing gift card holds that have matured.
 *
 * The counterpart to the hold itself: money parked in `customer_pending` at
 * approval has to become spendable at some point, and nothing else in the
 * system will do it. Without this worker, "ships flagged off" would mean
 * "customers are paid and can never spend it", which is worse than not
 * shipping the feature.
 *
 * WHAT IT WILL NOT DO
 * -------------------
 * It does not decide whether a hold has matured. `giftcard_holds_due` selects
 * on `now()` in the database, and the state-machine trigger refuses a release
 * whose `hold_until` has not passed — so a worker on a box with a skewed clock
 * cannot release anything early. That belt-and-braces is deliberate: the hold
 * period is the only fraud control still standing once a card has been
 * approved, and a process that could shorten it by accident is not a control.
 */

const BATCH_SIZE = 100;

/** One sweep at a time, anywhere. Same reasoning as the reconciliation
 *  worker's lock, and a different key so the two never block each other. */
const SWEEP_LOCK_KEY = 8_264_100_002;

export interface HoldReleaseReport {
  readonly released: number;
  readonly failed: number;
}

interface DueHold {
  submission_id: string;
  user_id: string;
  reference: string;
  payout_amount_minor: string;
  payout_currency: string;
}

@Injectable()
export class GiftCardHoldService implements OnApplicationShutdown {
  readonly #logger = new Logger(GiftCardHoldService.name);
  #timer: NodeJS.Timeout | undefined;

  constructor(
    @Inject(DATABASE) private readonly pool: Pool,
    @Inject(LEDGER) private readonly ledger: LedgerService,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
  ) {}

  start(): void {
    // The flag is read from settings at sweep time, not at boot, so turning
    // gift cards off stops new releases without a restart.
    if (!this.config.giftCardsEnabled) return;

    const everySeconds = this.config.giftCardReleaseIntervalSeconds;
    if (everySeconds === undefined) {
      // Loud, because the failure mode is silent and slow: customers are paid,
      // the money shows as pending, and nothing ever makes it spendable.
      this.#logger.warn(
        'gift cards are ENABLED but GIFTCARD_RELEASE_INTERVAL_SECONDS is not set: ' +
          'approved payouts will stay held for ever. Exactly one instance must set it.',
      );
      return;
    }

    this.#logger.log(`releasing matured gift card holds every ${everySeconds}s`);
    this.#timer = setInterval(() => {
      void this.sweep().catch((error: unknown) => {
        this.#logger.error(`hold release sweep failed: ${describe(error)}`);
      });
    }, everySeconds * 1000);
    this.#timer.unref();
  }

  onApplicationShutdown(): void {
    if (this.#timer !== undefined) clearInterval(this.#timer);
  }

  async sweep(): Promise<HoldReleaseReport> {
    const lock = await this.pool.connect();
    try {
      const acquired = await lock.query<{ ok: boolean }>(
        `SELECT pg_try_advisory_lock($1::bigint) AS ok`,
        [SWEEP_LOCK_KEY],
      );
      if (acquired.rows[0]?.ok !== true) return { released: 0, failed: 0 };

      try {
        return await this.#sweepLocked();
      } finally {
        await lock.query(`SELECT pg_advisory_unlock($1::bigint)`, [SWEEP_LOCK_KEY]);
      }
    } finally {
      lock.release();
    }
  }

  async #sweepLocked(): Promise<HoldReleaseReport> {
    const due = await this.pool.query<DueHold>(
      `SELECT submission_id::text, user_id::text, reference,
              payout_amount_minor::text, payout_currency
         FROM giftcard_holds_due LIMIT $1`,
      [BATCH_SIZE],
    );

    let released = 0;
    let failed = 0;

    for (const hold of due.rows) {
      try {
        await this.#release(hold);
        released += 1;
      } catch (error) {
        // One bad row must not stop the rest: a customer whose release fails
        // is a customer whose money stays held, and the others are waiting.
        failed += 1;
        this.#logger.error(`could not release hold ${hold.reference}: ${describe(error)}`);
      }
    }

    if (released > 0) this.#logger.log(`released ${released} matured gift card hold(s)`);
    return { released, failed };
  }

  /** pending -> wallet. The money was always the customer's; this is the
   *  moment it becomes spendable. */
  async #release(hold: DueHold): Promise<void> {
    const currency = hold.payout_currency as Currency;
    const amount: Money<Currency> = {
      amount: BigInt(hold.payout_amount_minor),
      currency,
    };

    const posted = await this.ledger.post({
      idempotencyKey: `giftcard-release:${hold.reference}`,
      kind: 'giftcard_hold_release',
      occurredAt: new Date(),
      description: 'gift card hold released',
      metadata: { reference: hold.reference },
      postings: [
        posting(
          { kind: 'customer_pending', ownerId: hold.user_id, currency },
          { amount: -amount.amount, currency },
        ),
        posting({ kind: 'customer_wallet', ownerId: hold.user_id, currency }, amount),
      ],
    });

    // The trigger re-checks hold_until against the database clock, so a row
    // that matured between the SELECT and here is still safe, and one that did
    // not is refused rather than released.
    await this.pool.query(
      `UPDATE giftcard_submissions
          SET status = 'released', release_entry_id = $2::bigint
        WHERE id = $1::bigint AND status = 'approved'`,
      [hold.submission_id, posted.entryId],
    );
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
