import { Inject, Injectable, Logger } from '@nestjs/common';
import type { OnApplicationShutdown } from '@nestjs/common';
import type { Pool } from 'pg';
import type { PushPort } from '@xetral/providers';
import type { ApiConfig } from '../config.js';
import { API_CONFIG, DATABASE, PUSH_PORT } from '../tokens.js';
import { PushService } from './push.service.js';

/**
 * The lock is a CORRECTNESS requirement here, unlike the monitoring sweep's.
 *
 * Two workers claiming the same undrained broadcast would each expand the
 * audience and each send it, and the second write is refused by 065's trigger
 * — so the customer gets the announcement twice and one worker logs an error
 * about a row it already sent. `FOR UPDATE SKIP LOCKED` inside a transaction
 * is what makes the claim exclusive; the advisory lock on top keeps four
 * instances from all walking the queue.
 */
const SWEEP_LOCK_KEY = 6_505_001;

export interface BroadcastRunReport {
  readonly drained: number;
  readonly accepted: number;
  readonly rejected: number;
}

/**
 * DRAINING WHAT AN OPERATOR QUEUED.
 *
 * 065's row is the queue and this is the only thing that empties it. The
 * shape is 012's outbox worker, and the reasons are the same: sending inside
 * the request makes a click wait on thousands of calls, and sending after the
 * transaction loses announcements when a process dies in the gap.
 *
 * AND IT IS OFF UNTIL SOMEBODY SETS AN INTERVAL. That is the failure worth
 * naming: with `PUSH_BROADCAST_INTERVAL_SECONDS` unset on every instance the
 * row is written, the endpoint answers, the screen says "queued", and nothing
 * is ever delivered. Nothing errors, because writing the row succeeded — the
 * exact shape `NOTIFICATION_INTERVAL_SECONDS` has, which the go-live checklist
 * files under `silent`. `push_broadcasts_stuck` is the only thing that sees
 * it.
 */
@Injectable()
export class PushBroadcastService implements OnApplicationShutdown {
  readonly #logger = new Logger(PushBroadcastService.name);
  #timer: NodeJS.Timeout | undefined;

  constructor(
    @Inject(DATABASE) private readonly pool: Pool,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(PUSH_PORT) private readonly push: PushPort,
    @Inject(PushService) private readonly devices: PushService,
  ) {}

