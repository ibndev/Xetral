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
import { API_CONFIG, DATABASE } from '../tokens.js';
import type { ApiConfig } from '../config.js';

/**
 * Operational policy, read from the database rather than the environment.
 *
 * THE SPLIT THIS ENFORCES: secrets stay in the environment, because a database
 * row is readable by anyone with a database connection and a signing key must
 * not be. Policy — fees, limits, feature flags — lives here, because it changes
 * at the speed of a business decision and should leave an audit trail rather
 * than a deployment.
 *
 * Values are CACHED, and the cache is the interesting part. Reading a fee from
 * the database on every transfer puts a query in the hot path of the thing
 * that must not be slow; reading it once at boot means a change needs a
 * restart, which is the problem this exists to remove. So: a short TTL,
 * refreshed on demand, invalidated immediately on the instance that made the
 * change, and picked up elsewhere within the TTL.
 */

const CACHE_TTL_MS = 30_000;

interface SettingRow {
  key: string;
  value: string;
  value_type: 'integer' | 'boolean' | 'text';
  min_value: string | null;
  max_value: string | null;
  label: string;
  description: string;
  category: string;
  sensitive: boolean;
  updated_at: string;
}

export interface SettingView {
  readonly key: string;
  readonly value: string;
  readonly type: string;
  readonly min: string | null;
  readonly max: string | null;
  readonly label: string;
  readonly description: string;
  readonly category: string;
  readonly sensitive: boolean;
  readonly updated_at: string;
}

/**
 * Every service that can be switched off, and the accessor that reads its
 * flag.
 *
 * A single list rather than a check written at each call site, because "which
 * services can be paused" is an operational question with one answer, and the
 * audit found two flags that existed everywhere except at a call site. Adding
 * a service here without asserting it somewhere fails `kill-switches.test.ts`.
 */
export const KILL_SWITCHES = {
  crypto: (s: SettingsService) => s.cryptoEnabled(),
  fx: (s: SettingsService) => s.fxEnabled(),
  cards: (s: SettingsService) => s.cardsEnabled(),
  bills: (s: SettingsService) => s.billsEnabled(),
} as const;

export type KillSwitch = keyof typeof KILL_SWITCHES;

/**
 * The refusal each switch produces, written out as literals.
 *
 * Built with a template — `${service}_disabled` — these codes would be
 * invisible to `error-codes.test.ts`, which scans the source for
 * `error: '...'` to prove the API and the client agree on every code a
 * customer can receive. A code that no scanner can find is a code that
 * silently drifts out of the client's union and reaches a customer as
 * "Something went wrong".
 *
 * Four lines of repetition buys a greppable code and a checked invariant.
 */
const DISABLED_ERROR: Record<KillSwitch, { readonly error: string }> = {
  crypto: { error: 'crypto_disabled' },
  fx: { error: 'fx_disabled' },
  cards: { error: 'cards_disabled' },
  bills: { error: 'bills_disabled' },
};

@Injectable()
export class SettingsService implements OnApplicationBootstrap {
  readonly #logger = new Logger(SettingsService.name);
  #cache = new Map<string, string>();
  #loadedAt = 0;

  constructor(
    @Inject(DATABASE) private readonly pool: Pool,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    // Loaded at boot so the first request does not pay for it, and so a
    // database that cannot answer is discovered at startup rather than by a
    // customer.
    await this.refresh().catch((error: unknown) => {
      this.#logger.error(
        `could not load platform settings: ${describe(error)}. ` +
          `Falling back to environment defaults until a read succeeds.`,
      );
    });

