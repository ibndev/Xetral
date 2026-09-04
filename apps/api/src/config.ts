import { Buffer } from 'node:buffer';
import type { AccessTokenKey, AccessTokenKeyring, BlindIndexKey, EncryptionKey, Keyring } from '@xetral/identity';
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

/**
 * Which deployment this is.
 *
 * REQUIRED, with no default, and the reason is the direction the failure runs
 * in. A staging instance that fell back to `production` would simply be
 * strict, which is survivable; a production instance that fell back to
 * `staging` would relax the guards protecting real customers. Neither default
 * is safe enough to be worth having, so there is none.
 */
export type Environment = 'production' | 'staging' | 'development';

export interface ApiConfig {
  readonly environment: Environment;
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
  /** The BARE HOST — `https://api.bitnob.com` — for sandbox and production
   *  alike. The v2 paths carry their own `/api` prefix, so a base URL still
   *  ending in `/api/v1` turns every request into `/api/v1/api/cards`. The
   *  endpoint table is relative to
   *  it, so omitting `/api/v1` produces 404s on every card call. */
  readonly bitnobBaseUrl: string | undefined;
  /**
   * Identifies the caller, and travels in every request. Not secret.
   *
   * Two values rather than one because Bitnob v2 signs rather than bearers —
   * see `packages/providers/src/bitnob/signing.ts`. The old `BITNOB_API_KEY`
   * cannot be reused as either: it is neither an id their API recognises nor
   * a secret it can verify against.
   */
  readonly bitnobClientId: string | undefined;
  /** Signs every request, and is never transmitted. */
  readonly bitnobClientSecret: string | undefined;
  readonly bitnobWebhookSecret: string | undefined;
  /**
   * Paystack, the DEFAULT naira funding rail.
   *
   * ONE credential, not two: the secret key both authorises requests and
   * verifies webhooks, because Paystack signs an inbound event with the same
   * key it authenticates an outbound call with. Bitnob has a separate webhook
   * secret; adding a matching slot here would be a box nothing reads.
   *
   * `sk_test_` or `sk_live_` — and which one decides whether the money is
   * real, the same way a Bitnob client secret does.
   */
  readonly paystackSecretKey: string | undefined;
  /** Bare host: `https://api.paystack.co`. */
  readonly paystackBaseUrl: string | undefined;
  /**
   * Which bank Paystack issues the NUBAN at — `wema-bank` live, `titan-bank`
   * in test. Undefined lets Paystack choose, which is what their API does
   * with no preference. A value the integration is not enabled for is refused
   * at the moment a customer asks for an account, so it is worth setting
   * deliberately rather than defaulting to a guess.
   */
  readonly paystackPreferredBank: string | undefined;

  /**
   * The bearer token a metrics scraper must present.
   *
   * UNDEFINED MEANS THE ENDPOINT DOES NOT EXIST, rather than meaning it is
   * open. `/metrics` publishes queue depths, provider health and what the
   * platform owes customers — a business-intelligence leak to anything that
   * can route to the instance, and worse: a non-zero `ledger_drift` published
   * openly tells somebody the books are inconsistent before we have noticed.
   *
   * Defaulting to open is the failure that would never be found, because an
   * endpoint that works is an endpoint nobody checks the guard on.
   */
  readonly metricsToken: string | undefined;

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

  /**
   * The key that fingerprints a BVN so two accounts cannot be opened on one.
   *
   * SEPARATE FROM THE ENVELOPE KEYRING, and that is not tidiness. A blind
   * index cannot have two live keys the way the keyring can — matching
   * requires exactly one — so its lifecycle is different: rotating it means
   * recomputing every fingerprint, and until that finishes the uniqueness rule
   * cannot see across the boundary. Tying it to a key that rotates for
   * unrelated reasons would break the control silently, at whatever moment
   * somebody rotated the other thing.
   *
   * Optional as config and REQUIRED by the route that writes one, exactly like
   * the keyring. A submission cannot exist without a sealed BVN, and it now
   * cannot exist without a fingerprint either — so there is no state in which
   * this is absent and identity review quietly stops catching duplicates.
   */
  readonly kycBlindIndexKey: BlindIndexKey | undefined;

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
  /**
   * How often to resolve a bank payout the provider never answered for.
   *
   * ITS ABSENCE IS WHY A CUSTOMER'S MONEY SAT IN `customer_pending`. Every
   * other held-money flow has a sweep; payouts did not, so a timed-out
   * transfer stayed `reserved` for ever with the balance down and nothing
   * arriving. On exactly one instance.
   */
  readonly payoutReconcileIntervalSeconds: number | undefined;
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

