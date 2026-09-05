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
import { ConsentService } from '../consent/consent.service.js';
import type { ConsentContext } from '../consent/consent.service.js';
import type { SignInOrigin } from './sign-in-events.service.js';
import { CountriesService } from '../countries/countries.service.js';

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
  /**
   * What to call this customer, or null.
   *
   * FROM WHAT THEY TYPED AT SIGNUP, falling back to their KYC submission.
   * The signup name exists from the first second of the account and the
   * verified one arrives days later if at all, so for a GREETING the typed
   * one is both earlier and likelier to be what somebody is called. Neither
   * is read by anything that moves money — that reads `kyc_submissions`.
   *
   * THE FIRST NAME ONLY, and not because of screen width: a greeting is the
   * one place a product speaks to somebody the way a person would, and "Hello
   * Olawale Adeyemi" is a form letter. The rest of the name is on the identity
   * screen where it belongs.
   *
   * It is NOT in the access token. A token is signed and cannot be revoked
   * mid-life, so a name baked into one would still be the old name fifteen
   * minutes after a customer corrected it — the same rule this codebase
   * applies to roles and to `users.status`.
   */
  readonly first_name: string | null;
  /**
   * THE WHOLE NAME AND THE PHONE, so verification does not ask twice.
   *
   * Both are what the customer typed at SIGNUP. They are here to PREFILL the
   * identity form — a "quick check" that asks again for a name and a number
   * already on file is a five-field form somebody abandons — and for nothing
   * else. Neither is a claim about who somebody legally is: that is
   * `kyc_submissions.full_name`, read off a document by a reviewer, and it
   * remains the only name any money decision or any card may carry.
   */
  readonly full_name: string | null;
  readonly phone: string | null;
  /**
   * Whether a transaction PIN exists.
   *
   * SO A SCREEN CAN ASK BEFORE IT NEEDS TO. Without it the only way to learn
   * was to try to move money and read `pin_not_set` off the refusal — which
   * means a customer fills in a recipient, an amount and a PIN box before
   * being told the PIN box was never going to work. The Send screen routes
   * them through creating one first.
   *
   * A boolean, never the PIN or anything derived from it.
   */
  /**
   * Whether a transaction PIN exists, or NULL when we could not tell.
   *
   * The null is the point. It used to be a plain boolean and a failed query
   * answered `false` — telling a customer who had set a PIN that they had
   * none, and sending them to create one they already had. "I do not know" and
   * "there is none" are different claims and only one of them is safe to act
   * on.
   */
  readonly has_pin: boolean | null;
  /**
   * WHERE THEY ARE, and what their money is in.
   *
   * `home_currency` is what the home screen leads with and what the activity
   * rail starts from. Both are null for an account opened before 040 — the
   * clients fall back to naira for those, which is what they in fact are.
   *
   * The currency is sent rather than derived from the country on the client,
   * so the mapping lives in one place: an operator who changes a country's
   * currency changes it for both apps at once, with no release.
   */
  readonly country: string | null;
  readonly home_currency: string | null;
  /**
   * THE COUNTRY'S NAME AND HOW MONEY LEAVES IT, so a screen does not have to
   * ask a second time.
   *
   * Both apps personalise on these: the payout screen offers a Bank account
   * in Nigeria and a Momo account in Ghana and Kenya, and the top-up screen
   * offers what a customer there actually funds a wallet with. Deriving that
   * from the country CODE on the client would put a `switch` over country
   * codes in two apps — which is exactly what 040 exists to prevent, and what
   * would need a release the day a fourth country opens.
   *
   * `payout_method` is 'bank' or 'mobile_money', from `countries`. Null only
   * where the country row itself is missing, which the clients read as bank —
   * the conservative answer, because a bank transfer that refuses is
   * recoverable and a send to a number that is not a wallet is not.
   */
  readonly country_name: string | null;
  readonly payout_method: string | null;
  /** The customer's own payment handle, or null if they have not been given
   *  one yet. `GET /v1/profile` mints one on first ask. */
  readonly handle: string | null;
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
    @Inject(ConsentService) private readonly consents: ConsentService,
    @Inject(CountriesService) private readonly countries: CountriesService,
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
  async register(input: RegisterRequest, context: ConsentContext = {}): Promise<TokenPair> {
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

    /*
     * THE COUNTRY IS RESOLVED BEFORE ANYTHING IS WRITTEN, and it decides the
     * phone number's shape. A country that is not open refuses here — with
     * the same answer for "no such country", because the two together would
     * be a way to read the roadmap off a signup form.
     */
    const country = await this.countries.requireOpen(input.country);

    /*
     * ONE CANONICAL FORM FOR A PHONE NUMBER: E.164, built from the country's
     * own dialling code and the national digits.
     *
     * `users_phone_unique` is a plain UNIQUE index on text, so it cannot see
     * that `+2348031234567`, `2348031234567` and `08031234567` are one person
     * — three accounts on one number, and every per-customer control in the
     * system assumes that cannot happen. Normalising here rather than trusting
     * the client is what makes the index mean what it says: the leading zero
     * a Nigerian trunk prefix carries is dropped, because it is a domestic
     * dialling convention rather than part of the number.
     */
    const national = input.phone.replace(/^0+/, '');
    const phone = `+${country.dial_code}${national}`;

    const passwordHash = await hashPassword(input.password);
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');

      let user: UserRow;
      try {
        const created = await client.query<UserRow>(
          `INSERT INTO users (email, status, full_name, country, phone)
           VALUES ($1, 'active', $2, $3, $4)
           RETURNING id, uuid, status, NULL::text AS password_hash`,
          [input.email, input.full_name, country.code, phone],
        );
        const row = created.rows[0];
        if (row === undefined) throw new Error('user insert returned no row');
        user = row;
      } catch (error) {
        if (isUniqueViolation(error)) {
          // WHICH identifier collided, because the two need different words.
          // "That email is taken" sends somebody to the reset flow; the same
          // sentence about a phone number they typed correctly sends them
          // nowhere, and it is the more likely mistake of the two.
          const detail = error instanceof Error ? error.message : '';
          if (detail.includes('users_phone_unique')) {
            throw new ConflictException({ error: 'phone_taken' });
          }
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

      /*
       * ON THIS TRANSACTION, so an account cannot exist without a record of
       * what its owner agreed to and the record cannot exist without the
       * account. Written afterwards on its own connection, a crash in the gap
       * leaves a customer whose consent we cannot demonstrate — and that is
       * precisely the customer somebody will later ask about.
       *
       * The terms and the privacy notice only. Marketing is refused here by
       * CHECK, because bundling a mailing list into "create account" is not
       * consent to the mailing list whatever the button said.
       */
      await this.consents.recordRegistration(client, user.id, context);

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
      ...(await this.#profile(claims.sub)),
    };
  }

  /**
   * The three things a screen needs about the person.
   *
   * TWO QUERIES, DELIBERATELY, AND THIS COST A ROUND. It was one, selecting
   * `users.handle` alongside the PIN state — and `handle` arrives in migration
   * 039. On a deployment that has not applied it the column does not exist,
   * the whole query throws, and a bare `catch` returned
   * `{ first_name: null, has_pin: false, handle: null }`.
   *
   * That answer is not a failure, it is a LIE THAT LOOKS LIKE DATA. A
   * customer who had set a transaction PIN was told they had none, so the Send
   * screen routed them back into creating one they already had; and the
   * greeting fell back to "there" for somebody whose name we hold. Neither
   * looked like a broken query, which is why it was reported as two unrelated
   * bugs.
   *
   * So the PIN state — which depends only on tables that have existed since
   * 002 — is read on its own and cannot be taken out by a schema that is
   * behind. The handle is read separately and is allowed to be missing.
   */
  async #profile(
    userUuid: string,
  ): Promise<{
    first_name: string | null;
    full_name: string | null;
    phone: string | null;
    has_pin: boolean | null;
    country: string | null;
    home_currency: string | null;
    country_name: string | null;
    payout_method: string | null;
    handle: string | null;
  }> {
    const [core, handle] = await Promise.all([this.#core(userUuid), this.#handle(userUuid)]);
    return { ...core, handle };
  }

  /**
   * The name and the PIN state, from tables as old as the schema.
   *
   * `has_pin` is `boolean | null` and the null is load-bearing: it means WE DO
   * NOT KNOW, which is a different thing from "no PIN". A screen that gets
   * null shows the ordinary form and lets the server's own `pin_not_set`
   * refusal decide — because being told to create a PIN you already have is a
   * dead end, while being allowed to try is at worst one extra refusal that
   * already carries a link to the right place.
   */
  async #core(userUuid: string): Promise<{
    first_name: string | null;
    full_name: string | null;
    phone: string | null;
    has_pin: boolean | null;
    country: string | null;
    home_currency: string | null;
    country_name: string | null;
    payout_method: string | null;
  }> {
    try {
      const result = await this.pool.query<{
        full_name: string | null;
        phone: string | null;
        has_pin: boolean;
        country: string | null;
        home_currency: string | null;
        country_name: string | null;
        payout_method: string | null;
      }>(
        /*
         * `users.full_name` FIRST, then the verified one.
         *
         * Both are here and the order is the decision. The signup name is what
         * somebody typed about themselves and exists from the first second of
         * the account; the KYC name is what a reviewer read off a document and
         * arrives days later, if at all. For a GREETING the typed one is both
         * earlier and more likely to be what they are actually called.
         *
         * No money decision reads either of these. Anything that turns on who
         * somebody legally is reads `kyc_submissions` directly.
         */
        `SELECT COALESCE(
                  u.full_name,
                  (SELECT k.full_name FROM kyc_submissions k
                    WHERE k.user_id = u.id ORDER BY k.created_at DESC LIMIT 1)
                ) AS full_name,
                u.phone,
                (p.user_id IS NOT NULL) AS has_pin,
                u.country,
                c.currency AS home_currency,
                c.name AS country_name,
                c.payout_method
           FROM users u
           LEFT JOIN transaction_pins p ON p.user_id = u.id
           LEFT JOIN countries c ON c.code = u.country
          WHERE u.uuid = $1`,
        [userUuid],
      );
      const row = result.rows[0];
      if (row === undefined) {
        return {
          first_name: null,
          full_name: null,
          phone: null,
          has_pin: null,
          country: null,
          home_currency: null,
          country_name: null,
          payout_method: null,
        };
      }

      const full = row.full_name?.trim();
      return {
        // The first token. Nigerian names are commonly three parts and the
        // first is the one somebody is called.
        first_name: full === undefined || full === '' ? null : (full.split(/\s+/)[0] ?? null),
        /*
         * THE WHOLE NAME AND THE PHONE, so the verification form does not ask
         * again for what signup already took.
         *
         * A customer arriving at KYC has already typed both; asking a second
         * time is how a "quick check" becomes a five-field form somebody
         * abandons. Neither is a claim about identity — `users.full_name` is
         * what somebody typed ABOUT THEMSELVES and no money decision reads it
         * — so this prefills a box the customer can still correct, and the
         * reviewer still reads the name off the document.
         */
        full_name: full === undefined || full === '' ? null : full,
        phone: row.phone,
        has_pin: row.has_pin,
        country: row.country,
        home_currency: row.home_currency,
        country_name: row.country_name,
        payout_method: row.payout_method,
      };
    } catch (error: unknown) {
      // LOUD. The previous version swallowed this and returned an answer, and
      // the answer was wrong in the direction that breaks a customer's day.
      this.#logger.error(
        `could not read the profile for ${userUuid}: ${describe(error)}. ` +
          `Reporting the PIN state as UNKNOWN rather than guessing.`,
      );
      return {
        first_name: null,
        full_name: null,
        phone: null,
        has_pin: null,
        country: null,
        home_currency: null,
        country_name: null,
        payout_method: null,
      };
    }
  }

  /**
   * The payment handle, which arrives in migration 039.
   *
   * Its absence is EXPECTED on a deployment that has not applied 039 yet, and
   * is the one failure here that must not disturb anything else — so it is its
   * own query and its own catch. Logged at warn rather than error, with the
   * migration named, because the fix is a deployment step rather than a bug.
   */
  async #handle(userUuid: string): Promise<string | null> {
    try {
      const result = await this.pool.query<{ handle: string | null }>(
        `SELECT handle FROM users WHERE uuid = $1`,
        [userUuid],
      );
      return result.rows[0]?.handle ?? null;
    } catch (error: unknown) {
      this.#logger.warn(
        `no payment handle for ${userUuid}: ${describe(error)}. ` +
          `If this says the column does not exist, apply ` +
          `packages/ledger/sql/039_profile_handles.sql.`,
      );
      return null;
    }
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

/** An error's message, or its stringification. Used by the profile reads,
 *  which must log what went wrong without letting it reach a customer. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
