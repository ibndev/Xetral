import { Buffer } from 'node:buffer';
import type { AccessTokenKey, AccessTokenKeyring, EncryptionKey, Keyring } from '@xetral/identity';
import type { NgnAmountUnit } from '@xetral/providers';
import { ACCESS_TOKEN_TTL_SECONDS, REFRESH_TOKEN_TTL_SECONDS } from '@xetral/identity';

/**
 * Configuration, loaded once at boot and never re-read.
 *
 * NOTHING here has a default that would work in production. A development
 * fallback for a signing key is the single most reliable way to ship a
 * production system that verifies tokens with a secret published on GitHub, so
 * every secret is required and the process refuses to start without it.
 * Failing at boot is loud; failing closed at 3am is not.
 */

export interface RateLimitRule {
  readonly max: number;
  readonly windowSeconds: number;
}

export interface ApiConfig {
  readonly databaseUrl: string;
  readonly accessTokenKeyring: AccessTokenKeyring;
  readonly accessTokenTtlSeconds: number;
  readonly refreshTokenTtlSeconds: number;
  readonly loginRateLimit: {
    /** Guards one account against a distributed attack. */
    readonly perIdentifier: RateLimitRule;
    /** Guards every account against one noisy source. */
    readonly perIp: RateLimitRule;
  };
  /**
   * Number of proxy hops in front of the app. Cloudflare plus Coolify's router
   * is two. Getting this wrong is not cosmetic: too high and a client can spoof
   * `X-Forwarded-For` to dodge per-IP rate limiting entirely, too low and every
   * request appears to come from the proxy so one bucket throttles all
   * customers at once.
   */
  readonly trustProxyHops: number;
  /**
   * When set, rate limiting is shared across instances. When absent it is
   * in-process, which is correct for one box and silently wrong for two — so
   * bootstrap logs a warning naming that, rather than letting the limit quietly
   * multiply by the instance count.
   */
  readonly redisUrl: string | undefined;
  /**
   * Transfer fee in BASIS POINTS (150 = 1.5%), never a decimal.
   *
   * Defaults to ZERO, deliberately. A fee nobody configured is money taken
   * from a customer because of a default, and the failure is silent — every
   * transfer just costs slightly more than the product intended. Charging
   * nothing until somebody sets a number is the safe direction to be wrong in.
   */
  readonly transferFeeBasisPoints: number;

  /**
   * Bitnob credentials. Optional as a set: an instance with no card
   * configuration still serves wallets and auth, and refuses card routes rather
   * than booting with a placeholder key that would fail on the first real call.
   */
  /** Includes the version segment: `https://api.bitnob.co/api/v1` (sandbox:
   *  `https://sandboxapi.bitnob.co/api/v1`). The endpoint table is relative to
   *  it, so omitting `/api/v1` produces 404s on every card call. */
  readonly bitnobBaseUrl: string | undefined;
  readonly bitnobApiKey: string | undefined;
  readonly bitnobWebhookSecret: string | undefined;

  /**
   * Keys for sealing what must be stored but not stored in the clear: an
   * electricity token, an eSIM activation code.
   *
   * Optional as a set, and its absence REFUSES the routes that would write one
   * rather than falling back to plaintext. A fallback here is not a degraded
   * mode, it is a database column full of bearer instruments — and nothing in
   * the logs would say which rows were written before the key arrived.
   */
  readonly encryptionKeyring: Keyring | undefined;

  /** VTpass — airtime, data, utilities. `https://vtpass.com` (sandbox:
   *  `https://sandbox.vtpass.com`); the endpoint table adds `/api/...`.
   *  Optional as a set, same reasoning as Bitnob: an instance without them
   *  serves everything else and refuses these. */
  readonly vtpassBaseUrl: string | undefined;
  readonly vtpassApiKey: string | undefined;
  readonly vtpassSecretKey: string | undefined;
  readonly vtpassPublicKey: string | undefined;

