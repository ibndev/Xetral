import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { Pool } from 'pg';
import { DATABASE } from '../tokens.js';

export interface PushDeviceView {
  readonly platform: string;
  readonly last_seen_at: string;
}

export interface BroadcastView {
  readonly uuid: string;
  readonly title: string;
  readonly body: string;
  readonly country: string | null;
  readonly created_at: string;
  readonly sent_at: string | null;
  /** When it is due — in the feed from then, and pushed from then. */
  readonly send_at: string;
  readonly cancelled_at: string | null;
  readonly devices: number;
  readonly accepted: number;
  readonly rejected: number;
  readonly without_consent: number;
  readonly failure_reason: string | null;
}

/**
 * An announcement as a CUSTOMER reads it: what was said and when, and nothing
 * about who pressed the button or how many handsets it reached — those are
 * operations figures, and a customer's feed is not the place to publish the
 * size of the audience.
 */
export interface AnnouncementView {
  readonly uuid: string;
  readonly title: string;
  readonly body: string;
  readonly at: string;
}

export interface AudienceEstimate {
  /** Handsets a PUSH reaches: a live token and a live marketing grant. */
  readonly devices: number;
  /** The customers holding those handsets. */
  readonly customers: number;
  /**
   * Customers who will see it in the app's bell feed — every active customer
   * in the audience, because that feed is not consent-gated. This is the
   * figure that was missing: with no push token registered anywhere, the
   * screen read "0 customers" about an announcement every customer would see.
   */
  readonly in_app: number;
}

/**
 * Handsets, and the announcements sent to them.
 *
 * NOTHING HERE SENDS. An endpoint writes a row and `PushBroadcastService`
 * drains it — 012's rule, and it matters more at this size: a broadcast is
 * thousands of HTTP calls, and an operator's click must not wait on them, nor
 * a dying process leave nobody able to say who was reached.
 */
@Injectable()
export class PushService {
  readonly #logger = new Logger(PushService.name);
  #scheduled: { readonly has: boolean; readonly at: number } | undefined;

  constructor(@Inject(DATABASE) private readonly pool: Pool) {}

