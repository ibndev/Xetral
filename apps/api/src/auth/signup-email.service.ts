import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { hashSignupEmailCode, issueSignupEmailCode } from '@xetral/identity';
import { API_CONFIG, DATABASE } from '../tokens.js';
import type { ApiConfig } from '../config.js';
import { NotificationService } from '../notifications/notification.service.js';
import { NotificationWorker } from '../notifications/notification.worker.js';
import { SettingsService } from '../settings/settings.service.js';
import { acceptsTestOtp, isTestEmail } from './test-accounts.js';

/** Minutes a signup code lives. Long enough to find the email, short enough to be worthless later. */
const CODE_TTL_MINUTES = 5;
/** Wrong guesses across an address's live codes before even the right one is refused. */
const MAX_ATTEMPTS = 5;

/** `undefined_table` and `undefined_function`: a database behind 084. */
const SCHEMA_BEHIND = new Set(['42P01', '42883']);

/**
 * PROVING AN EMAIL ADDRESS BEFORE AN ACCOUNT IS OPENED ON IT.
 *
 * A mistyped address opened an account whose owner could never receive a
 * reset code or a new-device alert — the security mail this platform depends
 * on, sent to a stranger or to nobody — and it is the address a Paystack
 * customer and a dedicated account number are opened against the moment the
 * account exists. So the address is proved first: a six-digit code, mailed to
 * it, and required by registration.
 *
 * A DATABASE BEHIND 084 DOES NOT STOP SIGNUPS. The table and the function
 * arrive in that migration; code that ships before an operator applies it
 * must not turn every registration into a 500. It logs loudly and lets the
 * registration through unproved — the state every account opened before
 * this was in — rather than taking the front door off the building.
 */
@Injectable()
export class SignupEmailService {
  readonly #logger = new Logger(SignupEmailService.name);

  constructor(
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(DATABASE) private readonly pool: Pool,
    @Inject(NotificationService) private readonly notifications: NotificationService,
    @Inject(NotificationWorker) private readonly worker: NotificationWorker,
    @Inject(SettingsService) private readonly settings: SettingsService,
  ) {}

  /** Whether registration must present a code. */
  async required(): Promise<boolean> {
    if (!this.config.signupEmailVerification) return false;
    return this.settings.signupEmailVerification();
  }

  /**
   * Mail a code to an address somebody is signing up with.
   *
   * AN ADDRESS ALREADY REGISTERED IS SAID SO, here as at registration — the
   * trade `register()` already makes: a signup form that cannot say "you
   * already have an account" sends people in circles, and the endpoint is
   * limited per address like the reset one.
   */
  async sendCode(email: string): Promise<{ readonly required: boolean }> {
    const address = email.trim().toLowerCase();
    if (!(await this.required())) return { required: false };

    /*
     * A WHITELISTED TEST ADDRESS IS SENT NOTHING when `TEST_OTP` is set: the
     * fixed code is what it signs up with (`check` below), and mailing a real
     * one on every test run is the inbox noise the owner asked to be rid of.
     * The address is still refused when an account holds it — a reset is
     * what frees it, not this.
     */
    if (this.config.testAccounts.otp !== undefined && isTestEmail(this.config, address)) {
      const held = await this.pool.query(`SELECT 1 FROM users WHERE lower(email) = $1`, [address]);
      if ((held.rowCount ?? 0) > 0) throw new ConflictException({ error: 'email_taken' });
      return { required: true };
    }

    if (!this.notifications.deliverable) {
      // Nothing would send it, so asking for it would strand the customer at
      // a box waiting for mail. Named, so the signup screen can say so.
      throw new ServiceUnavailableException({ error: 'email_unavailable' });
    }

    const taken = await this.pool.query(`SELECT 1 FROM users WHERE lower(email) = $1`, [address]);
    if ((taken.rowCount ?? 0) > 0) throw new ConflictException({ error: 'email_taken' });

    const issued = issueSignupEmailCode(address, this.config.accessTokenKeyring.current.secret);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO signup_email_codes (email, code_hash, expires_at)
         VALUES ($1, $2, now() + make_interval(mins => $3::int))`,
        [address, issued.hash, CODE_TTL_MINUTES],
      );
      await this.notifications.enqueue(client, {
        userId: null,
        recipient: address,
        // Keyed on the CODE, so two requests are two codes and both are sent.
        idempotencyKey: `signup_code:${issued.hash}`,
        request: { kind: 'signup_code', code: issued.code, expiresInMinutes: CODE_TTL_MINUTES },
      });
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      if (isSchemaBehind(error)) {
        this.#logger.error(
          'signup email codes need migration 084_signup_email_codes.sql; registration is ' +
            'accepting addresses unproved until it is applied',
        );
        return { required: false };
      }
      throw error;
    } finally {
      client.release();
    }

    // Sent NOW, as the reset code is: somebody is standing at the form.
    void this.worker.deliverNow(`signup_code:${issued.hash}`);
    return { required: true };
  }

  /**
   * CHECK the code before the registration's transaction opens.
   *
   * On its own connection, because a wrong code makes the registration throw
   * and a throw rolls back whatever that transaction wrote — including the
   * attempt charge, so a ceiling charged in there would never accrue. Here a
   * wrong guess is charged and committed before the refusal is raised.
   *
   * Returns the hash to spend inside the transaction, or undefined when no
   * code is required (switched off, or a database behind 084).
   */
  async check(
    email: string,
    code: string | undefined,
    phone?: string,
  ): Promise<string | undefined> {
    if (!(await this.required())) return undefined;
    if (code === undefined || !/^[0-9]{6}$/.test(code)) {
      throw new BadRequestException({ error: 'email_code_required' });
    }
    // `TEST_OTP`, for a whitelisted email or phone only. Nothing to spend: no
    // code row was ever written for it.
    if (acceptsTestOtp(this.config, code, { email, phone })) return undefined;
    const address = email.trim().toLowerCase();
    const hash = hashSignupEmailCode(address, code, this.config.accessTokenKeyring.current.secret);
    let outcome: string;
    try {
      const result = await this.pool.query<{ outcome: string }>(
        `SELECT consume_signup_email_code($1, $2, $3, FALSE) AS outcome`,
        [address, hash, MAX_ATTEMPTS],
      );
      outcome = result.rows[0]?.outcome ?? 'none';
    } catch (error) {
      if (isSchemaBehind(error)) {
        this.#logger.error('signup email codes need migration 084_signup_email_codes.sql');
        return undefined;
      }
      throw error;
    }
    if (outcome === 'matched') return hash;
    if (outcome === 'too_many_attempts') {
      // Said out loud, as 056 does: it tells an attacker nothing new and tells
      // the customer the one thing that helps — ask for another code.
      throw new BadRequestException({ error: 'too_many_attempts' });
    }
    throw new BadRequestException({ error: 'email_code_invalid' });
  }

  /**
   * SPEND the checked code on the REGISTRATION'S OWN TRANSACTION, so a
   * registration that fails afterwards has not used it up and two racing on
   * one code cannot both open an account — the loser finds it spent.
   */
  async spend(client: PoolClient, email: string, hash: string): Promise<void> {
    const result = await client.query<{ outcome: string }>(
      `SELECT consume_signup_email_code($1, $2, $3, TRUE) AS outcome`,
      [email.trim().toLowerCase(), hash, MAX_ATTEMPTS],
    );
    if (result.rows[0]?.outcome !== 'consumed') {
      throw new BadRequestException({ error: 'email_code_invalid' });
    }
  }
}

function isSchemaBehind(error: unknown): boolean {
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && SCHEMA_BEHIND.has(code);
}