  /** Airalo — eSIM. `https://partners-api.airalo.com`; the endpoint table adds
   *  the `/v2/...` slugs. */
  readonly airaloBaseUrl: string | undefined;
  readonly airaloClientId: string | undefined;
  readonly airaloClientSecret: string | undefined;

  /** Twilio — virtual numbers. `https://api.twilio.com`; the endpoint table
   *  adds the `/2010-04-01/...` paths. */
  readonly twilioBaseUrl: string | undefined;
  readonly twilioAccountSid: string | undefined;
  readonly twilioAuthToken: string | undefined;
  /**
   * What WE charge for a number, in cents — not what Twilio charges us. Twilio
   * prices per country and changes them; billing a customer whatever a provider
   * happened to answer that day is how a margin becomes a loss without anyone
   * deciding to make it one. There is no default, so an instance that has not
   * priced numbers cannot sell one.
   */
  readonly twilioNumberPriceCents: bigint | undefined;

  /**
   * How often this instance sweeps held purchases, in seconds.
   *
   * Undefined means it does not sweep at all, and that is the default on
   * purpose: several instances behind a load balancer would each run the
   * sweep, and while duplicate work is safe, asking a provider about the same
   * purchase from four processes is rude at best and rate-limited at worst.
   * Exactly one instance sets this, and bootstrap warns when none has.
   */
  readonly reconcileIntervalSeconds: number | undefined;
  /**
   * How long a reserved purchase is left alone before we ask about it.
   *
   * Not zero: the purchase row is written before the provider is called, so a
   * row a second old is almost certainly still in flight in a request handler
   * that is about to settle it. Sweeping it now races that handler for no gain.
   */
  readonly reconcileGraceSeconds: number | undefined;
  /**
   * After this long, a still-unresolved purchase is escalated to a human.
   *
   * It is NOT auto-reversed. By this point the automated remedies have been
   * tried and the provider still will not say what happened, and both
   * remaining answers — release the money or keep holding it — can be the
   * wrong one. Undefined means never escalate, which is right for a
   * development box and wrong for production.
   */
  readonly reconcileStaleSeconds: number | undefined;

  /**
   * Gift card trading. DEFAULTS TO OFF, and the default is the feature.
   *
   * Buying cards from customers is the highest-fraud surface in the product:
   * the goods are bearer instruments, the seller is anonymous enough, and a
   * redeemed card cannot be un-redeemed. The routes exist, are covered by the
   * policy audit and are exercised by tests — so enabling it is a
   * configuration change rather than a deploy of code nobody has run. That is
   * what "ships flagged off" is supposed to mean, as opposed to "unfinished".
   */
  readonly giftCardsEnabled: boolean;
  /**
   * How long an approved gift card payout stays unspendable.
   *
   * This is the window in which a clawback is recoverable rather than a loss:
   * an issuer voiding a card bought with a stolen credit card can take weeks,
   * and every day of hold is a day of that risk we can still undo. Shortening
   * it is a fraud-policy decision, not a UX tweak.
   */
  readonly giftCardHoldDays: number;
  /**
   * How often matured gift card holds are released, in seconds.
   *
   * Undefined means this instance does not release them, and exactly one
   * should — same arrangement as the reconciliation sweep. Bootstrap warns
   * loudly when gift cards are on and nobody is releasing, because that
   * failure is silent and slow: customers are paid and can never spend it.
   */
  readonly giftCardReleaseIntervalSeconds: number | undefined;

