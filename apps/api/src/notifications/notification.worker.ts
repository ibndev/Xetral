import { Inject, Injectable, Logger } from '@nestjs/common';
import type { OnApplicationShutdown } from '@nestjs/common';
import type { Pool } from 'pg';
import { open } from '@xetral/identity';
import { ProviderError } from '@xetral/providers';
import type { NotificationPort } from '@xetral/providers';
import { API_CONFIG, DATABASE, NOTIFICATION_PORT } from '../tokens.js';
import type { ApiConfig } from '../config.js';
import type { RenderedNotification } from './templates.js';

/**
 * Draining the outbox.
 *
 * The worker's whole authority is: take a message that is due, send it, record
 * what happened. It never decides what to send, never re-addresses anything,
 * and never composes — all of that was settled inside the transaction that
 * owed the message, and the schema refuses to let it be changed afterwards.
 */

/* Distinct from every other sweep's key so two workers cannot lock each other
   out of unrelated work. */
const SWEEP_LOCK_KEY = 8_264_100_006;

/**
 * How long to wait after each failed attempt, in seconds.
 *
 * Explicit rather than computed, so the shape of the retreat is visible: four
 * attempts inside the first ten minutes, then hours. The early ones catch a
 * provider blip while a customer is still sitting on the password-reset screen
 * refreshing their inbox; the later ones are for an outage, where hammering
 * achieves nothing and the mail will go out when it is over.
 *
 * The length of the list IS the attempt ceiling.
 */
const BACKOFF_SECONDS = [30, 120, 600, 3_600, 21_600] as const;

export interface NotificationSweepReport {
  readonly claimed: number;
  readonly sent: number;
  readonly retrying: number;
  readonly abandoned: number;
}

interface DueRow {
  id: string;
  kind: string;
  class: string;
  recipient: string;
  payload_sealed: string;
  attempts: number;
}

@Injectable()
export class NotificationWorker implements OnApplicationShutdown {
  readonly #logger = new Logger(NotificationWorker.name);
  #timer: NodeJS.Timeout | undefined;

  constructor(
    @Inject(DATABASE) private readonly pool: Pool,
    @Inject(NOTIFICATION_PORT) private readonly port: NotificationPort | undefined,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
  ) {}