  /**
   * How many confirmations an on-chain deposit needs before it is spendable.
   *
   * A FUNCTION rather than a number, because the answer differs per chain by
   * roughly two orders of magnitude: a Bitcoin block is ten minutes and three
   * of them is an hour, while a Tron block is three seconds and twenty of them
   * is a minute. One global number would either make Bitcoin deposits
   * unusable or make Tron deposits unsafe.
   *
   * The value is stored on each deposit row when it is first seen, so raising
   * the threshold later cannot retroactively un-confirm money already
   * credited.
   */
  readonly confirmationsFor: (asset: string, network: string) => number;
  /** How often withdrawals with an unknown outcome are re-checked. One
   *  instance, same arrangement as the other sweeps. */
  readonly cryptoReconcileIntervalSeconds: number | undefined;
  /** How often addresses are re-checked for deposits whose webhook never
   *  arrived. One instance, same arrangement as the other sweeps. */
  readonly cryptoDepositReconcileIntervalSeconds: number | undefined;

  /**
   * Email. Optional as a set, and its absence disables PASSWORD RESET
   * entirely — there is no other way to prove control of an address.
   *
   * `notificationFrom` must be an address on a domain whose SPF, DKIM and
   * DMARC records name the provider. Security mail from an unauthenticated
   * domain lands in spam, which is indistinguishable from not sending it.
   */
  /**
   * The ceiling on password reset requests.
   *
   * Deliberately much tighter than the login limit, and for a different
   * reason: an accepted request sends an email to somebody who did not ask for
   * it. Without the per-identifier bucket the endpoint is a mail bomb aimed at
   * any address, delivered by our own sending domain.
   */
  /**
   * The ceiling on how fast any route may be called.
   *
   * One window, five maximums, because the classes differ in what a burst
   * COSTS rather than in how a burst should be measured. Zero on a class
   * disables it — which is how liveness stays unmetered.
   */
  /**
   * How often to delete aged data, on exactly one instance.
   *
   * Undefined means never, and unlike the other workers that is not dangerous
   * — nothing is lost, data simply accumulates. It is still wrong: the NDPA
   * does not permit keeping personal data indefinitely.
   */
  readonly retentionIntervalSeconds: number | undefined;

  /**
   * How often to compare provider balances against the ledger, on exactly one
   * instance. Undefined means nothing does — and a transaction-level sweep
   * cannot see money that was never a transaction here.
   */
  readonly balanceReconcileIntervalSeconds: number | undefined;

  /**
   * How often the transaction monitoring rules run. ONE INSTANCE.
   *
   * Absent means no monitoring at all, and that absence is invisible from
   * outside: no request fails, nothing errors, and the compliance queue is
   * simply empty — which looks exactly like a quiet week. Bootstrap says so
   * loudly for that reason.
   */
  readonly riskMonitorIntervalSeconds: number | undefined;

  readonly requestRateLimit: {
    readonly windowSeconds: number;
    readonly publicMax: number;
    readonly readMax: number;
    readonly writeMax: number;
    readonly moneyMax: number;
    readonly staffMax: number;
  };

  readonly passwordResetRateLimit: {
    readonly perIdentifier: RateLimitRule;
    readonly perIp: RateLimitRule;
  };

