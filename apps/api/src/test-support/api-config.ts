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
    // No timer in tests: the reconciliation suite drives `sweep()` directly, so
    // a background one would race it and resolve rows out from under it.
    reconcileIntervalSeconds: undefined,
    // No grace either — a test that had to wait two minutes for a row to become
    // eligible is a test nobody runs. Zero rather than undefined, which would
    // fall back to the production default.
    reconcileGraceSeconds: 0,
    reconcileStaleSeconds: undefined,
    // OFF by default here too, so the suite that asserts every gift card route
    // refuses gets the production default rather than a test-only one. The
    // suites that exercise the flow turn it on explicitly.
    giftCardsEnabled: false,
    giftCardHoldDays: 3,
    // The gift card suite drives sweep() directly, so no timer.
    giftCardReleaseIntervalSeconds: undefined,
    bitnobNgnAmountUnit: 'kobo',
    // The production default, so the suites exercise the real ceiling rather
    // than one that never fires.
    depositCeilingKobo: 1_000_000_00n,
    depositReconcileIntervalSeconds: undefined,
    // Low but non-zero, so the two-phase deposit flow is exercised for real
    // rather than short-circuited by a threshold of one.
    confirmationsFor: () => 3,
    cryptoReconcileIntervalSeconds: undefined,
    cryptoDepositReconcileIntervalSeconds: undefined,
    // No email provider by default: the suites that care about notifications
    // assert on the OUTBOX, which is where the guarantee lives. A suite that
    // needed a real send would be testing Resend, not Xetral.
    // High by default so flow suites are not throttled by each other; the
    // suite that tests the limit builds its own app with a real one.
    passwordResetRateLimit: {
      perIdentifier: { max: 1000, windowSeconds: 3600 },
      perIp: { max: 1000, windowSeconds: 3600 },
    },
    resendApiKey: undefined,
    notificationFrom: undefined,
    notificationReplyTo: undefined,
    notificationIntervalSeconds: undefined,
    appBaseUrl: 'https://app.xetral.test',
    passwordResetTtlMinutes: 30,
    operationsEmail: 'ops@xetral.test',
    errorAlertIntervalSeconds: undefined,
    ...overrides,
  };
}
