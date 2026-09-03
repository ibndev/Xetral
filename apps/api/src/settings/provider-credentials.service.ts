import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { OnApplicationBootstrap } from '@nestjs/common';
import type { Pool } from 'pg';
import { open, seal } from '@xetral/identity';
import type { Keyring } from '@xetral/identity';
import { API_CONFIG, DATABASE } from '../tokens.js';
import type { ApiConfig } from '../config.js';

/**
 * Provider credentials an operator can replace from the dashboard.
 *
 * WHY THIS IS NOT `SettingsService`. That service is the right home for a fee
 * or a ceiling and the wrong home for a secret, because two of its features
 * become liabilities: `platform_settings_history` records every value the row
 * has ever held, and the admin endpoint writes the new value into the
 * append-only audit log. Both are correct for a fee. Applied to an API key,
 * rotating one would leave the compromised value in two immutable tables.
 *
 * THERE IS NO METHOD HERE THAT RETURNS A SECRET TO A CALLER. `secretFor()` is
 * for an adapter, in process; `status()` is what the dashboard sees, and it
 * carries a four-character hint. That division is the whole design: a
 * credential goes in and never comes back out over HTTP.
 */
export interface CredentialStatus {
  readonly provider: string;
  readonly name: string;
  readonly label: string;
  readonly description: string;
  readonly env_var: string;
  /** FALSE for a slot documented ahead of its adapter. The dashboard says so,
   *  because a filled box implies an integration that is running. */
  readonly in_use: boolean;
  readonly is_set: boolean;
  /** The last four characters, or null. Enough to answer "is this the key I
   *  pasted?" and useless to somebody reading over a shoulder. */
  readonly hint: string | null;
  readonly updated_at: string | null;
}

interface StatusRow {
  provider: string;
  name: string;
  label: string;
  description: string;
  env_var: string;
  in_use: boolean;
  is_set: boolean;
  hint: string | null;
  updated_at: Date | null;
}

/**
 * How long a decrypted credential is held before the database is asked again.
 *
 * Short, and shorter than `SettingsService`'s thirty seconds, because the
 * reason to change one of these is usually that it has been compromised — and
 * a five-second window between an operator pasting a new key and the old one
 * ceasing to be used is the difference between "revoked" and "revoked, mostly".
 */
const CACHE_MS = 5_000;

@Injectable()
export class ProviderCredentialService implements OnApplicationBootstrap {
  /** Said once at boot, for the same reason `SettingsService` says its own
   *  version: the database winning is the point, and it fails silently in the
   *  other direction — somebody edits the environment, restarts, and watches
   *  nothing change. */
  async onApplicationBootstrap(): Promise<void> {
    await this.warnAboutOverrides();
  }

  readonly #logger = new Logger(ProviderCredentialService.name);
  readonly #cache = new Map<string, { value: string; readAt: number }>();

  constructor(
    @Inject(DATABASE) private readonly pool: Pool,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
  ) {}

  /** Every slot and whether it is filled — never what is in it. */
  async status(): Promise<readonly CredentialStatus[]> {
    const result = await this.pool.query<StatusRow>(
      `SELECT provider, name, label, description, env_var, in_use,
              is_set, hint, updated_at
         FROM provider_credential_status`,
    );
    return result.rows.map((row) => ({
      provider: row.provider,
      name: row.name,
      label: row.label,
      description: row.description,
      env_var: row.env_var,
      in_use: row.in_use,
      is_set: row.is_set,
      hint: row.hint,
      updated_at: row.updated_at?.toISOString() ?? null,
    }));
  }

  /** That a credential was replaced, by whom, and when. Never what it was. */
  async rotations(
    provider: string,
    name: string,
  ): Promise<readonly Record<string, unknown>[]> {
    const result = await this.pool.query(
      `SELECT r.old_hint, r.new_hint, r.changed_at, u.email AS changed_by
         FROM provider_credential_rotations r
         LEFT JOIN users u ON u.id = r.changed_by
        WHERE r.provider = $1 AND r.name = $2
        ORDER BY r.changed_at DESC
        LIMIT 50`,
      [provider, name],
    );
    return result.rows;
  }