  readonly resendApiKey: string | undefined;
  readonly notificationFrom: string | undefined;
  readonly notificationReplyTo: string | undefined;
  /**
   * How often queued messages are sent, in seconds.
   *
   * Undefined means this instance sends nothing, and exactly one should — the
   * same arrangement as every other sweep. Bootstrap warns when none does,
   * because the failure is silent in the worst way: rows accumulate, the API
   * answers "check your email", and no email is ever sent.
   */
  readonly notificationIntervalSeconds: number | undefined;

  /**
   * The customer-facing origin, used to build links in email.
   *
   * Required for password reset and validated as an absolute https URL. A
   * reset link is followed by a customer who has already been told to expect
   * it, so a wrong or attacker-supplied origin here is a credential harvester
   * with our branding on it — which is exactly why it is a deployment value
   * and never read from a request header.
   */
  /**
   * The one account that may be granted `admin` at boot, and only while
   * NOBODY holds admin yet.
   *
   * The first grant is the one the dashboard cannot make. Every staff role is
   * granted through `/v1/admin/staff`, which is a staff route, which requires
   * a staff role — so a fresh deployment has an operations dashboard that no
   * living person can open, and the documented way in was a hand-written
   * INSERT against the production database. Handing somebody a psql prompt to
   * finish an install is how a deployment ends up with a psql prompt open.
   *
   * IT FIRES ONLY INTO AN EMPTY ROOM. `grantFirstAdmin()` refuses the moment a
   * live `admin` grant exists anywhere, so leaving this set after the first
   * boot is inert rather than a standing back door: an attacker who could
   * write this variable would already be able to write `DATABASE_URL`.
   *
   * It is a DEPLOYMENT value and there is deliberately no endpoint. A request
   * that could mint the first administrator is a request worth forging.
   *
   * The grant is written to `admin_audit_log` like any other, attributed to
   * the account itself — nobody else exists to attribute it to, and an
   * unattributed privilege is the thing that table exists to prevent.
   */
  readonly adminBootstrapEmail: string | undefined;

  /**
   * The address a PROVIDER can reach this API on, for webhooks.
   *
   * Separate from `appBaseUrl`, which is where a customer's browser goes, and
   * that separation is load-bearing rather than tidy. The web app proxies the
   * API at `/api/x` and forwards only `authorization` and `x-forwarded-for` —
   * so a webhook sent through it arrives with NO `x-bitnob-signature`, and
   * signature verification runs before a single byte is parsed. Every event
   * would answer 401 and every deposit would go unrecorded, which is the
   * failure `006_funding.sql` describes as the one a bank rail cannot
   * otherwise detect.
   *
   * So it is its own value, and it is OPTIONAL: an operator who has not
   * decided how a provider reaches this API gets a dashboard that says so
   * rather than one that shows a URL somebody guessed. The endpoint PATHS are
   * facts about the backend and are shown either way.
   */
  readonly webhookBaseUrl: string | undefined;

  readonly appBaseUrl: string | undefined;
  /**
   * How long a password reset link is good for, in minutes.
   *
   * Short, because it is a bearer token that grants account access, and long
   * enough to survive an email provider queueing it for a few minutes.
   */
  readonly passwordResetTtlMinutes: number;

  /**
   * Where platform failure alerts go, and how often we look.
   *
   * Both absent means failures are recorded and nobody is told — which is a
   * legitimate state for a development box and a serious one in production, so
   * bootstrap says so out loud rather than leaving it to be discovered.
   */
  readonly operationsEmail: string | undefined;
  readonly errorAlertIntervalSeconds: number | undefined;

