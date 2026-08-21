import { createHash } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import {
  assertPasswordPolicy,
  dummySecretHash,
  hashPassword,
  hashRefreshToken,
  isSecurityIncident,
  issueRefreshToken,
  signAccessToken,
  verifyPassword,
} from '@xetral/identity';
import type { AccessTokenClaims, RotationOutcome } from '@xetral/identity';
import { API_CONFIG, CLOCK, DATABASE } from '../tokens.js';
import type { Clock } from '../tokens.js';
import type { ApiConfig } from '../config.js';
import type { LoginRequest, RegisterRequest } from './dto.js';
import { SettingsService } from '../settings/settings.service.js';

export interface TokenPair {
  readonly access_token: string;
  readonly refresh_token: string;
  readonly token_type: 'Bearer';
  readonly expires_in: number;
}

export interface SessionSummary {
  readonly session_id: string;
  readonly user_id: string;
  readonly device_id: string;
  readonly expires_at: string;
}

/**
 * One error for every login failure, deliberately.
 *
 * "No such account", "wrong password", "device revoked" and "account closed"
 * are four different facts, and telling a caller which one applies turns the
 * login endpoint into a tool for enumerating customers. The distinction is kept
 * in our logs, where it is useful, and out of the response, where it is not.
 */
const INVALID_CREDENTIALS = { error: 'invalid_credentials' } as const;

/** Likewise for refresh: expired, unknown, revoked and REUSED all look the
 *  same to the client. Reuse is a security incident on our side, not a hint we
 *  hand to whoever is holding the token. */
const INVALID_GRANT = { error: 'invalid_grant' } as const;

interface UserRow {
  id: string;
  uuid: string;
  status: string;
  password_hash: string | null;
}

interface DeviceRow {
  id: string;
  uuid: string;
  status: string;
}

interface RotationRow {
  out_outcome: RotationOutcome;
  out_session_id: string | null;
  out_user_id: string | null;
  out_new_token_id: string | null;
}

/**
 * The device fingerprint is stored hashed. It is not a secret, but it is a
 * stable identifier for a physical device, and a table mapping people to
 * devices is a surveillance dataset we have no reason to hold in the clear.
 *
 * A module function rather than a static method because TypeScript forbids a
 * static private identifier on a decorated class (TS18036).
 */
function fingerprintHash(fingerprint: string): string {
  return createHash('sha256').update(fingerprint, 'utf8').digest('hex');
}

@Injectable()
export class AuthService {
  readonly #logger = new Logger(AuthService.name);

  constructor(
    @Inject(DATABASE) private readonly pool: Pool,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(SettingsService) private readonly settings: SettingsService,
  ) {}