    this.#warnAboutOverriddenEnvironment();
  }

  /**
   * Says so, out loud, when an environment variable is being ignored.
   *
   * The database is authoritative and the environment value is only a fallback
   * for the moments before the settings table can be read. That is the right
   * arrangement — an operator changing a fee should not need a deploy — but it
   * fails silently in a way that wastes a whole afternoon: somebody sets
   * `TRANSFER_FEE_BASIS_POINTS=150`, restarts, watches nothing happen, and has
   * no reason to suspect a table they may not know exists.
   *
   * Found by a test, not by reasoning: a suite that configured a fee through
   * `ApiConfig` started measuring zero the moment the seed landed. If a test
   * holding the config in its own hand can be confused by this, an operator
   * three months from now certainly can.
   */
  #warnAboutOverriddenEnvironment(): void {
    const overridden: string[] = [];

    const compare = (key: string, envValue: string | undefined): void => {
      if (envValue === undefined) return;
      const stored = this.#cache.get(key);
      if (stored !== undefined && stored !== envValue) {
        overridden.push(`${key}: the database says ${stored}, this instance's environment says ${envValue}`);
      }
    };

    compare('transfer_fee_basis_points', String(this.config.transferFeeBasisPoints));
    compare('deposit_ceiling_kobo', this.config.depositCeilingKobo?.toString());
    compare('giftcard_hold_days', String(this.config.giftCardHoldDays));

    if (overridden.length > 0) {
      this.#logger.warn(
        `platform_settings is authoritative and these environment values are NOT in effect — ` +
          `change them in the admin dashboard, not here: ${overridden.join('; ')}`,
      );
    }
  }

  async refresh(): Promise<void> {
    const rows = await this.pool.query<{ key: string; value: string }>(
      `SELECT key, value FROM platform_settings`,
    );
    const next = new Map<string, string>();
    for (const row of rows.rows) next.set(row.key, row.value);
    this.#cache = next;
    this.#loadedAt = Date.now();
  }

  async #fresh(): Promise<Map<string, string>> {
    if (Date.now() - this.#loadedAt > CACHE_TTL_MS) {
      // A failed refresh keeps the last known values rather than throwing. A
      // brief database hiccup must not stop transfers on the strength of not
      // knowing the fee — the previous fee is the right answer for 30 seconds.
      await this.refresh().catch((error: unknown) => {
        this.#logger.warn(`settings refresh failed, using cached values: ${describe(error)}`);
      });
    }
    return this.#cache;
  }

  async integer(key: string, fallback: number): Promise<number> {
    const raw = (await this.#fresh()).get(key);
    if (raw === undefined) return fallback;
    const value = Number(raw);
    return Number.isInteger(value) ? value : fallback;
  }

  async bigint(key: string, fallback: bigint): Promise<bigint> {
    const raw = (await this.#fresh()).get(key);
    if (raw === undefined || !/^-?[0-9]+$/.test(raw)) return fallback;
    return BigInt(raw);
  }

  async boolean(key: string, fallback: boolean): Promise<boolean> {
    const raw = (await this.#fresh()).get(key);
    if (raw === undefined) return fallback;
    return raw === 'true';
  }

  async text(key: string, fallback: string): Promise<string> {
    return (await this.#fresh()).get(key) ?? fallback;
  }

  /* ------------------------- the named policies -------------------------
   *
   * Named accessors rather than string keys at call sites. A typo in
   * `integer('transfer_fee_basis_pointz', 0)` silently returns the fallback
   * and charges nothing — a fee that quietly stops applying is worse than one
   * that errors, because nobody notices for a month.
   */

  async transferFeeBasisPoints(): Promise<number> {
    return this.integer('transfer_fee_basis_points', this.config.transferFeeBasisPoints);
  }

  /* ---------------------------------- tax ------------------------------ */

  /**
   * VAT on FEES, in basis points. Never applied to the amount being
   * transferred: what is taxed is the service, not the money moving.
   */
  async vatBasisPoints(): Promise<number> {
    return this.integer('vat_basis_points', 750);
  }

  /** TRUE means a fee is what the customer pays and part of it is VAT, so
   *  turning VAT on changes the books and not the price. */
  async vatInclusive(): Promise<boolean> {
    return this.boolean('vat_inclusive', true);
  }

  /**
   * Whether to charge the electronic money transfer levy.
   *
   * Defaults FALSE, and the default is the decision: turning it on changes
   * what customers are charged, and whether it applies to a wallet like this
   * one is a question for a Nigerian tax adviser rather than for a default.
   */
  async transferLevyEnabled(): Promise<boolean> {
    return this.boolean('transfer_levy_enabled', false);
  }

  async transferLevyKobo(): Promise<bigint> {
    return this.bigint('transfer_levy_kobo', 5000n);
  }

  async transferLevyThresholdKobo(): Promise<bigint> {
    return this.bigint('transfer_levy_threshold_kobo', 1000000n);
  }

  async depositCeilingKobo(): Promise<bigint> {
    return this.bigint('deposit_ceiling_kobo', this.config.depositCeilingKobo);
  }

  async transferDailyLimitKobo(): Promise<bigint> {
    return this.bigint('transfer_daily_limit_kobo', 5_000_000_00n);
  }

  async purchaseDailyLimitKobo(): Promise<bigint> {
    return this.bigint('purchase_daily_limit_kobo', 200_000_00n);
  }

  /**
   * How many people a customer may pay for the FIRST time in one Lagos day.
   *
   * A COUNT, so it carries no units and applies in every currency — unlike the
   * daily ceilings above, which are published in kobo and are therefore
   * statements about naira and nothing else.
   */
  async transferNewRecipientsDaily(): Promise<number> {
    return this.integer('transfer_new_recipients_daily', 10);
  }

  /** How many transfers a customer may send in a rolling hour, any currency. */
  /**
   * A provider/ledger difference at or below this is not recorded.
   *
   * ZERO by default. On a double-entry ledger the correct difference is
   * nothing, and a tolerance is a decision to stop looking at a class of error.
   */
  async balanceToleranceMinor(): Promise<number> {
    return this.integer('balance_tolerance_minor', 0);
  }

  async fxDailyLimitKobo(): Promise<bigint> {
    return this.bigint('fx_daily_limit_kobo', 5_000_000_00n);
  }

  async giftcardDailyLimitKobo(): Promise<bigint> {
    return this.bigint('giftcard_daily_limit_kobo', 2_000_000_00n);
  }

  async cryptoWithdrawalCountHourly(): Promise<number> {
    return this.integer('crypto_withdrawal_count_hourly', 3);
  }

  async fxCountHourly(): Promise<number> {
    return this.integer('fx_count_hourly', 10);
  }

  async giftcardCountHourly(): Promise<number> {
    return this.integer('giftcard_count_hourly', 5);
  }

  /**
   * The daily withdrawal ceiling for one crypto asset, in ITS OWN minor units.
   *
   * Keyed by asset because there is no currency-agnostic amount: USDT has six
   * decimals and BTC has eight, so one number shared between them would mean
   * two different things. An asset with no configured row returns undefined —
   * no ceiling — rather than zero, because a limit nobody set must not refuse
   * every withdrawal of that asset.
   */
  async cryptoDailyLimitMinor(currency: string): Promise<bigint | undefined> {
    const key = `crypto_daily_limit_${currency.toLowerCase()}_minor`;
    const raw = await this.text(key, '');
    if (raw === '' || !/^[0-9]+$/.test(raw)) return undefined;
    return BigInt(raw);
  }

  async transferCountHourly(): Promise<number> {
    return this.integer('transfer_count_hourly', 20);
  }

  /**
   * Gift cards need BOTH keys turned: the deployment's own flag AND the stored
   * setting. Every other setting is decided by the database alone.
   *
   * The asymmetry is deliberate and is about what this feature is. Buying gift
   * cards FROM customers is the one flow where we pay out against a bearer
   * instrument whose value cannot be verified at the moment we pay — the
   * highest-fraud surface in the product, and the reason it ships disabled.
   * Enabling it should therefore take a deliberate deployment change and a
   * deliberate operator action, not one dashboard toggle by whoever has the
   * `finance` role this month.
   *
   * The composition also only ever moves in the safe direction: either switch
   * being off means off, so an incident can be stopped from the dashboard in
   * seconds without waiting for a deploy, and a deployment that has never
   * reviewed the feature cannot have it switched on beneath it.
   */
  async giftCardsEnabled(): Promise<boolean> {
    if (!this.config.giftCardsEnabled) return false;
    return this.boolean('gift_cards_enabled', false);
  }

  /*
   * THE KILL SWITCHES.
   *
   * Each of these must be ASSERTED by the service that owns the flow. Two of
   * them — crypto and FX — existed here, were listed in the admin dashboard,
   * and were read by nothing at all: an operator could switch crypto off
   * during a Bitnob incident, watch the dashboard confirm it, and withdrawals
   * would keep going out. A switch that reports success and changes nothing is
   * worse than no switch, because it is trusted at exactly the wrong moment.
   *
   * `assertServiceEnabled` below is the only sanctioned way to read one, and
   * `kill-switches.test.ts` fails the build if a service gains a flag without
   * a call site.
   */
  async cryptoEnabled(): Promise<boolean> {
    return this.boolean('crypto_enabled', true);
  }

  async fxEnabled(): Promise<boolean> {
    return this.boolean('fx_enabled', true);
  }

  async cardsEnabled(): Promise<boolean> {
    return this.boolean('cards_enabled', true);
  }

  async billsEnabled(): Promise<boolean> {
    return this.boolean('bills_enabled', true);
  }

  /**
   * Refuses with a 503 when the named service is switched off.
   *
   * `ServiceUnavailableException` rather than a 4xx, deliberately: the request
   * was well-formed and the customer did nothing wrong. It also means a client
   * retry is the correct behaviour once the incident is over, and monitoring
   * sees a service outage rather than a wave of customer errors.
   *
   * The error code names the SERVICE, so a screen can say which part of the
   * product is paused rather than showing one generic message everywhere.
   */
  async assertServiceEnabled(service: KillSwitch): Promise<void> {
    const on = await KILL_SWITCHES[service](this);
    if (!on) throw new ServiceUnavailableException(DISABLED_ERROR[service]);
  }

  async registrationEnabled(): Promise<boolean> {
    return this.boolean('registration_enabled', true);
  }

  async giftCardHoldDays(): Promise<number> {
    return this.integer('giftcard_hold_days', this.config.giftCardHoldDays);
  }

  /* ----------------------------- admin ---------------------------------- */

  async list(): Promise<readonly SettingView[]> {
    const rows = await this.pool.query<SettingRow>(
      `SELECT key, value, value_type, min_value::text, max_value::text, label,
              description, category, sensitive, updated_at
         FROM platform_settings ORDER BY category, key`,
    );
    return rows.rows.map((r) => ({
      key: r.key,
      value: r.value,
      type: r.value_type,
      min: r.min_value,
      max: r.max_value,
      label: r.label,
      description: r.description,
      category: r.category,
      sensitive: r.sensitive,
      updated_at: r.updated_at,
    }));
  }

  /**
   * Changes one setting.
   *
   * The bounds are enforced by the DATABASE, by trigger, so the rule holds for
   * a psql session at 3am as well as for this endpoint. What this adds is a
   * readable error instead of a raw constraint violation, and the cache
   * invalidation.
   */
  async set(key: string, value: string, actorUuid: string): Promise<SettingView> {
    let updated;
    try {
      // `updated_by` is the numeric id and the caller has a UUID, so the
      // lookup happens in the statement. The history row the trigger writes
      // picks up the same value, which is why it has to be set here rather
      // than afterwards.
      updated = await this.pool.query<{ key: string }>(
        `UPDATE platform_settings
            SET value = $2,
                updated_by = (SELECT id FROM users WHERE uuid = $3::uuid)
          WHERE key = $1 RETURNING key`,
        [key, value, actorUuid],
      );
    } catch (error) {
      throw new BadRequestException({
        error: 'invalid_setting',
        detail: error instanceof Error ? error.message : String(error),
      });
    }

    if (updated.rows.length === 0) {
      throw new NotFoundException({ error: 'setting_not_found', key });
    }

    await this.refresh();

    const view = (await this.list()).find((s) => s.key === key);
    if (view === undefined) throw new NotFoundException({ error: 'setting_not_found', key });
    return view;
  }

  async history(key: string): Promise<readonly Record<string, unknown>[]> {
    const rows = await this.pool.query(
      `SELECT h.old_value, h.new_value, h.changed_at, u.email AS changed_by
         FROM platform_settings_history h
         LEFT JOIN users u ON u.id = h.changed_by
        WHERE h.key = $1 ORDER BY h.changed_at DESC LIMIT 50`,
      [key],
    );
    return rows.rows as Record<string, unknown>[];
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