  /**
   * In STAGING, the only addresses email may be sent to.
   *
   * A staging database is very often restored from a production backup,
   * because that is the only way to test against realistic data. The moment it
   * is, every worker on that box is holding a list of real customers and their
   * real addresses — and the notification worker will happily mail all of them
   * about transfers that never happened. That is not a hypothetical failure
   * mode; it is the classic one, and it reaches people who never consented to
   * hear from a test system.
   *
   * A suffix match rather than exact addresses, so a team can use
   * `@xetral.com` and plus-addressing without maintaining a list. Empty in
   * staging means NOTHING is sent, which is the safe direction.
   *
   * Ignored entirely in production, where restricting delivery would be the
   * bug.
   */
  readonly notificationAllowlist: readonly string[];
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

/**
 * `v1:<base64>` — ONE key, carrying its own version.
 *
 * Not a keyring, deliberately, and not the same parser: a keyring's whole
 * point is that several keys are accepted at once, which is exactly what a
 * blind index cannot do. Sharing `parseEncryptionKeyring` would have made it
 * expressible to configure two, and the second would silently never match
 * anything.
 *
 * At least 32 bytes rather than exactly 32: this keys an HMAC, which takes a
 * key of any length, unlike AES-256 which takes precisely one.
 */
function parseBlindIndexKey(env: Env): BlindIndexKey | undefined {
  const raw = optional(env, 'KYC_BLIND_INDEX_KEY');
  if (raw === undefined) return undefined;

  const separator = raw.indexOf(':');
  if (separator === -1) {
    throw new ConfigError(`KYC_BLIND_INDEX_KEY must look like 'v1:<base64>'`);
  }
  const version = raw.slice(0, separator);
  if (!/^v[0-9]+$/.test(version)) {
    throw new ConfigError(`KYC_BLIND_INDEX_KEY version must look like 'v1', got '${version}'`);
  }
  const key = Buffer.from(raw.slice(separator + 1), 'base64');
  if (key.length < 32) {
    throw new ConfigError(
      `KYC_BLIND_INDEX_KEY must decode to at least 32 bytes, got ${key.length}`,
    );
  }
  return { version, key };
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

/**
 * Confirmation thresholds, per chain, overridable per environment.
 *
 * The defaults are conservative on purpose: the cost of waiting is a customer
 * refreshing a screen, and the cost of being wrong is crediting money a
 * reorganisation later removes, after it has been spent.
 */
function confirmationPolicy(env: Env): (asset: string, network: string) => number {
  const defaults: Record<string, number> = {
    // ~30 minutes. Deep reorganisations on Bitcoin are rare and expensive, but
    // one- and two-block ones happen without anybody attacking anything.
    bitcoin: 3,
    ethereum: 12,
    bsc: 15,
    tron: 20,
  };

  const overrides: Record<string, number> = {};
  for (const network of Object.keys(defaults)) {
    const raw = env[`CRYPTO_CONFIRMATIONS_${network.toUpperCase()}`];
    if (raw === undefined || raw.trim() === '') continue;
    const value = Number(raw);
    if (!Number.isInteger(value) || value <= 0) {
      throw new ConfigError(
        `CRYPTO_CONFIRMATIONS_${network.toUpperCase()} must be a positive integer, got '${raw}'`,
      );
    }
    overrides[network] = value;
  }

  return (_asset, network) => {
    const configured = overrides[network] ?? defaults[network];
    if (configured === undefined) {
      // An unknown chain has no safe default. Refusing beats inventing one for
      // a chain whose reorganisation behaviour nobody here has considered.
      throw new ConfigError(`no confirmation threshold is defined for '${network}'`);
    }
    return configured;
  };
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

  const environment = parseEnvironment(env);

  return {
    environment,
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
    bitnobClientId: optional(env, 'BITNOB_CLIENT_ID'),
    bitnobClientSecret: optional(env, 'BITNOB_CLIENT_SECRET'),
    bitnobWebhookSecret: optional(env, 'BITNOB_WEBHOOK_SECRET'),
    paystackSecretKey: optional(env, 'PAYSTACK_SECRET_KEY'),
    paystackBaseUrl: optional(env, 'PAYSTACK_BASE_URL') ?? 'https://api.paystack.co',
    paystackPreferredBank: optional(env, 'PAYSTACK_PREFERRED_BANK'),
    metricsToken: optional(env, 'METRICS_TOKEN'),
    encryptionKeyring: parseEncryptionKeyring(env),
    kycBlindIndexKey: parseBlindIndexKey(env),
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
    payoutReconcileIntervalSeconds: optionalInteger(env, 'PAYOUT_RECONCILE_INTERVAL_SECONDS'),
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
    confirmationsFor: confirmationPolicy(env),
    cryptoReconcileIntervalSeconds: optionalInteger(env, 'CRYPTO_RECONCILE_INTERVAL_SECONDS'),
    cryptoDepositReconcileIntervalSeconds: optionalInteger(
      env,
      'CRYPTO_DEPOSIT_RECONCILE_INTERVAL_SECONDS',
    ),
    retentionIntervalSeconds: optionalInteger(env, 'RETENTION_INTERVAL_SECONDS'),
    balanceReconcileIntervalSeconds: optionalInteger(env, 'BALANCE_RECONCILE_INTERVAL_SECONDS'),
    riskMonitorIntervalSeconds: optionalInteger(env, 'RISK_MONITOR_INTERVAL_SECONDS'),
    requestRateLimit: {
      windowSeconds: integer(env, 'REQUEST_RATE_LIMIT_WINDOW_SECONDS', 60),
      // Generous, because an unauthenticated request has only an address to
      // key on and Nigerian mobile traffic shares addresses across a whole
      // carrier. The tight ceilings on these routes are the per-identifier
      // buckets in login-rate-limit.guard.ts, which NAT does not blur.
      publicMax: integer(env, 'REQUEST_RATE_LIMIT_PUBLIC', 120),
      // A screen opening fires several reads at once, and a customer pulling
      // to refresh does it again. Loose enough not to be felt by anybody using
      // the app, tight enough that harvesting an account takes hours.
      readMax: integer(env, 'REQUEST_RATE_LIMIT_READ', 120),
      writeMax: integer(env, 'REQUEST_RATE_LIMIT_WRITE', 30),
      // A customer sending twelve transfers in a minute is doing something
      // they will remember; a stolen session emptying an account does exactly
      // this. Deliberately the tightest class.
      moneyMax: integer(env, 'REQUEST_RATE_LIMIT_MONEY', 12),
      // Higher than a customer's, because a reviewer working a queue is a
      // person clicking as fast as they can read, and refusing them mid-queue
      // is how a backlog becomes a shared login.
      staffMax: integer(env, 'REQUEST_RATE_LIMIT_STAFF', 90),
    },
    passwordResetRateLimit: {
      // Three per hour per address. Enough for a customer whose first email
      // went to spam to try again twice; not enough to be a weapon.
      perIdentifier: {
        max: integer(env, 'PASSWORD_RESET_RATE_LIMIT_PER_IDENTIFIER', 3),
        windowSeconds: integer(env, 'PASSWORD_RESET_RATE_LIMIT_WINDOW_SECONDS', 3600),
      },
      perIp: {
        max: integer(env, 'PASSWORD_RESET_RATE_LIMIT_PER_IP', 15),
        windowSeconds: integer(env, 'PASSWORD_RESET_RATE_LIMIT_WINDOW_SECONDS', 3600),
      },
    },
    resendApiKey: optional(env, 'RESEND_API_KEY'),
    notificationFrom: optional(env, 'NOTIFICATION_FROM'),
    notificationReplyTo: optional(env, 'NOTIFICATION_REPLY_TO'),
    notificationIntervalSeconds: optionalInteger(env, 'NOTIFICATION_INTERVAL_SECONDS'),
    appBaseUrl: appBaseUrl(env),
    adminBootstrapEmail: adminBootstrapEmail(env),
    webhookBaseUrl: webhookBaseUrl(env),
    passwordResetTtlMinutes: integer(env, 'PASSWORD_RESET_TTL_MINUTES', 30),
    operationsEmail: optional(env, 'OPERATIONS_EMAIL'),
    errorAlertIntervalSeconds: optionalInteger(env, 'ERROR_ALERT_INTERVAL_SECONDS'),
    notificationAllowlist: parseAllowlist(env),
  };
}

/**
 * Which deployment this is, and what that FORBIDS.
 *
 * The guards below are the whole point of naming the environment. A staging
 * environment whose only protection is "we set different variables" is one
 * variable away from test traffic moving real money — and the person who makes
 * that mistake will be copying a production `.env` to get a box working
 * quickly, which is exactly when nobody is reading carefully.
 *
 * So staging REFUSES TO BOOT pointed at a live provider. Failing at startup is
 * loud and costs a deploy; failing on the first card issue costs a real
 * customer's money and looks like a bug in staging.
 */
function parseEnvironment(env: Env): Environment {
  const raw = required(env, 'XETRAL_ENVIRONMENT').trim().toLowerCase();
  if (raw !== 'production' && raw !== 'staging' && raw !== 'development') {
    throw new ConfigError(
      `XETRAL_ENVIRONMENT must be production, staging or development, got '${raw}'`,
    );
  }

  if (raw === 'staging') assertProviderSandbox(env);
  return raw;
}

/**
 * A provider that is not a sandbox is the one thing staging must not have.
 *
 * BITNOB CAN NO LONGER BE CHECKED THIS WAY, and finding that out is the
 * reason this function is shaped as it is.
 *
 * The rule used to be one sentence: match on the URL rather than on a flag
 * somebody sets alongside it, because the flag and the URL can disagree and
 * the URL is the thing that actually carries the request. That was right for
 * Bitnob v1, whose two hosts were `api.bitnob.co` and `sandboxapi.bitnob.co`,
 * and it is still right for VTpass.
 *
 * Bitnob v2 serves sandbox and production from ONE host,
 * `https://api.bitnob.com`. Their own docs: "There is no environment header
 * and no separate host... The secret you sign with selects the environment."
 * So the URL carries no information about which money is real, and the old
 * check has two failure modes at once — it can never pass with a correct base
 * URL, so staging simply refuses to boot; and if somebody satisfied it by
 * putting the word "sandbox" in the URL somewhere, it would pass while
 * pointing at production.
 *
 * A CHECK THAT CANNOT SEE THE THING IT GUARDS IS WORSE THAN NO CHECK, because
 * it is trusted. The environment is a property of the SECRET now, so the
 * guard moved to where the secret is used: `BitnobClient` asks
 * `GET /api/whoami` once, before its first money-moving call, and refuses
 * when a staging deployment is signing with a live secret.
 *
 * That is deliberately not done here. This function runs at boot with no
 * network and no database, and a boot-time provider call would be a new way
 * for the API to fail to start — the reason `/v1/admin/readiness` reports
 * rather than refuses. Asking at the first use costs one round trip on one
 * request and cannot be skipped.
 *
 * An UNSET provider is fine — an instance with no card configuration serves
 * everything else and refuses those routes. It is a SET, live one that is
 * refused.
 */
function assertProviderSandbox(env: Env): void {
  const live: string[] = [];

  /*
   * Still refused: a base URL from the v1 era.
   *
   * Not a sandbox test — it cannot be one any more — but a shape test. Every
   * v2 path carries its own `/api` prefix, so a base URL ending in `/api/v1`
   * produces `/api/v1/api/cards` and 404s everything, and a `bitnob.co` host
   * is the retired API. Both are what a copied v1 configuration looks like,
   * and on staging that means the deployment has not been reviewed since the
   * credential model changed.
   */
  const bitnob = optional(env, 'BITNOB_BASE_URL');
  if (bitnob !== undefined && (/\/api\/v[0-9]/.test(bitnob) || /bitnob\.co(\/|$)/i.test(bitnob))) {
    live.push(
      `BITNOB_BASE_URL=${bitnob} (this is a v1 address; v2 is https://api.bitnob.com ` +
        `with no version segment, and the environment comes from BITNOB_CLIENT_SECRET)`,
    );
  }

  const vtpass = optional(env, 'VTPASS_BASE_URL');
  if (vtpass !== undefined && !/sandbox/i.test(vtpass)) {
    live.push(`VTPASS_BASE_URL=${vtpass}`);
  }

  if (live.length > 0) {
    throw new ConfigError(
      `XETRAL_ENVIRONMENT is 'staging' but these are wrong or point at a LIVE ` +
        `provider: ${live.join(', ')}. A staging instance that can reach ` +
        `production providers can spend real money and issue real cards. Use ` +
        `the sandbox hosts and a sandbox client secret, or set ` +
        `XETRAL_ENVIRONMENT=production if this is production.`,
    );
  }
}

/**
 * Who staging is allowed to email.
 *
 * Deliberately NOT defaulted to something permissive. In staging an unset
 * allowlist means nothing is sent, because the alternative — a staging box
 * restored from a production backup mailing every real customer — is the
 * failure this exists to prevent, and it is not one an operator gets to make
 * by omission.
 */
function parseAllowlist(env: Env): readonly string[] {
  const raw = optional(env, 'NOTIFICATION_ALLOWLIST');
  if (raw === undefined) return [];
  return raw
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry !== '');
}

/**
 * The origin reset links are built from.
 *
 * Validated rather than passed through. A reset link is followed by a customer
 * who has been told to expect it, so a malformed or non-https origin here
 * produces a link that either does not work or is interceptable — and both
 * failures land on the one flow a locked-out customer has left.
 *
 * `http://localhost` is allowed because development has no certificate;
 * nothing else non-https is.
 */
function appBaseUrl(env: Env): string | undefined {
  const raw = optional(env, 'APP_BASE_URL');
  if (raw === undefined) return undefined;

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError(`APP_BASE_URL must be an absolute URL, got '${raw}'`);
  }
  const isLocal = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !isLocal) {
    throw new ConfigError(
      `APP_BASE_URL must be https (got '${url.protocol}'); password reset links are ` +
        `bearer tokens and must not travel over plaintext`,
    );
  }
  // Normalised without a trailing slash so link building is a plain
  // concatenation everywhere rather than each caller guessing.
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

