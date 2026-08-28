import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { seal } from '@xetral/identity';
import { API_CONFIG, DATABASE, NOTIFICATION_PORT } from '../tokens.js';
import type { NotificationPort } from '@xetral/providers';
import type { ApiConfig } from '../config.js';
import { classOf, render } from './templates.js';
import type { NotificationRequest } from './templates.js';

/**
 * Owing a customer a message.
 *
 * This service does NOT send anything. It writes a row saying a message is
 * owed, in the caller's transaction, and `NotificationWorker` sends it later.
 * The reasoning is in the header of `012_notifications.sql`; the short version
 * is that sending inside the transaction mails receipts for money that then
 * rolls back, sending after it loses messages when the process dies in the
 * gap, and either way a slow provider becomes a slow login.
 */

/** Anything that can run a query: a pool, or one transaction's client. */
export interface Queryable {
  query(text: string, values?: readonly unknown[]): Promise<{ rows: unknown[] }>;
}

export interface OutboundNotification {
  /** Null when the address has no account — see `enqueue`'s note on why that
   *  is allowed rather than an error. */
  readonly userId: string | null;
  readonly recipient: string;
  /**
   * OURS, and the thing that makes enqueueing safe to retry. Derive it from
   * the event, never from a clock or a random value: two requests racing to
   * tell a customer the same thing must produce one row, and a retry after a
   * crash must find the row it already wrote rather than write a second.
   */
  readonly idempotencyKey: string;
  readonly request: NotificationRequest;
}

@Injectable()
export class NotificationService {
  readonly #logger = new Logger(NotificationService.name);

  constructor(
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(DATABASE) private readonly pool: Pool,
    @Inject(NOTIFICATION_PORT) private readonly port: NotificationPort | undefined,
  ) {}

  /** Whether messages can be ENQUEUED. False without an encryption keyring,
   *  because an unsealed body cannot reach a row. */
  get available(): boolean {
    return this.config.encryptionKeyring !== undefined;
  }

  /**
   * Whether anything will actually SEND what is enqueued.
   *
   * SEPARATE FROM `available`, and the distinction is one that booting the
   * bundle found rather than any test. With a keyring but no email provider,
   * enqueueing succeeds — correctly, the message is owed and waits — but
   * nothing drains it. Password reset checked only `available` and therefore
   * answered "check your email" to a customer whose reset was going nowhere:
   * a locked-out customer told to wait for mail that does not exist, which is
   * worse than being told the feature is unavailable.
   *
   * A flow whose whole purpose is the message must ask THIS question.
   */
  get deliverable(): boolean {
    return this.available && this.port !== undefined;
  }

  /**
   * Enqueue a message, failing loudly if it cannot be enqueued.
   *
   * Use this where the message IS the point — a password reset, where
   * answering "check your email" while writing nothing would leave a customer
   * waiting for mail that is never coming.
   *
   * Pass the surrounding transaction's client whenever there is one. That is
   * what makes the message and the event it describes atomic: no committed
   * event without its message, and no message for an event that rolled back.
   */
  async enqueue(q: Queryable, message: OutboundNotification): Promise<void> {
    const keyring = this.config.encryptionKeyring;
    if (keyring === undefined) {
      throw new Error(
        'ENCRYPTION_KEYS is not set, so a notification body cannot be sealed and no ' +
          'message can be enqueued. This blocks password reset entirely.',
      );
    }

    const rendered = render(message.request);
    // Subject, text and html sealed together as one envelope. A rendered
    // password reset email contains a live bearer token; the schema's
    // `^v[0-9]+:` CHECK is what stops one reaching a row in the clear, and
    // this is the other half of it.
    const payload = seal(JSON.stringify(rendered), keyring);

    await q.query(
      `INSERT INTO notification_outbox
         (user_id, kind, class, recipient, payload_sealed, idempotency_key)
       VALUES ($1::bigint, $2::notification_kind, $3::notification_class, $4, $5, $6)
       ON CONFLICT (idempotency_key) DO NOTHING`,
      [
        message.userId,
        message.request.kind,
        classOf(message.request.kind),
        message.recipient,
        payload,
        message.idempotencyKey,
      ],
    );
  }

  /**
   * Enqueue a message that must never be able to fail the thing it describes.
   *
   * THE TRAP THIS EXISTS FOR, and it is not obvious from JavaScript.
   *
   * A receipt is worth less than the transfer it reports, so the instinct is
   * to wrap the insert in try/catch and carry on. In Postgres that does not
   * work: ANY error inside a transaction poisons it, and every subsequent
   * statement fails with "current transaction is aborted" until it rolls back.
   * Catching the exception in TypeScript does not un-abort anything. A
   * best-effort receipt written that way would take the customer's transfer
   * down with it — the exact inversion of what it was for.
   *
   * A SAVEPOINT is what actually makes it best-effort. The insert gets its own
   * rollback point, so a failure discards the receipt and leaves the money
   * movement untouched and committable.
   *
   * Requires a real client rather than a pool: `pool.query` runs each
   * statement in its own implicit transaction, so a SAVEPOINT taken on one
   * would guard nothing.
   */
  async enqueueBestEffort(client: PoolClient, message: OutboundNotification): Promise<void> {
    if (!this.available) {
      // Loud rather than silent: a deployment with no keyring sends no
      // receipts and no security alerts, and that should not be something an
      // operator discovers from a customer complaint.
      this.#logger.warn(
        `no encryption keyring: ${message.request.kind} for user ${message.userId ?? 'unknown'} ` +
          `will not be sent`,
      );
      return;
    }

    const savepoint = 'notify_enqueue';
    await client.query(`SAVEPOINT ${savepoint}`);
    try {
      await this.enqueue(client, message);
      await client.query(`RELEASE SAVEPOINT ${savepoint}`);
    } catch (error) {
      await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
      this.#logger.error(
        `could not enqueue ${message.request.kind}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /** Enqueue outside any transaction. For events that are not themselves a
   *  database write — a sign-in from a new device, noticed after the fact. */
  async enqueueDetached(message: OutboundNotification): Promise<void> {
    if (!this.available) {
      this.#logger.warn(`no encryption keyring: ${message.request.kind} will not be sent`);
      return;
    }
    try {
      await this.enqueue(this.pool, message);
    } catch (error) {
      this.#logger.error(
        `could not enqueue ${message.request.kind}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}
