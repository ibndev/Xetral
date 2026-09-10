import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
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
  readonly devices: number;
  readonly accepted: number;
  readonly rejected: number;
  readonly without_consent: number;
  readonly failure_reason: string | null;
}

export interface AudienceEstimate {
  readonly devices: number;
  readonly customers: number;
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

  constructor(@Inject(DATABASE) private readonly pool: Pool) {}

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
    const result = await this.pool.query<{ devices: string; customers: string }>(
      `SELECT count(*) AS devices, count(DISTINCT user_id) AS customers
         FROM push_audience
        WHERE $1::char(2) IS NULL OR country = $1::char(2)`,
      [country ?? null],
    );
    const row = result.rows[0];
    return {
      devices: Number(row?.devices ?? 0),
      customers: Number(row?.customers ?? 0),
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
    input: { title: string; body: string; country?: string },
  ): Promise<BroadcastView> {
    const result = await this.pool.query<BroadcastRow>(
      `INSERT INTO push_broadcasts (title, body, country, created_by)
       SELECT $2, $3, $4::char(2), u.id FROM users u WHERE u.uuid = $1
       RETURNING uuid, title, body, country, created_at, sent_at,
                 devices, accepted, rejected, without_consent, failure_reason`,
      [staffUuid, input.title.trim(), input.body.trim(), input.country ?? null],
    );
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
    const result = await this.pool.query<BroadcastRow>(
      `SELECT uuid, title, body, country, created_at, sent_at,
              devices, accepted, rejected, without_consent, failure_reason
         FROM push_broadcasts
        ORDER BY created_at DESC
        LIMIT $1`,
      [Math.min(Math.max(limit, 1), 200)],
    );
    return result.rows.map(view);
  }

  async one(uuid: string): Promise<BroadcastView> {
    const result = await this.pool.query<BroadcastRow>(
      `SELECT uuid, title, body, country, created_at, sent_at,
              devices, accepted, rejected, without_consent, failure_reason
         FROM push_broadcasts WHERE uuid = $1`,
      [uuid],
    );
    const row = result.rows[0];
    if (row === undefined) throw new NotFoundException({ error: 'broadcast_not_found' });
    return view(row);
  }
}

interface BroadcastRow {
  uuid: string;
  title: string;
  body: string;
  country: string | null;
  created_at: Date;
  sent_at: Date | null;
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