  /**
   * Opens an account and signs the customer straight in.
   *
   * One transaction: the user, their credential, and the first session. A
   * failure anywhere leaves no half-made account — which matters because a
   * user row with no credential cannot be signed into and cannot be
   * registered again, the email being taken.
   *
   * NOTE what this does NOT create: no wallet, no accounts, no provider
   * customer. Ledger accounts are made on first posting by the ledger service,
   * and a provider identity is a KYC decision. Creating either here would mean
   * a signup form quietly performing a regulated step.
   */
  async register(input: RegisterRequest): Promise<TokenPair> {
    if (!(await this.settings.registrationEnabled())) {
      // A flag rather than a deploy, so an abuse wave can be stopped in
      // seconds without taking the platform down for existing customers.
      throw new ForbiddenException({ error: 'registration_closed' });
    }

    // The policy lives in @xetral/identity and is shared with password
    // changes, so the rules cannot drift between the two paths.
    try {
      assertPasswordPolicy(input.password);
    } catch (error) {
      throw new BadRequestException({
        error: 'weak_password',
        detail: error instanceof Error ? error.message : undefined,
      });
    }

    const passwordHash = await hashPassword(input.password);
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');

      let user: UserRow;
      try {
        const created = await client.query<UserRow>(
          `INSERT INTO users (email, status) VALUES ($1, 'active')
           RETURNING id, uuid, status, NULL::text AS password_hash`,
          [input.email],
        );
        const row = created.rows[0];
        if (row === undefined) throw new Error('user insert returned no row');
        user = row;
      } catch (error) {
        if (isUniqueViolation(error)) {
          // Deliberately the same shape as a successful response would NOT be:
          // this one tells the caller the address is taken. That is an
          // enumeration oracle, and it is the accepted trade — a signup form
          // that cannot say "you already have an account" sends people in
          // circles, and the same information is available from the password
          // reset flow of every service on the internet.
          throw new ConflictException({ error: 'email_taken' });
        }
        throw error;
      }

      await client.query(
        `INSERT INTO user_credentials (user_id, password_hash) VALUES ($1::bigint, $2)`,
        [user.id, passwordHash],
      );

      const device = await this.#resolveDevice(client, user.id, input.device);
      const pair = await this.#openSession(client, user, device);

      await client.query('COMMIT');
      this.#logger.log(`account opened: user ${user.uuid}`);
      return pair;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async login(input: LoginRequest): Promise<TokenPair> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const user = await this.#findUser(client, input.identifier);

      // The comparison runs even when no account was found, against a hash of
      // a value nobody holds. Skipping it would make "unknown account" return
      // measurably faster than "wrong password" — an enumeration oracle that no
      // amount of identical error messages would close.
      const storedHash = user?.password_hash ?? (await dummySecretHash());
      const passwordMatches = await verifyPassword(input.password, storedHash);

      if (user === undefined || !passwordMatches) {
        this.#logger.warn(`login failed for '${input.identifier}': bad credentials`);
        throw new UnauthorizedException(INVALID_CREDENTIALS);
      }

      // Checked here rather than inferred from a token later. A closed account
      // must not be able to obtain a session at all.
      if (user.status === 'closed') {
        this.#logger.warn(`login refused for user ${user.id}: account closed`);
        throw new UnauthorizedException(INVALID_CREDENTIALS);
      }

      const device = await this.#resolveDevice(client, user.id, input.device);
      const pair = await this.#openSession(client, user, device);

      await client.query('COMMIT');
      return pair;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async #findUser(client: PoolClient, identifier: string): Promise<UserRow | undefined> {
    const result = await client.query<UserRow>(
      `SELECT u.id, u.uuid, u.status, c.password_hash
         FROM users u
         LEFT JOIN user_credentials c ON c.user_id = u.id
        WHERE lower(u.email) = lower($1) OR u.phone = $1
        LIMIT 1`,
      [identifier],
    );
    return result.rows[0];
  }

