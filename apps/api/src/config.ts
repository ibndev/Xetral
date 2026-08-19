import { Buffer } from 'node:buffer';
import type { AccessTokenKey, AccessTokenKeyring } from '@xetral/identity';
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
  };
}