  /**
   * How Bitnob expresses an NGN amount in a deposit payload.
   *
   * Defaults to `kobo`, the natural minor unit for NGN and what the ledger
   * itself stores. It is a stated deployment value rather than a constant
   * because it could not be verified against Bitnob's live payloads before
   * go-live — and because being wrong in the expensive direction is caught by
   * `depositCeilingKobo` below rather than by hope. See
   * `packages/providers/src/bitnob/ngn-amounts.ts` for the full reasoning.
   */
  readonly bitnobNgnAmountUnit: NgnAmountUnit;
  /**
   * The largest single deposit that will be credited automatically, in kobo.
   *
   * Anything above it is posted to SUSPENSE and escalated instead. This is the
   * control that makes a misread amount recoverable: a factor-of-100 error on
   * any realistic transfer blows the ceiling, so the first wrong deposit is
   * held rather than spent. Defaults to N1,000,000.00, which an operator
   * should raise deliberately rather than discover.
   */
  readonly depositCeilingKobo: bigint;
  /** How often unmatched deposits are re-checked against the provider. One
   *  instance, same arrangement as the other sweeps. */
  readonly depositReconcileIntervalSeconds: number | undefined;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

type Env = Record<string, string | undefined>;

function required(env: Env, key: string): string {
  const value = env[key];
  if (value === undefined || value.trim() === '') {
    throw new ConfigError(`${key} is required and has no default`);
  }
  return value;
}

function integer(env: Env, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new ConfigError(`${key} must be a positive integer, got '${raw}'`);
  }
  return value;
}

/**
 * Parses `v1:<base64>,v2:<base64>`.
 *
 * Multiple keys are accepted at once so rotation is a two-deploy operation:
 * publish the new key to every instance first, then switch the current
 * version. Signing with a key half the fleet cannot verify produces
 * intermittent 401s that look like a load-balancer fault.
 */
function parseKeyring(env: Env): AccessTokenKeyring {
  const raw = required(env, 'ACCESS_TOKEN_KEYS');
  const currentVersion = required(env, 'ACCESS_TOKEN_CURRENT_VERSION');

  const accepted: AccessTokenKey[] = [];
  for (const entry of raw.split(',')) {
    const trimmed = entry.trim();
    if (trimmed === '') continue;

    const separator = trimmed.indexOf(':');
    if (separator === -1) {
      throw new ConfigError(`ACCESS_TOKEN_KEYS entries must look like 'v1:<base64>'`);
    }

    const version = trimmed.slice(0, separator);
    if (!/^v[0-9]+$/.test(version)) {
      throw new ConfigError(`ACCESS_TOKEN_KEYS version must look like 'v1', got '${version}'`);
    }

    const secret = Buffer.from(trimmed.slice(separator + 1), 'base64');
    if (secret.length < 32) {
      throw new ConfigError(
        `the key for ${version} must be at least 32 bytes, got ${secret.length}`,
      );
    }
    if (accepted.some((k) => k.version === version)) {
      throw new ConfigError(`ACCESS_TOKEN_KEYS declares ${version} twice`);
    }
    accepted.push({ version, secret });
  }

  const current = accepted.find((k) => k.version === currentVersion);
  if (current === undefined) {
    throw new ConfigError(
      `ACCESS_TOKEN_CURRENT_VERSION is '${currentVersion}', which is not in ACCESS_TOKEN_KEYS`,
    );
  }

  return { current, accepted };
}

/** Zero is a legitimate value, so this cannot reuse `integer()`, which treats
 *  zero as unset and falls back. */
function basisPoints(env: Env, key: string): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') return 0;

  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > 10_000) {
    throw new ConfigError(`${key} must be an integer between 0 and 10000, got '${raw}'`);
  }
  return value;
}

/**
 * Parses `v1:<base64>,v2:<base64>` into an envelope keyring.
 *
 * Deliberately NOT shared with parseKeyring above, despite the identical
 * format. Access-token keys sign; these encrypt, and AES-256 requires exactly
 * 32 bytes where an HMAC key merely wants at least that many. One function
 * with a length argument would let a 48-byte key past the check that is
 * supposed to catch it, and the two key sets must never be the same value
 * anyway — a key that both signs sessions and seals customer secrets makes one
 * leak into two incidents.
 */