/**
 * The address that may become the first administrator.
 *
 * Normalised and shape-checked here rather than at the point of use, so a
 * typo is a refusal to boot with the variable named — not a bootstrap that
 * silently matches nobody and an operator staring at a dashboard that will
 * not open. That failure would be indistinguishable from "the feature does
 * not work", which is the worst way for an install step to fail.
 *
 * Lowercased because `users.email` is stored lowercased, and an address that
 * differs only in case is the same address to every person who types it.
 */
function adminBootstrapEmail(env: Env): string | undefined {
  const raw = optional(env, 'ADMIN_BOOTSTRAP_EMAIL');
  if (raw === undefined) return undefined;

  const email = raw.trim().toLowerCase();
  // Deliberately not a full RFC 5322 grammar: this only has to catch a value
  // that could never match a registered account, which is what a typo is.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new ConfigError(
      `ADMIN_BOOTSTRAP_EMAIL must be an email address, got '${raw}'. It names the ` +
        `account that becomes the first administrator, so a value matching no account ` +
        `would leave the dashboard permanently closed with nothing reporting why.`,
    );
  }
  return email;
}

/**
 * Where a provider can reach this API.
 *
 * Validated as an absolute https origin and normalised without a trailing
 * slash, so building an endpoint is a concatenation rather than each caller
 * guessing. `http://localhost` is allowed for development, where there is no
 * certificate and no provider either.
 */
function webhookBaseUrl(env: Env): string | undefined {
  const raw = optional(env, 'WEBHOOK_BASE_URL');
  if (raw === undefined) return undefined;

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError(`WEBHOOK_BASE_URL must be an absolute URL, got '${raw}'`);
  }
  const isLocal = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !isLocal) {
    throw new ConfigError(
      `WEBHOOK_BASE_URL must be https (got '${url.protocol}'). A webhook carries a ` +
        `signed statement that money arrived; it must not travel over plaintext.`,
    );
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}
