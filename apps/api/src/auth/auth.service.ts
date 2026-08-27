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
import { NotificationService } from '../notifications/notification.service.js';
import { lagosTime } from './password-reset.service.js';
import { SignInEventService } from './sign-in-events.service.js';
import type { SignInOrigin } from './sign-in-events.service.js';

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
  /** Nullable: an account can be opened on a phone number. Nothing can be
   *  mailed to such a customer, and the alert is skipped rather than faked. */
  email: string | null;
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
    @Inject(NotificationService) private readonly notifications: NotificationService,
    @Inject(SignInEventService) private readonly signIns: SignInEventService,
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

  /**
   * `origin` describes the sign-in — where it came from and on what — and is
   * NEVER an authorisation input. Both its fields arrive through the edge, so
   * they are worth what the edge is worth: enough to show a customer and to
   * correlate against, not enough to decide anything on.
   */
  async login(input: LoginRequest, origin: SignInOrigin = {}): Promise<TokenPair> {
    const ipAddress = origin.ip;
    const client = await this.pool.connect();
    // Set as soon as we know which refusal it was, and recorded AFTER the
    // rollback below — see `recordFailure`. A failure written on this client
    // is a failure that is never written, which would leave the
    // credential-stuffing view looking at a clean database during an attack.
    let failure: 'bad_credentials' | 'unknown_identifier' | 'refused' | undefined;
    let failedUserId: string | undefined;
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
        // The two are recorded apart even though the caller cannot tell them
        // apart. "Somebody is guessing passwords on real accounts" and
        // "somebody is guessing which accounts exist" are different attacks
        // with different responses, and the endpoint answering identically is
        // what makes the distinction safe to keep here.
        failure = user === undefined ? 'unknown_identifier' : 'bad_credentials';
        failedUserId = user?.id;
        throw new UnauthorizedException(INVALID_CREDENTIALS);
      }

      // Checked here rather than inferred from a token later. A closed account
      // must not be able to obtain a session at all.
      if (user.status === 'closed') {
        this.#logger.warn(`login refused for user ${user.id}: account closed`);
        failure = 'refused';
        failedUserId = user.id;
        throw new UnauthorizedException(INVALID_CREDENTIALS);
      }

      // ASKED BEFORE THE EVENT IS WRITTEN. Recording first would make every
      // place familiar the moment it is used, and the alert below would never
      // fire again.
      const familiar = await this.signIns.familiarity(client, user.id, origin);

      const device = await this.#resolveDevice(client, user.id, input.device);
      const pair = await this.#openSession(client, user, device);

      // On the login's OWN transaction, so a 'succeeded' row cannot commit
      // while the session it describes rolls back.
      await this.signIns.recordSuccess(client, {
        userId: user.id,
        identifier: input.identifier,
        deviceId: device.id,
        origin,
      });

      // A sign-in from a device this customer has never used is the single
      // most useful thing to tell them about: it is what account takeover
      // looks like from the outside, and it is the moment they can still do
      // something about it.
      //
      // Enqueued INSIDE the login transaction, so the alert and the device row
      // that justifies it commit together — a device recorded with no alert
      // owed is the failure that matters, and it is silent. `enqueueBestEffort`
      // takes a SAVEPOINT so a queueing failure cannot take the login down
      // with it; being unable to send an email is not a reason to refuse
      // somebody entry to their own account.
      //
      // Deliberately NOT sent from `register`: the first device on a new
      // account is the one the customer is holding.
      if (device.firstSeen && user.email !== null) {
        await this.notifications.enqueueBestEffort(client, {
          userId: user.id,
          recipient: user.email,
          // Keyed on the DEVICE, so a retried login cannot mail twice and a
          // genuinely new device always gets its own alert.
          idempotencyKey: `new_device:${device.id}`,
          request: {
            kind: 'new_device',
            platform: input.device.displayName ?? input.device.platform,
            at: lagosTime(),
            ...(ipAddress === undefined ? {} : { ipAddress }),
          },
        });
      }

      // A KNOWN DEVICE IN AN UNKNOWN COUNTRY is the case the new-device alert
      // cannot see, and it is the whole reason this is a second message rather
      // than a field on that one. A takeover normally arrives on new hardware
      // and `new_device` covers it; a replayed fingerprint arrives on hardware
      // we already trust, and only the country moves. Sending both when both
      // are new would mail the customer twice about one event and train them
      // to ignore the pair.
      if (
        !device.firstSeen &&
        !familiar.countrySeenBefore &&
        origin.country !== undefined &&
        user.email !== null
      ) {
        await this.notifications.enqueueBestEffort(client, {
          userId: user.id,
          recipient: user.email,
          // Keyed on the country, so a customer who has genuinely moved is
          // told once rather than on every sign-in until they come home.
          idempotencyKey: `new_location:${user.id}:${origin.country}`,
          request: {
            kind: 'new_location',
            country: origin.country,
            at: lagosTime(),
            ...(ipAddress === undefined ? {} : { ipAddress }),
          },
        });
      }

      await client.query('COMMIT');
      return pair;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
      if (failure !== undefined) {
        // After the rollback and after the connection is back, on a client of
        // its own. Swallows its own errors: being unable to record an attempt
        // must not change the answer the caller already has.
        await this.signIns.recordFailure({
          identifier: input.identifier,
          outcome: failure,
          origin,
          ...(failedUserId === undefined ? {} : { userId: failedUserId }),
        });
      }
    }
  }

  async #findUser(client: PoolClient, identifier: string): Promise<UserRow | undefined> {
    const result = await client.query<UserRow>(
      `SELECT u.id, u.uuid, u.status, u.email, c.password_hash
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
  ): Promise<DeviceRow & { firstSeen: boolean }> {
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
      // `firstSeen` is what the new-device alert keys on. It has to be
      // reported from HERE rather than inferred by the caller comparing
      // timestamps: a device created microseconds ago and one seen last week
      // differ only by a row that already exists, and a caller re-querying
      // for it would race its own insert.
      return { ...row, firstSeen: true };
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
    return { ...found, firstSeen: false };
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