  start(): void {
    const everySeconds = this.config.notificationIntervalSeconds;
    if (everySeconds === undefined) {
      this.#logger.warn(
        'NOTIFICATION_INTERVAL_SECONDS is not set: nothing on this instance sends ' +
          'queued email. Password reset links, new-device alerts and receipts will be ' +
          'written and never delivered. Exactly one instance must set it.',
      );
      return;
    }
    if (this.port === undefined) {
      this.#logger.warn(
        'no email provider is configured: queued messages will not be sent. Password ' +
          'reset is unavailable.',
      );
      return;
    }

    if (this.config.environment === 'staging') {
      const allowed = this.config.notificationAllowlist;
      if (allowed.length === 0) {
        this.#logger.warn(
          'staging with an EMPTY NOTIFICATION_ALLOWLIST: no email will be sent to ' +
            'anybody. That is the safe default — a staging database restored from a ' +
            'production backup would otherwise mail every real customer — but set it ' +
            'if you want to receive anything.',
        );
      } else {
        this.#logger.log(`staging: email restricted to ${allowed.join(', ')}`);
      }
    }

    this.#logger.log(`sending queued notifications every ${everySeconds}s`);
    this.#timer = setInterval(() => {
      void this.sweep().catch((error: unknown) => {
        this.#logger.error(`notification sweep failed: ${describe(error)}`);
      });
    }, everySeconds * 1000);
    this.#timer.unref();
  }

  onApplicationShutdown(): void {
    if (this.#timer !== undefined) clearInterval(this.#timer);
  }

  /**
   * In STAGING, who may actually be emailed.
   *
   * THE FAILURE THIS PREVENTS is specific and common. A staging database is
   * usually restored from a production backup, because that is the only way to
   * test against realistic data — and the moment it is, this worker is holding
   * every real customer's address and a queue of messages about transfers that
   * never happened. It will send them. The recipients never consented to hear
   * from a test system, and there is no way to un-send it.
   *
   * A suffix match, so a team can use `@xetral.com` and plus-addressing without
   * maintaining a list of individuals. An EMPTY allowlist in staging means
   * nothing is sent at all, which is the safe direction to be wrong in.
   *
   * Production is unrestricted, because restricting delivery there would be the
   * bug.
   */
  #mayDeliverTo(recipient: string): boolean {
    if (this.config.environment !== 'staging') return true;

    const address = recipient.trim().toLowerCase();
    return this.config.notificationAllowlist.some(
      (allowed) => address === allowed || address.endsWith(allowed),
    );
  }

  /**
   * One pass.
   *
   * A session advisory lock, for the same reason as every other sweep here:
   * `pool.query` runs each statement in its own implicit transaction, so
   * `SELECT ... FOR UPDATE SKIP LOCKED` would release its row locks the moment
   * the claim query returned — before a single message had been sent — while
   * reading in review as though it guarded the work that follows.
   */
  async sweep(): Promise<NotificationSweepReport> {
    const empty = { claimed: 0, sent: 0, retrying: 0, abandoned: 0 };
    if (this.port === undefined) return empty;

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

  async #sweepLocked(): Promise<NotificationSweepReport> {
    const due = await this.pool.query<DueRow>(
      `SELECT id, kind::text AS kind, class::text AS class, recipient,
              payload_sealed, attempts
         FROM notification_outbox
        WHERE status = 'pending' AND next_attempt_at <= now()
        -- Security mail first. If the queue is behind, the customer locked out
        -- of their account is served before the customer waiting on a receipt.
        ORDER BY (class = 'security') DESC, id
        LIMIT 100`,
    );

    let sent = 0;
    let retrying = 0;
    let abandoned = 0;

    for (const row of due.rows) {
      const outcome = await this.#deliver(row);
      if (outcome === 'sent') sent += 1;
      else if (outcome === 'abandoned') abandoned += 1;
      else retrying += 1;
    }

    if (abandoned > 0) {
      // Worth a distinct line: an abandoned message is one nobody received and
      // nobody will. `notifications_abandoned` is the view to read next.
      this.#logger.error(
        `${abandoned} notification(s) abandoned after ${BACKOFF_SECONDS.length} attempts`,
      );
    }

    return { claimed: due.rows.length, sent, retrying, abandoned };
  }

  async #deliver(row: DueRow): Promise<'sent' | 'retry' | 'abandoned'> {
    const keyring = this.config.encryptionKeyring;
    if (keyring === undefined || this.port === undefined) return 'retry';

    if (!this.#mayDeliverTo(row.recipient)) {
      // ABANDONED rather than retried: the address will not become allowed by
      // waiting, and leaving it pending would fill the queue with messages
      // that can never go out and hide the ones that could.
      return await this.#abandon(
        row,
        `staging will not send to ${row.recipient}: not on NOTIFICATION_ALLOWLIST`,
      );
    }

    let rendered: RenderedNotification;
    try {
      rendered = JSON.parse(open(row.payload_sealed, keyring)) as RenderedNotification;
    } catch (error) {
      // Undecryptable: a key was retired while a message was still queued.
      // Retrying cannot fix it, so it is recorded as a failure and allowed to
      // reach the ceiling rather than spinning for ever.
      return await this.#failed(row, `could not open the sealed body: ${describe(error)}`);
    }

    try {
      const receipt = await this.port.send({
        to: row.recipient,
        subject: rendered.subject,
        text: rendered.text,
        html: rendered.html,
        // The OUTBOX ROW ID. A worker that crashes between the provider
        // accepting the message and this transaction recording it retries the
        // same row with the same key, and the provider recognises the repeat
        // rather than mailing the customer a second time.
        idempotencyKey: `xetral:notification:${row.id}`,
      });

      await this.pool.query(
        `UPDATE notification_outbox
            SET status = 'sent',
                sent_at = now(),
                attempts = attempts + 1,
                provider = $2,
                provider_message_id = $3,
                -- The body is dropped, not kept. A delivered password reset
                -- link has no reason to stay in the database, and the safest
                -- place for a bearer token is nowhere.
                payload_sealed = NULL
          WHERE id = $1::bigint AND status = 'pending'`,
        [row.id, this.port.provider, receipt.providerMessageId],
      );
      return 'sent';
    } catch (error) {
      if (error instanceof ProviderError && !error.retryable) {
        // A refusal a retry cannot clear — an unverified sending domain, a
        // malformed address. Straight to the ceiling rather than five more
        // identical rejections over six hours.
        return await this.#abandon(row, describe(error));
      }
      return await this.#failed(row, describe(error));
    }
  }

  /** Record a failure and schedule the next attempt, or give up. */
  async #failed(row: DueRow, reason: string): Promise<'retry' | 'abandoned'> {
    const nextAttempt = row.attempts + 1;
    if (nextAttempt >= BACKOFF_SECONDS.length) return await this.#abandon(row, reason);

    const delay = BACKOFF_SECONDS[nextAttempt] ?? BACKOFF_SECONDS[BACKOFF_SECONDS.length - 1] ?? 60;
    await this.pool.query(
      `UPDATE notification_outbox
          SET attempts = attempts + 1,
              next_attempt_at = now() + make_interval(secs => $2::int),
              last_error = $3
        WHERE id = $1::bigint AND status = 'pending'`,
      [row.id, delay, truncate(reason)],
    );
    return 'retry';
  }

  async #abandon(row: DueRow, reason: string): Promise<'abandoned'> {
    await this.pool.query(
      `UPDATE notification_outbox
          SET status = 'abandoned',
              attempts = attempts + 1,
              last_error = $2,
              -- Cleared here too. An abandoned password reset still holds a
              -- live token, and it is going to sit in this table for as long
              -- as anyone leaves it there.
              payload_sealed = NULL
        WHERE id = $1::bigint AND status = 'pending'`,
      [row.id, truncate(reason)],
    );
    this.#logger.error(`notification ${row.id} (${row.kind}) abandoned: ${truncate(reason)}`);
    return 'abandoned';
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** `last_error` is for an operator reading a queue, not a place to store a
 *  provider's entire response body. */
function truncate(reason: string): string {
  return reason.length > 500 ? `${reason.slice(0, 497)}...` : reason;
}
