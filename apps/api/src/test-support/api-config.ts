import { randomBytes } from 'node:crypto';
import type { ApiConfig } from '../config.js';

/**
 * One ApiConfig fixture, shared by every e2e suite.
 *
 * It was three copies until a new required field broke all three at once, and
 * that is the mild version of the failure. The bad version is a suite that
 * quietly keeps its own idea of what the config contains: adding a field with a
 * security meaning — an encryption keyring, a fee, a TTL — and having one suite
 * still exercise the old shape means the tests agree with each other and not
 * with production.
 */
export function testApiConfig(databaseUrl: string, overrides: Partial<ApiConfig> = {}): ApiConfig {
  const signing = { version: 'v1', secret: randomBytes(32) };
  const sealing = { version: 'v1', key: randomBytes(32) };

  return {
    databaseUrl,
    accessTokenKeyring: { current: signing, accepted: [signing] },
    accessTokenTtlSeconds: 900,
    refreshTokenTtlSeconds: 2_592_000,
    loginRateLimit: {
      // Deliberately high by default so the flow tests are not throttled by
      // each other. A suite testing the limiter builds its own app with real
      // limits.
      perIdentifier: { max: 1000, windowSeconds: 900 },
      perIp: { max: 1000, windowSeconds: 900 },
    },
    trustProxyHops: 0,
    // The suites pin the in-process limiter: each app instance then gets its
    // own bucket, so rate-limit cases cannot leak into flow cases.
    // RedisRateLimitStore is held to the same contract elsewhere.
    redisUrl: undefined,
    transferFeeBasisPoints: 0,
    bitnobBaseUrl: undefined,
    bitnobApiKey: undefined,
    bitnobWebhookSecret: undefined,
    // A real keyring, not undefined: a suite that never seals anything cannot
    // catch a sealing path that was silently skipped.
    encryptionKeyring: { current: sealing, accepted: [sealing] },
    vtpassBaseUrl: undefined,
    vtpassApiKey: undefined,
    vtpassSecretKey: undefined,
    vtpassPublicKey: undefined,
    airaloBaseUrl: undefined,
    airaloClientId: undefined,
    airaloClientSecret: undefined,
    twilioBaseUrl: undefined,
    twilioAccountSid: undefined,
    twilioAuthToken: undefined,
    twilioNumberPriceCents: undefined,
    ...overrides,
  };
}