function parseEncryptionKeyring(env: Env): Keyring | undefined {
  const raw = optional(env, 'ENCRYPTION_KEYS');
  const currentVersion = optional(env, 'ENCRYPTION_CURRENT_VERSION');
  if (raw === undefined && currentVersion === undefined) return undefined;
  if (raw === undefined || currentVersion === undefined) {
    throw new ConfigError('ENCRYPTION_KEYS and ENCRYPTION_CURRENT_VERSION must be set together');
  }

  const accepted: EncryptionKey[] = [];
  for (const entry of raw.split(',')) {
    const trimmed = entry.trim();
    if (trimmed === '') continue;

    const separator = trimmed.indexOf(':');
    if (separator === -1) {
      throw new ConfigError(`ENCRYPTION_KEYS entries must look like 'v1:<base64>'`);
    }

    const version = trimmed.slice(0, separator);
    if (!/^v[0-9]+$/.test(version)) {
      throw new ConfigError(`ENCRYPTION_KEYS version must look like 'v1', got '${version}'`);
    }

    const key = Buffer.from(trimmed.slice(separator + 1), 'base64');
    if (key.length !== 32) {
      throw new ConfigError(`the key for ${version} must be exactly 32 bytes, got ${key.length}`);
    }
    if (accepted.some((k) => k.version === version)) {
      throw new ConfigError(`ENCRYPTION_KEYS declares ${version} twice`);
    }
    accepted.push({ version, key });
  }

  const current = accepted.find((k) => k.version === currentVersion);
  if (current === undefined) {
    throw new ConfigError(
      `ENCRYPTION_CURRENT_VERSION is '${currentVersion}', which is not in ENCRYPTION_KEYS`,
    );
  }

  // Retired keys stay in `accepted` so old rows still open; only `current`
  // writes. Dropping a retired key is what makes existing data unreadable, and
  // it fails at read time, one row at a time, long after the deploy.
  return { current, accepted };
}

/** Minor units, parsed from a STRING and never a JSON number — the same rule
 *  as everywhere else money is read from the outside world. */
function minorUnits(env: Env, key: string): bigint | undefined {
  const raw = optional(env, key);
  if (raw === undefined) return undefined;
  if (!/^[0-9]+$/.test(raw)) {
    throw new ConfigError(`${key} must be a whole number of minor units, got '${raw}'`);
  }
  const value = BigInt(raw);
  if (value <= 0n) throw new ConfigError(`${key} must be greater than zero`);
  return value;
}

/** Like `integer()`, but absent means absent rather than a default — the
 *  caller needs to tell "unset" from "set to the default". */
function optionalInteger(env: Env, key: string): number | undefined {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new ConfigError(`${key} must be a positive integer, got '${raw}'`);
  }
  return value;
}

function optionalWholeNumber(env: Env, key: string): number | undefined {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new ConfigError(`${key} must be a whole number of seconds, got '${raw}'`);
  }
  return value;
}

/**
 * A boolean that must be spelled out.
 *
 * Anything other than the exact string 'true' is false, including 'yes', '1'
 * and 'TRUE'. A permissive parser here would let a typo in a deployment
 * variable enable the highest-fraud surface in the product, and the failure
 * would be silent in the safe direction only by luck.
 */
function flag(env: Env, key: string): boolean {
  return env[key] === 'true';
}

/** Refuses anything not in the union rather than falling back, because a typo
 *  here reads every deposit amount wrong. */
function ngnAmountUnit(env: Env): NgnAmountUnit {
  const raw = optional(env, 'BITNOB_NGN_AMOUNT_UNIT');
  if (raw === undefined) return 'kobo';
  if (raw !== 'kobo' && raw !== 'naira' && raw !== 'micro') {
    throw new ConfigError(
      `BITNOB_NGN_AMOUNT_UNIT must be 'kobo', 'naira' or 'micro', got '${raw}'`,
    );
  }
  return raw;
}

function optional(env: Env, key: string): string | undefined {
  const value = env[key];
  return value === undefined || value.trim() === '' ? undefined : value;
}

