import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import type { Pool } from 'pg';
import {
  WeakPasswordError,
  assertPasswordPolicy,
  hashPassword,
  verifyPassword,
} from '@xetral/identity';
import { DATABASE } from '../tokens.js';

/**
 * What a customer can do when they think somebody else is in their account.
 *
 * THE GAP THIS CLOSES. Every control in this codebase was aimed at stopping an
 * attacker getting in: rotating refresh tokens, reuse detection that revokes a
 * whole device family, a PIN that locks after five tries, deny-by-default
 * routing. None of it helps once somebody is ALREADY in — and the customer had
 * no way to find out, and no way to end it.
 *
 * Reuse detection only fires if the thief REPLAYS a refresh token. One who
 * simply keeps using the session they stole triggers nothing at all, for as
 * long as they keep refreshing. Support could freeze the account, but a
 * customer at 2am on a Sunday could not, and the first thing anybody wants at
 * that moment is to throw everyone out and change the password.
 *
 * All three actions below take the transaction PIN, which is deliberate. They
 * are reachable with a stolen access token, so the thief could otherwise use
 * them to evict the real owner — the PIN is the factor they do not have.
 *
 * None of this needed new schema. `devices`, `auth_sessions` and the
 * `cascade_device_revocation` trigger have been in 002_identity.sql since
 * Phase 2; revoking a device already revokes its live sessions. What was
 * missing was any way to ask for it.
 */
@Injectable()
export class AccountSecurityService {
  readonly #logger = new Logger(AccountSecurityService.name);

  constructor(@Inject(DATABASE) private readonly pool: Pool) {}

  /**
   * Every device that has held a session, newest first.
   *
   * This is the screen where a customer discovers the problem, so it shows
   * revoked devices too rather than only live ones. "An Android phone in this
   * list that I do not own" is the finding; hiding devices once they are
   * revoked would erase the evidence a moment after they acted on it.
   */
  async devices(userUuid: string, currentDeviceUuid: string): Promise<readonly DeviceView[]> {
    const rows = await this.pool.query<{
      uuid: string;
      platform: string;
      display_name: string;
      status: string;
      first_seen_at: Date;
      last_seen_at: Date;
      live_sessions: string;
    }>(
      `SELECT d.uuid, d.platform, d.display_name, d.status::text AS status,
              d.first_seen_at, d.last_seen_at,
              (SELECT count(*) FROM auth_sessions s
                WHERE s.device_id = d.id AND s.revoked_at IS NULL
                  AND s.expires_at > now())::text AS live_sessions
         FROM devices d
         JOIN users u ON u.id = d.user_id
        WHERE u.uuid = $1
        ORDER BY d.last_seen_at DESC`,
      [userUuid],
    );

    return rows.rows.map((row) => ({
      id: row.uuid,
      platform: row.platform,
      name: row.display_name === '' ? row.platform : row.display_name,
      status: row.status,
      // So the screen can say "this device" and not offer to sign it out in
      // the same breath as an unrecognised one.
      current: row.uuid === currentDeviceUuid,
      first_seen_at: row.first_seen_at.toISOString(),
      last_seen_at: row.last_seen_at.toISOString(),
      live_sessions: Number(row.live_sessions),
    }));
  }

  /**
   * Revokes one device, and with it every session on that device.
   *
   * The cascade is a trigger, not code here. Revoking the device row and
   * leaving its sessions live is the obvious half-implementation, and it would
   * mean a customer who "signed out" the attacker's phone watching it keep
   * working — which is worse than not offering the button, because they would
   * stop looking for the real problem.
   */
  async revokeDevice(userUuid: string, deviceUuid: string, reason: string): Promise<void> {
    const result = await this.pool.query(
      `UPDATE devices d
          SET status = 'revoked'
         FROM users u
        WHERE u.id = d.user_id
          AND u.uuid = $1
          AND d.uuid = $2
          AND d.status <> 'revoked'`,
      [userUuid, deviceUuid],
    );

    if (result.rowCount === 0) {
      // Either it is not theirs or it was already revoked. Both answer the
      // same way: scoping the UPDATE by user means another customer's device
      // uuid is a 404 rather than an authorisation question answered later,
      // and re-revoking is not an error — the customer got what they asked for.
      const exists = await this.pool.query(
        `SELECT 1 FROM devices d JOIN users u ON u.id = d.user_id
          WHERE u.uuid = $1 AND d.uuid = $2`,
        [userUuid, deviceUuid],
      );
      if (exists.rowCount === 0) throw new NotFoundException({ error: 'device_not_found' });
      return;
    }

    this.#logger.warn(`user ${userUuid} revoked device ${deviceUuid}: ${reason}`);
  }