  start(): void {
    const everySeconds = this.config.pushBroadcastIntervalSeconds;
    if (everySeconds === undefined) {
      this.#logger.warn(
        'PUSH_BROADCAST_INTERVAL_SECONDS is not set: ANNOUNCEMENTS ARE NOT ' +
          'BEING SENT. A broadcast an operator queues is written, answered ' +
          'and never delivered, and nothing errors. Set it on exactly one ' +
          'instance.',
      );
      return;
    }
    this.#logger.log(`draining queued broadcasts every ${everySeconds}s`);
    this.#timer = setInterval(() => {
      void this.run().catch((error: unknown) => {
        this.#logger.error(`broadcast sweep failed: ${describe(error)}`);
      });
    }, everySeconds * 1000);
    this.#timer.unref();
  }

  onApplicationShutdown(): void {
    if (this.#timer !== undefined) clearInterval(this.#timer);
  }

  async run(): Promise<BroadcastRunReport> {
    const lock = await this.pool.connect();
    try {
      const acquired = await lock.query<{ ok: boolean }>(
        `SELECT pg_try_advisory_lock($1::bigint) AS ok`,
        [SWEEP_LOCK_KEY],
      );
      if (acquired.rows[0]?.ok !== true) return { drained: 0, accepted: 0, rejected: 0 };

      try {
        let drained = 0;
        let accepted = 0;
        let rejected = 0;

        // Oldest first, one at a time. A broadcast is a large piece of work
        // and doing several in parallel from one worker only makes the push
        // service rate limit us.
        for (;;) {
          const next = await this.#claim();
          if (next === undefined) break;
          const done = await this.#deliver(next);
          drained += 1;
          accepted += done.accepted;
          rejected += done.rejected;
        }
        return { drained, accepted, rejected };
      } finally {
        await lock.query(`SELECT pg_advisory_unlock($1::bigint)`, [SWEEP_LOCK_KEY]);
      }
    } finally {
      lock.release();
    }
  }

  async #claim(): Promise<Claimed | undefined> {
    const result = await this.pool.query<{
      id: string;
      title: string;
      body: string;
      country: string | null;
    }>(
      `SELECT id, title, body, country
         FROM push_broadcasts
        WHERE sent_at IS NULL
        ORDER BY created_at
        LIMIT 1`,
    );
    const row = result.rows[0];
    if (row === undefined) return undefined;
    return { id: row.id, title: row.title, body: row.body, country: row.country };
  }

  async #deliver(broadcast: Claimed): Promise<{ accepted: number; rejected: number }> {
    /*
     * THE AUDIENCE AND THE SKIPPED COUNT COME FROM ONE PAIR OF QUERIES OVER
     * THE SAME DEFINITION.
     *
     * `push_audience` already answers "live handset, active customer, live
     * marketing grant". The skipped figure is the difference between that and
     * every live handset in the same country — which is what lets an operator
     * seeing "4,000 devices" where they expected 12,000 learn that the
     * difference is CONSENT rather than a broken integration.
     */
    const audience = await this.pool.query<{ token: string }>(
      `SELECT token FROM push_audience
        WHERE $1::char(2) IS NULL OR country = $1::char(2)`,
      [broadcast.country],
    );
    const withoutConsent = await this.pool.query<{ n: string }>(
      `SELECT count(*) AS n
         FROM push_devices d
         JOIN users u ON u.id = d.user_id
        WHERE d.revoked_at IS NULL
          AND u.status = 'active'
          AND ($1::char(2) IS NULL OR u.country = $1::char(2))
          AND NOT EXISTS (
                SELECT 1 FROM customer_consents c
                 WHERE c.user_id = u.id
                   AND c.kind = 'marketing_email'
                   AND c.granted
              )`,
      [broadcast.country],
    );

    const tokens = audience.rows.map((r) => r.token);
    const skipped = Number(withoutConsent.rows[0]?.n ?? 0);

    if (tokens.length === 0) {
      // Still marked sent. A broadcast with nobody to tell is finished, not
      // stuck — leaving it queued would fill `push_broadcasts_stuck` with rows
      // that will never drain, and a watch with permanent entries is a watch
      // nobody reads.
      await this.#finish(broadcast.id, { devices: 0, accepted: 0, rejected: 0, skipped });
      return { accepted: 0, rejected: 0 };
    }

    let outcomes;
    try {
      outcomes = await this.push.send(
        { title: broadcast.title, body: broadcast.body },
        tokens,
      );
    } catch (error: unknown) {
      /*
       * THE WHOLE SEND FAILED, so nothing is marked and the row stays queued.
       *
       * That is deliberate and is the opposite of the money rule: for a
       * payout, not knowing whether the provider acted means do nothing. Here
       * the cost of asking again is that somebody sees an announcement twice
       * and the cost of not asking is that nobody hears anything — 012's one
       * inversion, applied to the other channel.
       *
       * The provider's sentence goes to the log because it names our
       * integration, and to `failure_reason` on the next attempt only if the
       * row is finished. Left queued, `push_broadcasts_stuck` sees it.
       */
      this.#logger.error(
        `broadcast ${broadcast.id} was not sent and stays queued: ${describe(error)}`,
      );
      return { accepted: 0, rejected: 0 };
    }

    const gone = outcomes.filter((o) => o.deviceGone).map((o) => o.token);
    await this.devices.retire(gone);

    const acceptedCount = outcomes.filter((o) => o.accepted).length;
    const rejectedCount = outcomes.length - acceptedCount;

    await this.#finish(broadcast.id, {
      devices: tokens.length,
      accepted: acceptedCount,
      rejected: rejectedCount,
      skipped,
    });

    this.#logger.log(
      `broadcast ${broadcast.id}: ${acceptedCount} accepted, ${rejectedCount} refused, ` +
        `${gone.length} handset(s) retired, ${skipped} customer(s) skipped for consent`,
    );
    return { accepted: acceptedCount, rejected: rejectedCount };
  }

  async #finish(
    id: string,
    counts: { devices: number; accepted: number; rejected: number; skipped: number },
  ): Promise<void> {
    // `sent_at IS NULL` in the WHERE as well as the trigger: the trigger is
    // what makes it impossible, and this is what makes a lost race a no-op
    // rather than an exception in a worker log.
    await this.pool.query(
      `UPDATE push_broadcasts
          SET sent_at = now(), devices = $2, accepted = $3, rejected = $4,
              without_consent = $5
        WHERE id = $1 AND sent_at IS NULL`,
      [id, counts.devices, counts.accepted, counts.rejected, counts.skipped],
    );
  }
}

interface Claimed {
  id: string;
  title: string;
  body: string;
  country: string | null;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