  async #resolveDevice(
    client: PoolClient,
    userId: string,
    device: LoginRequest['device'],
  ): Promise<DeviceRow> {
    const hashedFingerprint = fingerprintHash(device.fingerprint);

    const existing = await client.query<DeviceRow>(
      `SELECT id, uuid, status FROM devices WHERE user_id = $1 AND fingerprint_hash = $2`,
      [userId, hashedFingerprint],
    );

    const found = existing.rows[0];
    if (found === undefined) {
      const created = await client.query<DeviceRow>(
        `INSERT INTO devices (user_id, fingerprint_hash, platform, display_name)
         VALUES ($1, $2, $3, $4)
         RETURNING id, uuid, status`,
        [userId, hashedFingerprint, device.platform, device.displayName ?? ''],
      );
      const row = created.rows[0];
      if (row === undefined) throw new Error('device insert returned no row');
      return row;
    }

    // A revoked device stays revoked. This is the "lost phone" action, and it
    // is stronger than logging out: letting a correct password re-activate the
    // device would silently undo the revocation that a customer or an analyst
    // deliberately performed. Restoring it is a support action, not a side
    // effect of signing in.
    if (found.status !== 'active') {
      this.#logger.warn(`login refused on revoked device ${found.id} for user ${userId}`);
      throw new UnauthorizedException(INVALID_CREDENTIALS);
    }

    await client.query(`UPDATE devices SET last_seen_at = now() WHERE id = $1`, [found.id]);
    return found;
  }

  async #openSession(client: PoolClient, user: UserRow, device: DeviceRow): Promise<TokenPair> {
    const session = await client.query<{ id: string; uuid: string }>(
      `INSERT INTO auth_sessions (user_id, device_id) VALUES ($1, $2) RETURNING id, uuid`,
      [user.id, device.id],
    );
    const sessionRow = session.rows[0];
    if (sessionRow === undefined) throw new Error('session insert returned no row');

    const refresh = issueRefreshToken();
    await client.query(
      `INSERT INTO refresh_tokens (session_id, token_hash, generation, expires_at)
       VALUES ($1, $2, 0, now() + ($3 || ' seconds')::interval)`,
      [sessionRow.id, refresh.hash, this.config.refreshTokenTtlSeconds],
    );

    return this.#issue(user.uuid, sessionRow.uuid, device.uuid, refresh.token);
  }

  /**
   * Rotation. The new token is minted BEFORE the call because
   * `rotate_refresh_token` inserts it as part of the same atomic step that
   * consumes the old one — there is no window in which a family has no live
   * token, and no second round trip in which a crash could leave one.
   */
  async refresh(presentedToken: string): Promise<TokenPair> {
    const next = issueRefreshToken();

    const result = await this.pool.query<RotationRow>(
      `SELECT * FROM rotate_refresh_token($1, $2, ($3 || ' seconds')::interval)`,
      [
        hashRefreshToken(presentedToken),
        next.hash,
        this.config.refreshTokenTtlSeconds,
      ],
    );

    const row = result.rows[0];
    if (row === undefined) throw new Error('rotate_refresh_token returned no row');

    if (row.out_outcome !== 'rotated') {
      if (isSecurityIncident(row.out_outcome)) {
        // The one outcome that means somebody is holding a credential they
        // should not. The family has already been revoked by the function; this
        // is the signal an on-call engineer needs. Never log the token itself.
        this.#logger.error(
          `refresh token reuse detected: session ${row.out_session_id} ` +
            `(user ${row.out_user_id}) revoked. Treat as credential theft.`,
        );
      } else {
        this.#logger.debug(`refresh rejected: ${row.out_outcome}`);
      }
      throw new UnauthorizedException(INVALID_GRANT);
    }

    const identity = await this.pool.query<{
      session_uuid: string;
      user_uuid: string;
      device_uuid: string;
    }>(
      `SELECT s.uuid AS session_uuid, u.uuid AS user_uuid, d.uuid AS device_uuid
         FROM auth_sessions s
         JOIN users u   ON u.id = s.user_id
         JOIN devices d ON d.id = s.device_id
        WHERE s.id = $1`,
      [row.out_session_id],
    );
    const ids = identity.rows[0];
    if (ids === undefined) throw new Error('rotated a token for a session that does not exist');

    return this.#issue(ids.user_uuid, ids.session_uuid, ids.device_uuid, next.token);
  }

  /**
   * Logout revokes the session, which kills every refresh token in the family
   * through `rotate_refresh_token`'s session check. The access token already
   * issued stays valid until it expires — that is the documented cost of not
   * storing them, and the reason the TTL is 15 minutes.
   */
  async logout(sessionUuid: string): Promise<void> {
    await this.pool.query(
      `SELECT revoke_session(s.id, 'logout') FROM auth_sessions s WHERE s.uuid = $1`,
      [sessionUuid],
    );
  }

  async describeSession(claims: AccessTokenClaims): Promise<SessionSummary> {
    return {
      session_id: claims.sid,
      user_id: claims.sub,
      device_id: claims.did,
      expires_at: new Date(claims.exp * 1000).toISOString(),
    };
  }

  #issue(
    userUuid: string,
    sessionUuid: string,
    deviceUuid: string,
    refreshToken: string,
  ): TokenPair {
    const accessToken = signAccessToken(
      { sub: userUuid, sid: sessionUuid, did: deviceUuid },
      this.config.accessTokenKeyring,
      this.clock.nowSeconds(),
      this.config.accessTokenTtlSeconds,
    );

    return {
      access_token: accessToken,
      refresh_token: refreshToken,
      token_type: 'Bearer',
      expires_in: this.config.accessTokenTtlSeconds,
    };
  }
}

/** Postgres 23505. Distinguishing it from a real failure is what turns a
 *  duplicate email into a 409 rather than a 500. */
function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === '23505';
}