  /**
   * WHETHER 087 IS APPLIED — `send_at` and `cancelled_at` exist.
   *
   * Production applies migrations by hand, and the list of announcements
   * answered 500 on "column send_at does not exist" the day the code that
   * reads it shipped ahead of the file that adds it. The admin list, the
   * customer's bell feed and the worker all read these columns, so a skipped
   * migration took out every one of them at once — the fault 069 made on
   * `/admin/providers`, one migration later.
   *
   * So each query is written twice, and behind 087 the old shape is used:
   * every row was due when it was written (087's own backfill says exactly
   * that) and none was ever cancelled. What cannot be served is a schedule,
   * and that is refused by name rather than by a 500.
   *
   * `pg_attribute`, not `information_schema`: the second shows only columns
   * the role holds a privilege on, which is a question about grants rather
   * than about the schema. Present is cached for good — a column is never
   * dropped — and absent for a minute, so applying 087 takes effect without a
   * restart.
   */
  async scheduling(): Promise<boolean> {
    const cached = this.#scheduled;
    if (cached !== undefined && (cached.has || Date.now() - cached.at < 60_000)) {
      return cached.has;
    }
    const result = await this.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n
         FROM pg_attribute
        WHERE attrelid = to_regclass('push_broadcasts')
          AND attname IN ('send_at', 'cancelled_at')
          AND NOT attisdropped`,
    );
    const has = Number(result.rows[0]?.n ?? 0) === 2;
    if (!has && cached?.has !== false) {
      this.#logger.warn(
        'push_broadcasts has no send_at: migration 087_scheduled_announcements.sql ' +
          'is not applied. Announcements go out immediately and cannot be scheduled ' +
          'or cancelled until it is.',
      );
    }
    this.#scheduled = { has, at: Date.now() };
    return has;
  }

  /**
   * Records the handset a customer is signed in on.
   *
   * AN UPSERT ON THE TOKEN, NOT ON THE CUSTOMER, and the reassignment is the
   * point. A token identifies an INSTALLATION: a person has a phone and a
   * tablet, so one customer holds several — and a handset somebody else used
   * before signing out has a token that must now belong to the new account.
   * Leaving it pointed at the old one sends one person's notifications to
   * another person's lock screen.
   *
   * `revoked_at` IS CLEARED DELIBERATELY. A customer signing back in on a
   * handset they signed out of is reachable again; the row keeps its original
   * `created_at`, so when that handset first appeared is still on record.
   */
  async register(userUuid: string, token: string, platform: string): Promise<void> {
    const result = await this.pool.query(
      `INSERT INTO push_devices (user_id, token, platform)
       SELECT u.id, $2, $3 FROM users u WHERE u.uuid = $1
       ON CONFLICT (token) DO UPDATE
          SET user_id = EXCLUDED.user_id,
              platform = EXCLUDED.platform,
              revoked_at = NULL,
              last_seen_at = now()`,
      [userUuid, token, platform],
    );
    if (result.rowCount === 0) {
      throw new Error('push registration for a user that does not exist');
    }
  }

  /**
   * Retires one handset — what signing out calls.
   *
   * SCOPED TO THE CUSTOMER, so a token somebody else's app reported cannot be
   * retired by naming it. Silent when it matches nothing: a sign-out must
   * never fail because the handset was already retired, and an endpoint that
   * answered differently for "not yours" and "not here" would say which tokens
   * exist.
   */
  async revoke(userUuid: string, token: string): Promise<void> {
    await this.pool.query(
      `UPDATE push_devices d
          SET revoked_at = now()
         FROM users u
        WHERE u.uuid = $1
          AND d.user_id = u.id
          AND d.token = $2
          AND d.revoked_at IS NULL`,
      [userUuid, token],
    );
  }

  /**
   * What the push service said is gone. Called by the worker, never by a
   * request: a handset retires itself only on the provider's word.
   */
  async retire(tokens: readonly string[]): Promise<void> {
    if (tokens.length === 0) return;
    await this.pool.query(
      `UPDATE push_devices SET revoked_at = now()
        WHERE token = ANY($1::text[]) AND revoked_at IS NULL`,
      [tokens],
    );
  }

  /**
   * How many handsets a broadcast would reach.
   *
   * READ FROM `push_audience`, the same view the worker sends to. Two
   * definitions of "who may be told" is two answers, and the copy that drifts
   * is the one that runs unattended.
   */
  async estimate(country: string | undefined): Promise<AudienceEstimate> {
    const result = await this.pool.query<{ devices: string; customers: string; in_app: string }>(
      `SELECT (SELECT count(*) FROM push_audience
                WHERE $1::char(2) IS NULL OR country = $1::char(2)) AS devices,
              (SELECT count(DISTINCT user_id) FROM push_audience
                WHERE $1::char(2) IS NULL OR country = $1::char(2)) AS customers,
              (SELECT count(*) FROM users
                WHERE status = 'active' AND ($1::char(2) IS NULL OR country = $1::char(2))) AS in_app`,
      [country ?? null],
    );
    const row = result.rows[0];
    return {
      devices: Number(row?.devices ?? 0),
      customers: Number(row?.customers ?? 0),
      in_app: Number(row?.in_app ?? 0),
    };
  }

  /**
   * Queues one announcement.
   *
   * IT IS A ROW AND NOT A SEND, so this returns in milliseconds and the
   * screen can say what happens next honestly: queued, then drained.
   */
  async queue(
    staffUuid: string,
    input: { title: string; body: string; country?: string; sendAt?: string },
  ): Promise<BroadcastView> {
    const scheduling = await this.scheduling();
    // A time within the minute's grace 087 allows is "now", and needs no
    // column to say so. A later one does, and behind 087 it is refused rather
    // than sent early — an announcement of tonight's maintenance going out at
    // four is the exact misreading scheduling exists to prevent.
    if (!scheduling && input.sendAt !== undefined && Date.parse(input.sendAt) > Date.now() + 60_000) {
      throw new ConflictException({ error: 'scheduling_unavailable' });
    }
    let result;
    try {
      result = scheduling
        ? await this.pool.query<BroadcastRow>(
            `INSERT INTO push_broadcasts (title, body, country, created_by, send_at)
             SELECT $2, $3, $4::char(2), u.id, COALESCE($5::timestamptz, now())
               FROM users u WHERE u.uuid = $1
             RETURNING uuid, title, body, country, created_at, sent_at, send_at, cancelled_at,
                    devices, accepted, rejected, without_consent, failure_reason`,
            [staffUuid, input.title.trim(), input.body.trim(), input.country ?? null, input.sendAt ?? null],
          )
        : await this.pool.query<BroadcastRow>(
            `INSERT INTO push_broadcasts (title, body, country, created_by)
             SELECT $2, $3, $4::char(2), u.id
               FROM users u WHERE u.uuid = $1
             RETURNING uuid, title, body, country, created_at, sent_at,
                    created_at AS send_at, NULL::timestamptz AS cancelled_at,
                    devices, accepted, rejected, without_consent, failure_reason`,
            [staffUuid, input.title.trim(), input.body.trim(), input.country ?? null],
          );
    } catch (error) {
      // 087's CHECKs: not in the past, not more than a month out. Said as a
      // field the screen can point at rather than a constraint name.
      if ((error as { code?: unknown }).code === '23514') {
        throw new BadRequestException({ error: 'invalid_request', fields: ['send_at'] });
      }
      throw error;
    }
    const row = result.rows[0];
    if (row === undefined) throw new Error('broadcast queued by a user that does not exist');

    this.#logger.log(
      `broadcast queued for ${input.country ?? 'every country'}: "${input.title.trim()}"`,
    );
    return view(row);
  }

  /**
   * What has been sent, newest first. Includes what is still queued, because
   * "did my announcement go out?" is the question this screen exists for.
   */
  async history(limit = 50): Promise<readonly BroadcastView[]> {
    const bounded = Math.min(Math.max(limit, 1), 200);
    const result = (await this.scheduling())
      ? await this.pool.query<BroadcastRow>(
          `SELECT uuid, title, body, country, created_at, sent_at, send_at, cancelled_at,
                    devices, accepted, rejected, without_consent, failure_reason
             FROM push_broadcasts
            ORDER BY send_at DESC, created_at DESC
            LIMIT $1`,
          [bounded],
        )
      : await this.pool.query<BroadcastRow>(
          `SELECT uuid, title, body, country, created_at, sent_at,
                    created_at AS send_at, NULL::timestamptz AS cancelled_at,
                    devices, accepted, rejected, without_consent, failure_reason
             FROM push_broadcasts
            ORDER BY created_at DESC
            LIMIT $1`,
          [bounded],
        );
    return result.rows.map(view);
  }

  /** Whether an announcement is due and not yet pushed — what the list drains. */
  async hasDue(): Promise<boolean> {
    const result = (await this.scheduling())
      ? await this.pool.query(
          `SELECT 1 FROM push_broadcasts
            WHERE sent_at IS NULL AND cancelled_at IS NULL AND send_at <= now()
            LIMIT 1`,
        )
      : await this.pool.query(`SELECT 1 FROM push_broadcasts WHERE sent_at IS NULL LIMIT 1`);
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * Calls back one that has not gone out. The trigger refuses a due one, a
   * sent one or a cancelled one; this answers all three as one conflict,
   * because each means the same thing to the operator: too late.
   */
  async cancel(uuid: string): Promise<BroadcastView> {
    if (!/^[0-9a-f-]{36}$/i.test(uuid)) {
      throw new NotFoundException({ error: 'broadcast_not_found' });
    }
    if (!(await this.scheduling())) {
      // Behind 087 nothing was ever scheduled, so everything is already due.
      await this.one(uuid);
      throw new ConflictException({ error: 'broadcast_not_cancellable' });
    }
    const result = await this.pool.query<BroadcastRow>(
      `UPDATE push_broadcasts SET cancelled_at = now()
        WHERE uuid = $1 AND sent_at IS NULL AND cancelled_at IS NULL AND send_at > now()
        RETURNING uuid, title, body, country, created_at, sent_at, send_at, cancelled_at,
                    devices, accepted, rejected, without_consent, failure_reason`,
      [uuid],
    );
    const row = result.rows[0];
    if (row === undefined) {
      await this.one(uuid); // 404 for an unknown one
      throw new ConflictException({ error: 'broadcast_not_cancellable' });
    }
    this.#logger.log(`broadcast cancelled before it was due: "${row.title}"`);
    return view(row);
  }

  /**
   * THE BELL'S FEED — every announcement meant for this customer, newest
   * first.
   *
   * The bell led to the account screen, so a customer tapping it to read what
   * the platform had told them found their own settings instead, and anybody
   * without the app installed, or who had declined marketing, had no way to
   * read an announcement at all. The same rows the broadcast worker sends,
   * read on request.
   *
   * NOT CONSENT-GATED, and that is the distinction rather than a gap. 065
   * gates the PUSH because a push arrives unasked on a lock screen; this is a
   * list the customer opened. Somebody who declined marketing still needs to
   * be able to read "the app is down for an hour tonight".
   *
   * THE COUNTRY FILTER IS THE BROADCAST'S OWN: an announcement addressed to
   * Ghana is not shown in Lagos. A customer with no country sees only the
   * ones addressed to everybody — no country is not a licence to see all of
   * them.
   *
   * WRITTEN, not sent: a broadcast appears the moment an operator publishes
   * it, whatever the worker has done. What the customer is shown is what was
   * said, and whether a handset has been buzzed yet is not their concern.
   */
  async announcementsFor(userUuid: string, limit = 30): Promise<readonly AnnouncementView[]> {
    const result = await this.pool.query<{
      uuid: string;
      title: string;
      body: string;
      created_at: Date;
    }>(
      // DUE AND NOT CALLED BACK (087). A scheduled announcement is not in the
      // feed before its time, and `at` is when it went out, not when somebody
      // typed it — "maintenance tonight" written at four reads as tonight's.
      // Behind 087 every row was due when it was written.
      (await this.scheduling())
        ? `SELECT b.uuid, b.title, b.body, b.send_at AS created_at
             FROM push_broadcasts b
             JOIN users u ON u.uuid = $1
            WHERE (b.country IS NULL OR b.country = u.country)
              AND b.send_at <= now()
              AND b.cancelled_at IS NULL
            ORDER BY b.send_at DESC
            LIMIT $2`
        : `SELECT b.uuid, b.title, b.body, b.created_at
             FROM push_broadcasts b
             JOIN users u ON u.uuid = $1
            WHERE (b.country IS NULL OR b.country = u.country)
            ORDER BY b.created_at DESC
            LIMIT $2`,
      [userUuid, Math.min(Math.max(limit, 1), 100)],
    );
    return result.rows.map((row) => ({
      uuid: row.uuid,
      title: row.title,
      body: row.body,
      at: row.created_at.toISOString(),
    }));
  }

  async one(uuid: string): Promise<BroadcastView> {
    const result = await this.pool.query<BroadcastRow>(
      (await this.scheduling())
        ? `SELECT uuid, title, body, country, created_at, sent_at, send_at, cancelled_at,
                    devices, accepted, rejected, without_consent, failure_reason
             FROM push_broadcasts WHERE uuid = $1`
        : `SELECT uuid, title, body, country, created_at, sent_at,
                    created_at AS send_at, NULL::timestamptz AS cancelled_at,
                    devices, accepted, rejected, without_consent, failure_reason
             FROM push_broadcasts WHERE uuid = $1`,
      [uuid],
    );
    const row = result.rows[0];
    if (row === undefined) throw new NotFoundException({ error: 'broadcast_not_found' });
    return view(row);
  }
}

/*
 * The column lists are WRITTEN OUT in every statement rather than shared as a
 * constant, and that repetition is the Semgrep rule's own advice: a statement
 * built by interpolation is one a reviewer cannot read as SQL, and the rule
 * cannot tell a local constant from a request value. Behind 087 the same row
 * reads `created_at AS send_at, NULL AS cancelled_at` — due when written,
 * never cancelled — which is what 087's own backfill says.
 */

interface BroadcastRow {
  uuid: string;
  title: string;
  body: string;
  country: string | null;
  created_at: Date;
  sent_at: Date | null;
  send_at: Date;
  cancelled_at: Date | null;
  devices: number;
  accepted: number;
  rejected: number;
  without_consent: number;
  failure_reason: string | null;
}

function view(row: BroadcastRow): BroadcastView {
  return {
    uuid: row.uuid,
    title: row.title,
    body: row.body,
    country: row.country,
    created_at: row.created_at.toISOString(),
    sent_at: row.sent_at === null ? null : row.sent_at.toISOString(),
    send_at: row.send_at.toISOString(),
    cancelled_at: row.cancelled_at === null ? null : row.cancelled_at.toISOString(),
    devices: Number(row.devices),
    accepted: Number(row.accepted),
    rejected: Number(row.rejected),
    without_consent: Number(row.without_consent),
    failure_reason: row.failure_reason,
  };
}

/** Kept so the controller can refuse a country the platform does not name. */
export function assertCountryShape(code: string): void {
  if (!/^[A-Z]{2}$/.test(code)) {
    throw new BadRequestException({ error: 'invalid_request', fields: ['country'] });
  }
}
