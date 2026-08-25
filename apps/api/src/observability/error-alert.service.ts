import { Inject, Injectable, Logger } from '@nestjs/common';
import type { OnApplicationShutdown } from '@nestjs/common';
import type { Pool } from 'pg';
import { API_CONFIG, DATABASE } from '../tokens.js';
import type { ApiConfig } from '../config.js';
import { NotificationService } from '../notifications/notification.service.js';

/**
 * Telling somebody that something is failing.
 *
 * A table of errors nobody opens is a table of errors. This is the part that
 * turns it into a page somebody actually reads, and its whole design question
 * is WHEN TO SPEAK — because an alerting rule people do not trust is one they
 * mute, and a muted alert is worse than none, since it is still believed to be
 * working.
 *
 * `errors_alert_due` answers that in the schema rather than here: a
 * fingerprint nobody has been told about, or one an order of magnitude worse
 * than when we last said anything. Not "it happened again" — every open bug
 * happens again.
 */

/* Distinct from every other sweep's key. */
const SWEEP_LOCK_KEY = 8_264_100_007;

export interface ErrorAlertReport {
  readonly due: number;
  readonly sent: number;
}

interface DueRow {
  id: string;
  fingerprint: string;
  severity: string;
  message: string;
  route: string | null;
  occurrences: string;
  first_seen_at: Date;
  alerted_at: Date | null;
}

@Injectable()
export class ErrorAlertService implements OnApplicationShutdown {
  readonly #logger = new Logger(ErrorAlertService.name);
  #timer: NodeJS.Timeout | undefined;

  constructor(
    @Inject(DATABASE) private readonly pool: Pool,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(NotificationService) private readonly notifications: NotificationService,
  ) {}

  start(): void {
    const everySeconds = this.config.errorAlertIntervalSeconds;
    if (everySeconds === undefined) {
      this.#logger.warn(
        'ERROR_ALERT_INTERVAL_SECONDS is not set: failures will be RECORDED but nobody ' +
          'will be told about them. Exactly one instance must set it.',
      );
      return;
    }
    if (this.config.operationsEmail === undefined) {
      this.#logger.warn(
        'OPERATIONS_EMAIL is not set: there is nobody to alert, so failures will be ' +
          'recorded and never reported.',
      );
      return;
    }

    this.#logger.log(`checking for new failures every ${everySeconds}s`);
    this.#timer = setInterval(() => {
      void this.sweep().catch((error: unknown) => {
        this.#logger.error(`error alert sweep failed: ${describe(error)}`);
      });
    }, everySeconds * 1000);
    this.#timer.unref();
  }

  onApplicationShutdown(): void {
    if (this.#timer !== undefined) clearInterval(this.#timer);
  }

  async sweep(): Promise<ErrorAlertReport> {
    const to = this.config.operationsEmail;
    if (to === undefined) return { due: 0, sent: 0 };

    const lock = await this.pool.connect();
    try {
      const acquired = await lock.query<{ ok: boolean }>(
        `SELECT pg_try_advisory_lock($1::bigint) AS ok`,
        [SWEEP_LOCK_KEY],
      );
      if (acquired.rows[0]?.ok !== true) return { due: 0, sent: 0 };

      try {
        return await this.#sweepLocked(to);
      } finally {
        await lock.query(`SELECT pg_advisory_unlock($1::bigint)`, [SWEEP_LOCK_KEY]);
      }
    } finally {
      lock.release();
    }
  }

  async #sweepLocked(to: string): Promise<ErrorAlertReport> {
    const due = await this.pool.query<DueRow>(
      `SELECT id, fingerprint, severity::text AS severity, message, route,
              occurrences::text AS occurrences, first_seen_at, alerted_at
         FROM errors_alert_due LIMIT 20`,
    );

    let sent = 0;
    for (const row of due.rows) {
      try {
        await this.#alert(to, row);
        sent += 1;
      } catch (error) {
        // One un-sendable alert must not stop the rest. The others may be the
        // ones that matter.
        this.#logger.error(`could not alert on ${row.fingerprint}: ${describe(error)}`);
      }
    }

    return { due: due.rows.length, sent };
  }

  async #alert(to: string, row: DueRow): Promise<void> {
    const occurrences = row.occurrences;
    const isNew = row.alerted_at === null;

    await this.notifications.enqueueDetached({
      userId: null,
      recipient: to,
      // Keyed on the fingerprint AND the count at which we are speaking, so
      // the same escalation cannot be mailed twice while a later, worse one
      // still can be.
      idempotencyKey: `error_alert:${row.fingerprint}:${occurrences}`,
      request: {
        kind: 'operations_alert',
        headline: isNew
          ? `New failure on ${row.route ?? 'an unrouted request'}`
          : `A known failure is escalating on ${row.route ?? 'an unrouted request'}`,
        detail: row.message,
        occurrences,
        severity: row.severity,
        fingerprint: row.fingerprint,
      },
    });

    // Recorded AFTER the message is owed, not before. A crash between the two
    // must leave the alert un-sent and still due, never sent and forgotten —
    // the same direction of failure the outbox itself is built around.
    await this.pool.query(
      `UPDATE error_events SET alerted_at = now(), alerted_count = $2::bigint
        WHERE id = $1::bigint`,
      [row.id, occurrences],
    );
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