  /**
   * Signs out everywhere except the device asking.
   *
   * Keeping the current device is the difference between a control a
   * frightened customer will use and one they will not: signing themselves
   * out too means the next thing they see is a login screen, and they cannot
   * tell whether it worked. They can revoke this device separately if they
   * want to.
   */
  async revokeOtherDevices(userUuid: string, currentDeviceUuid: string): Promise<number> {
    const result = await this.pool.query(
      `UPDATE devices d
          SET status = 'revoked'
         FROM users u
        WHERE u.id = d.user_id
          AND u.uuid = $1
          AND d.uuid <> $2
          AND d.status <> 'revoked'`,
      [userUuid, currentDeviceUuid],
    );

    const count = result.rowCount ?? 0;
    if (count > 0) this.#logger.warn(`user ${userUuid} signed out ${count} other device(s)`);
    return count;
  }

  /**
   * Changes the password, and signs every other device out.
   *
   * The revocation is the point, not a courtesy. A password change that leaves
   * the attacker's session live changes nothing about their access — they are
   * already past the password — while telling the customer they have fixed it.
   * That is worse than doing nothing, because they stop looking.
   *
   * The CURRENT password is required even though the caller is authenticated,
   * for the same reason the PIN is: this endpoint is reachable with a stolen
   * access token, and without it a thief could lock the real owner out of
   * their own account with the session they took.
   */
  async changePassword(
    userUuid: string,
    currentDeviceUuid: string,
    current: string,
    next: string,
  ): Promise<{ signed_out_devices: number }> {
    const found = await this.pool.query<{ id: string; status: string; password_hash: string }>(
      `SELECT u.id, u.status, c.password_hash
         FROM users u JOIN user_credentials c ON c.user_id = u.id
        WHERE u.uuid = $1`,
      [userUuid],
    );
    const user = found.rows[0];
    if (user === undefined) throw new NotFoundException({ error: 'user_not_found' });
    if (user.status !== 'active') {
      throw new ForbiddenException({ error: 'account_not_active', status: user.status });
    }

    if (!(await verifyPassword(current, user.password_hash))) {
      // The same code login uses. "Your current password is wrong" and "that
      // account does not exist" must not be distinguishable anywhere.
      throw new UnauthorizedException({ error: 'invalid_credentials' });
    }

    try {
      // The shared policy, so the rules cannot drift between registration and
      // a change — a weaker rule on the change path would be the one an
      // attacker uses to set a password they can remember.
      assertPasswordPolicy(next);
    } catch (error) {
      if (error instanceof WeakPasswordError) {
        throw new BadRequestException({ error: 'weak_password', detail: error.message });
      }
      throw error;
    }

    const hash = await hashPassword(next);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`UPDATE user_credentials SET password_hash = $2 WHERE user_id = $1`, [
        user.id,
        hash,
      ]);

      // In the SAME transaction. A change that committed while the revocation
      // failed would leave every stolen session live behind a new password,
      // which is the exact state the customer believes they have just left.
      const revoked = await client.query(
        `UPDATE devices SET status = 'revoked'
          WHERE user_id = $1::bigint AND uuid <> $2 AND status <> 'revoked'`,
        [user.id, currentDeviceUuid],
      );

      await client.query('COMMIT');
      this.#logger.warn(
        `user ${userUuid} changed their password; ${revoked.rowCount ?? 0} device(s) signed out`,
      );
      return { signed_out_devices: revoked.rowCount ?? 0 };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}

export interface DeviceView {
  readonly id: string;
  readonly platform: string;
  readonly name: string;
  readonly status: string;
  readonly current: boolean;
  readonly first_seen_at: string;
  readonly last_seen_at: string;
  readonly live_sessions: number;
}