  /**
   * Stores a credential, sealed.
   *
   * `actorUuid` is resolved to an id here rather than taken as one, so a
   * caller cannot attribute a rotation to somebody else by passing a number.
   */
  async set(
    provider: string,
    name: string,
    secret: string,
    actorUuid: string,
  ): Promise<CredentialStatus> {
    const trimmed = secret.trim();
    if (trimmed === '') {
      // An empty string would seal successfully and produce a credential that
      // authenticates nothing, which presents as the provider rejecting every
      // request rather than as a mistake here.
      throw new BadRequestException({ error: 'invalid_request', fields: ['secret'] });
    }

    const slot = await this.pool.query(
      `SELECT 1 FROM provider_credential_slots WHERE provider = $1 AND name = $2`,
      [provider, name],
    );
    if (slot.rowCount === 0) {
      // A slot nothing reads is a credential an operator believes is live.
      // Refusing an unknown one is what makes the catalogue meaningful.
      throw new NotFoundException({ error: 'credential_not_found' });
    }

    await this.pool.query(
      `INSERT INTO provider_credentials (provider, name, secret_sealed, hint, updated_by)
       SELECT $1, $2, $3, $4, u.id FROM users u WHERE u.uuid = $5::uuid
       ON CONFLICT (provider, name) DO UPDATE
          SET secret_sealed = EXCLUDED.secret_sealed,
              hint = EXCLUDED.hint,
              updated_by = EXCLUDED.updated_by,
              updated_at = now()`,
      [provider, name, seal(trimmed, this.#keyring()), hintOf(trimmed), actorUuid],
    );

    // The next read goes to the database. Leaving the old value cached would
    // mean a key an operator has just revoked keeps working for a few seconds
    // more, which is exactly the window they were trying to close.
    this.#cache.delete(`${provider}:${name}`);

    const found = (await this.status()).find(
      (row) => row.provider === provider && row.name === name,
    );
    if (found === undefined) throw new Error('credential upsert returned no status');
    return found;
  }

  /**
   * The plaintext, for an adapter, in process.
   *
   * THE DATABASE IS AUTHORITATIVE AND `fallback` IS THE ENVIRONMENT — the same
   * order `SettingsService` uses, and for the same reason: it lets a key be
   * replaced during an incident without a deploy. It also fails the same
   * silent way, so `warnAboutOverrides()` names every environment value the
   * database is overriding at boot.
   *
   * Never logs the value, and never logs the failure's contents: a decryption
   * error's message can carry ciphertext.
   */
  async secretFor(
    provider: string,
    name: string,
    fallback?: string,
  ): Promise<string | undefined> {
    const key = `${provider}:${name}`;
    const cached = this.#cache.get(key);
    if (cached !== undefined && Date.now() - cached.readAt < CACHE_MS) {
      return cached.value;
    }

    try {
      const result = await this.pool.query<{ secret_sealed: string }>(
        `SELECT secret_sealed FROM provider_credentials WHERE provider = $1 AND name = $2`,
        [provider, name],
      );
      const sealed = result.rows[0]?.secret_sealed;
      if (sealed === undefined) return fallback;

      const keyring = this.config.encryptionKeyring;
      if (keyring === undefined) {
        this.#logger.error(
          `${key} is stored but the keyring is unset; falling back to the environment`,
        );
        return fallback;
      }

      const value = open(sealed, keyring);
      this.#cache.set(key, { value, readAt: Date.now() });
      return value;
    } catch {
      // Deliberately swallowing the error object rather than logging it. A
      // decryption failure's message can include the ciphertext it failed on,
      // and a log line is the one place a sealed credential must not appear.
      this.#logger.error(`could not read ${key}; falling back to the environment`);
      return fallback;
    }
  }

  /**
   * Names every environment credential the database is overriding.
   *
   * The failure this prevents is the mirror image of the one the store exists
   * for: somebody edits the deployment's environment, restarts, and watches
   * nothing change, because the stored row wins. Said once at boot, naming the
   * slot and never the value.
   */
  async warnAboutOverrides(): Promise<void> {
    try {
      const rows = await this.status();
      const overridden = rows.filter(
        (row) => row.is_set && environmentValue(this.config, row.provider, row.name) !== undefined,
      );
      for (const row of overridden) {
        this.#logger.warn(
          `${row.env_var} is set AND ${row.provider}.${row.name} is stored in the database. ` +
            `The stored one wins; editing the environment will change nothing.`,
        );
      }
    } catch {
      // A warning that cannot be produced must not stop the process booting.
      this.#logger.warn('could not check provider credentials against the environment');
    }
  }

  #keyring(): Keyring {
    const keyring = this.config.encryptionKeyring;
    if (keyring === undefined) {
      // Refusing beats storing an API key in the clear, the same answer the
      // KYC service gives about a BVN.
      throw new ServiceUnavailableException({ error: 'encryption_not_configured' });
    }
    return keyring;
  }
}

/**
 * The last four characters, or fewer for a short value.
 *
 * FOUR, matching `cards.last4` and its CHECK, and for the same reason: "just
 * enough to recognise it" grows into "most of it" the first time somebody is
 * debugging in a hurry, and then a dashboard screenshot carries a working
 * credential.
 */
export function hintOf(secret: string): string {
  return secret.slice(-4).replace(/[^A-Za-z0-9_.\-]/g, '.');
}

/**
 * What the environment holds for a slot, if anything.
 *
 * A switch rather than a lookup by name, so adding a slot to the catalogue
 * without teaching the config about it is a compiler-visible gap rather than
 * an override warning that silently never fires.
 */
function environmentValue(
  config: ApiConfig,
  provider: string,
  name: string,
): string | undefined {
  switch (`${provider}.${name}`) {
    case 'bitnob.client_id':
      return config.bitnobClientId;
    case 'bitnob.client_secret':
      return config.bitnobClientSecret;
    case 'paystack.secret_key':
      return config.paystackSecretKey;
    case 'bitnob.webhook_secret':
      return config.bitnobWebhookSecret;
    case 'vtpass.api_key':
      return config.vtpassApiKey;
    case 'vtpass.secret_key':
      return config.vtpassSecretKey;
    case 'vtpass.public_key':
      return config.vtpassPublicKey;
    case 'airalo.client_secret':
      return config.airaloClientSecret;
    case 'twilio.auth_token':
      return config.twilioAuthToken;
    case 'resend.api_key':
      return config.resendApiKey;
    // Dojah has no adapter yet, so it has no config field to override. When
    // one lands, the case goes here and the warning starts working — which is
    // the point of the switch: there is one place to notice.
    default:
      return undefined;
  }
}