export function loadConfig(env: Env): ApiConfig {
  const accessTokenTtlSeconds = integer(env, 'ACCESS_TOKEN_TTL_SECONDS', ACCESS_TOKEN_TTL_SECONDS);

  // An access token cannot be revoked mid-life, so this value IS the window a
  // stolen one keeps working. The ceiling is here so raising it is a decision
  // somebody has to make deliberately, in a diff, rather than by nudging an
  // environment variable during an incident.
  if (accessTokenTtlSeconds > 3600) {
    throw new ConfigError(
      `ACCESS_TOKEN_TTL_SECONDS is ${accessTokenTtlSeconds}; a signed access token cannot be ` +
        `revoked before it expires, so anything above 3600 needs a deliberate change here`,
    );
  }

  return {
    databaseUrl: required(env, 'DATABASE_URL'),
    accessTokenKeyring: parseKeyring(env),
    accessTokenTtlSeconds,
    refreshTokenTtlSeconds: integer(
      env,
      'REFRESH_TOKEN_TTL_SECONDS',
      REFRESH_TOKEN_TTL_SECONDS,
    ),
    loginRateLimit: {
      perIdentifier: {
        max: integer(env, 'LOGIN_RATE_LIMIT_PER_IDENTIFIER', 10),
        windowSeconds: integer(env, 'LOGIN_RATE_LIMIT_WINDOW_SECONDS', 900),
      },
      perIp: {
        max: integer(env, 'LOGIN_RATE_LIMIT_PER_IP', 30),
        windowSeconds: integer(env, 'LOGIN_RATE_LIMIT_WINDOW_SECONDS', 900),
      },
    },
    trustProxyHops: integer(env, 'TRUST_PROXY_HOPS', 1),
    redisUrl: env['REDIS_URL'] === '' ? undefined : env['REDIS_URL'],
    transferFeeBasisPoints: basisPoints(env, 'TRANSFER_FEE_BASIS_POINTS'),
    bitnobBaseUrl: optional(env, 'BITNOB_BASE_URL'),
    bitnobApiKey: optional(env, 'BITNOB_API_KEY'),
    bitnobWebhookSecret: optional(env, 'BITNOB_WEBHOOK_SECRET'),
    encryptionKeyring: parseEncryptionKeyring(env),
    vtpassBaseUrl: optional(env, 'VTPASS_BASE_URL'),
    vtpassApiKey: optional(env, 'VTPASS_API_KEY'),
    vtpassSecretKey: optional(env, 'VTPASS_SECRET_KEY'),
    vtpassPublicKey: optional(env, 'VTPASS_PUBLIC_KEY'),
    airaloBaseUrl: optional(env, 'AIRALO_BASE_URL'),
    airaloClientId: optional(env, 'AIRALO_CLIENT_ID'),
    airaloClientSecret: optional(env, 'AIRALO_CLIENT_SECRET'),
    twilioBaseUrl: optional(env, 'TWILIO_BASE_URL'),
    twilioAccountSid: optional(env, 'TWILIO_ACCOUNT_SID'),
    twilioAuthToken: optional(env, 'TWILIO_AUTH_TOKEN'),
    twilioNumberPriceCents: minorUnits(env, 'TWILIO_NUMBER_PRICE_CENTS'),
    reconcileIntervalSeconds: optionalInteger(env, 'RECONCILE_INTERVAL_SECONDS'),
    // Zero is meaningful here — "sweep with no grace at all" — so this cannot
    // reuse optionalInteger, which treats zero as invalid.
    reconcileGraceSeconds: optionalWholeNumber(env, 'RECONCILE_GRACE_SECONDS'),
    // Zero means "escalate anything still held", which is a legitimate, if
    // very loud, setting — so whole numbers rather than positive ones.
    reconcileStaleSeconds: optionalWholeNumber(env, 'RECONCILE_STALE_SECONDS'),
    giftCardsEnabled: flag(env, 'GIFT_CARDS_ENABLED'),
    giftCardHoldDays: integer(env, 'GIFT_CARD_HOLD_DAYS', 3),
    giftCardReleaseIntervalSeconds: optionalInteger(env, 'GIFTCARD_RELEASE_INTERVAL_SECONDS'),
    bitnobNgnAmountUnit: ngnAmountUnit(env),
    depositCeilingKobo: minorUnits(env, 'DEPOSIT_CEILING_KOBO') ?? 1_000_000_00n,
    depositReconcileIntervalSeconds: optionalInteger(env, 'DEPOSIT_RECONCILE_INTERVAL_SECONDS'),
  };
}
