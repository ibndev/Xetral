import { Inject, Injectable, Logger, Module, ServiceUnavailableException } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import type { DynamicModule, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import Redis from 'ioredis';
import type { Pool } from 'pg';
import { LedgerService } from '@xetral/ledger';
import {
  AiraloAdapter,
  BitnobBalanceAdapter,
  BitnobCardAdapter,
  BitnobClient,
  type BitnobCredential,
  PaystackClient,
  PaystackFundingAdapter,
  PaystackPayoutAdapter,
  BitnobPayoutAdapter,
  TwilioAdapter,
  VtpassAdapter,
} from '@xetral/providers';
import type {
  CardPort,
  FulfilmentPort,
  ProviderBalancePort,
  ServiceKind,
} from '@xetral/providers';
import { AuthController } from './auth/auth.controller.js';
import { AuthGuard } from './auth/auth.guard.js';
import { AuthService } from './auth/auth.service.js';
import { SignInEventService } from './auth/sign-in-events.service.js';
import { PinService } from './auth/pin.service.js';
import { PasswordResetService } from './auth/password-reset.service.js';
import { WalletController } from './wallet/wallet.controller.js';
import { WalletService } from './wallet/wallet.service.js';
import { SpendingLimitService } from './wallet/spending-limits.service.js';
import { CardController, CardWebhookController } from './cards/card.controller.js';
import { CardService } from './cards/card.service.js';
import { CardWebhookService } from './cards/webhook.service.js';
import { CardProtectionService } from './cards/card-protection.service.js';
import { AffordabilityService } from './wallet/affordability.service.js';
import { KycGateService } from './kyc/kyc-gate.service.js';
import { AccountSecurityService } from './auth/account-security.service.js';
import { PurchaseController } from './purchases/purchase.controller.js';
import { PurchaseService } from './purchases/purchase.service.js';
import { PurchaseOutcome } from './purchases/purchase-outcome.js';
import { ReconciliationService } from './purchases/reconciliation.service.js';
import {
  GiftCardController,
  GiftCardReviewController,
} from './giftcards/giftcard.controller.js';
import { GiftCardService } from './giftcards/giftcard.service.js';
import { GiftCardHoldService } from './giftcards/hold-release.service.js';
import { StaffService } from './auth/staff.service.js';
import { ProfileService } from './auth/profile.service.js';
import { AdminBootstrapService } from './auth/admin-bootstrap.service.js';
import { StaffTotpService } from './auth/staff-totp.service.js';
import { HealthController } from './health/health.controller.js';
import { SettingsService } from './settings/settings.service.js';
import { TaxService } from './tax/tax.service.js';
import { ConsentService } from './consent/consent.service.js';
import { ConsentController } from './consent/consent.controller.js';
import { DataRightsService } from './datarights/data-rights.service.js';
import { DataRightsController } from './datarights/data-rights.controller.js';
import { PricingService } from './pricing/pricing.service.js';
import { ProviderCredentialService } from './settings/provider-credentials.service.js';
import { AuditService } from './admin/audit.service.js';
import { AdminService } from './admin/admin.service.js';
import { AdminController } from './admin/admin.controller.js';
import { KycController } from './kyc/kyc.controller.js';
import { KycService } from './kyc/kyc.service.js';
import {
  DepositWebhookController,
  FundingController,
} from './funding/funding.controller.js';
import { FundingService } from './funding/funding.service.js';
import { DepositWebhookService } from './funding/deposit-webhook.service.js';
import { DepositReconciliationService } from './funding/deposit-reconciliation.service.js';
import { BitnobCryptoAdapter, BitnobFundingAdapter, BitnobFxAdapter } from '@xetral/providers';
import type { CryptoPort, FundingPort, FxPort, PayoutPort } from '@xetral/providers';
import {
  CryptoController,
  CryptoWebhookController,
} from './crypto/crypto.controller.js';
import { CryptoService } from './crypto/crypto.service.js';
import { PayoutService } from './payouts/payout.service.js';
import { PaystackWebhookService } from './funding/paystack-webhook.service.js';
import { SwitchingFundingPort } from './funding/funding-provider.js';
import { SwitchingPayoutPort } from './payouts/payout-provider.js';
import { PayoutController } from './payouts/payout.controller.js';
import { CryptoWebhookService } from './crypto/crypto-webhook.service.js';
import { CryptoReconciliationService } from './crypto/crypto-reconciliation.service.js';
import { CryptoDepositReconciliationService } from './crypto/crypto-deposit-reconciliation.service.js';
import { FxController } from './fx/fx.controller.js';
import { FxService } from './fx/fx.service.js';
import { NotificationService } from './notifications/notification.service.js';
import { ErrorRecorder } from './observability/error-recorder.service.js';
import { ProviderHealthService, watched } from './observability/provider-health.service.js';
import { ReadinessService } from './golive/readiness.service.js';
import { MetricsService } from './observability/metrics.service.js';
import { MetricsController } from './observability/metrics.controller.js';
import { ErrorRecordingFilter } from './observability/error.filter.js';
import { ErrorAlertService } from './observability/error-alert.service.js';
import { NotificationWorker } from './notifications/notification.worker.js';
import { ResendNotificationAdapter } from '@xetral/providers';
import type { NotificationPort } from '@xetral/providers';
import { LoginRateLimitGuard, PasswordResetRateLimitGuard } from './auth/login-rate-limit.guard.js';
import { RequestRateLimiter } from './auth/request-rate-limit.service.js';
import { AdminDisputeController, DisputeController } from './disputes/dispute.controller.js';
import { DisputeService } from './disputes/dispute.service.js';
import { RetentionService } from './retention/retention.service.js';
import { BalanceReconciliationService } from './reconciliation/balance-reconciliation.service.js';
import { MonitoringService } from './risk/monitoring.service.js';
import { CaseService } from './risk/case.service.js';
import {
  InMemoryRateLimitStore,
  RedisRateLimitStore,
  ResilientRateLimitStore,
} from './auth/rate-limit.js';
import type { RateLimitStore } from './auth/rate-limit.js';
import { buildRoutePolicy } from './auth/routes.js';
import { createPool } from './database.js';
import type { ApiConfig } from './config.js';
import {
  API_CONFIG,
  CARD_PORT,
  CLOCK,
  CRYPTO_PORT,
  PAYOUT_PORT,
  DATABASE,
  FULFILMENT_PORTS,
  FUNDING_PORT,
  FX_PORT,
  LEDGER,
  NOTIFICATION_PORT,
  PROVIDER_BALANCE_PORT,
  RATE_LIMIT_STORE,
  ROUTE_POLICY,
  systemClock,
} from './tokens.js';
import type { Clock } from './tokens.js';
import { AdminCountriesController, CountriesController } from './countries/countries.controller.js';
import { CountriesService } from './countries/countries.service.js';

export interface AppModuleOptions {
  readonly config: ApiConfig;
  /** Overridden in tests to make expiry and rate-limit windows deterministic. */
  readonly clock?: Clock;
  /** Overridden in tests so a suite can share one pool and close it cleanly. */
  readonly pool?: Pool;
  /** Overridden in tests to pin the backend regardless of REDIS_URL. */
  readonly rateLimitStore?: RateLimitStore;
  /** Overridden in tests so card flows run without a live Bitnob. */
  readonly cardPort?: CardPort;
  /** Read-only, and injectable so a suite can drive a known provider figure. */
  readonly providerBalancePort?: ProviderBalancePort;
  /** Overridden in tests so purchases run without live VTpass/Airalo/Twilio. */
  readonly fulfilmentPorts?: ReadonlyMap<ServiceKind, FulfilmentPort>;
  /** Overridden in tests so funding runs without a live Bitnob. */
  readonly fundingPort?: FundingPort;
  /** Overridden in tests so crypto runs without a live Bitnob. */
  readonly cryptoPort?: CryptoPort;
  /** Overridden in tests so bank payouts run without a live Bitnob. */
  readonly payoutPort?: PayoutPort;
  /** Overridden in tests so FX runs without a live Bitnob. */
  readonly fxPort?: FxPort;
  /** Overridden in tests so the outbox can be drained without a live Resend. */
  readonly notificationPort?: NotificationPort;
}

/**
 * The card port, or a stand-in that refuses every call.
 *
 * An instance with no Bitnob credentials still serves wallets and auth. Booting
 * with a placeholder key instead would move the failure to the first real card
 * request, where it looks like a provider outage rather than a missing
 * environment variable.
 */
/**
 * The read-only balance port, or nothing.
 *
 * Returns `undefined` rather than an unconfigured stand-in, and the sweep skips
 * itself when it is absent. A stub that answered "zero" would be worse than no
 * check at all: every float would look like a discrepancy the size of the whole
 * balance, and the queue this exists to fill would be unreadable on day one.
 */
/**
 * HOW A PASTED KEY REACHES BITNOB, which until now it did not.
 *
 * Every port below was built once at module construction from
 * `config.bitnobApiKey` — the environment. `026_provider_credentials.sql`
 * stores a key, hints it, audits it and logs its rotation; the admin screen
 * writes one; `secretFor()` reads one with a five-second cache built for
 * exactly this. Nothing joined the two, so an operator pasted a key, the
 * dashboard showed it as set, and every card, quote, address and account
 * number went on refusing. The migration's own header says the database is
 * authoritative and the environment is the fallback — true of the service and
 * false of every caller.
 *
 * A FUNCTION rather than a string, so the answer is asked for on each call:
 * that is what makes a rotation take effect in five seconds instead of at the
 * next restart, which is the whole reason to be able to replace a key during
 * an incident. `secretFor` already falls back to the environment, so an
 * unchanged deployment behaves exactly as before.
 */
/**
 * The two credentials every Bitnob port needs, resolved PER REQUEST.
 *
 * Two rather than one because v2 signs its requests instead of bearing a
 * token: the id says who is calling, the secret proves it, and the secret
 * never goes over the wire. See `packages/providers/src/bitnob/signing.ts`.
 *
 * `BITNOB_API_KEY` is deliberately not consulted as a fallback for either. A
 * v1 key is not an id their API recognises and not a secret it can verify
 * against, so accepting it here would turn "you are still on the old
 * credential" into "your credential is wrong" — which is exactly the
 * misdiagnosis this whole change is correcting.
 */
/**
 * Paystack's secret key, resolved PER REQUEST.
 *
 * One value, not two: it both authorises calls and verifies webhooks, because
 * Paystack signs an inbound event with the same key it authenticates an
 * outbound call with. A separate webhook slot would be a box an operator
 * fills with a value nothing reads.
 */
export function paystackSecretKey(
  config: ApiConfig,
  credentials?: ProviderCredentialService,
): string | (() => Promise<string | undefined>) {
  if (credentials === undefined) return config.paystackSecretKey ?? '';
  return () => credentials.secretFor('paystack', 'secret_key', config.paystackSecretKey);
}

export function bitnobCredentials(
  config: ApiConfig,
  credentials?: ProviderCredentialService,
): {
  clientId: BitnobCredential;
  clientSecret: BitnobCredential;
  requireSandbox: boolean;
} {
  /*
   * On staging, the client refuses a LIVE Bitnob account before its first
   * money-moving call. This used to be a substring test on BITNOB_BASE_URL
   * and cannot be any more: v2 serves sandbox and production from one host
   * and the SECRET selects the environment, so the URL carries no
   * information about which money is real. See `assertProviderSandbox`.
   */
  const requireSandbox = config.environment === 'staging';
  // No service — the e2e app factories and the unit tests build ports
  // directly. Falls back to the environment, as the credential table's own
  // precedence rule says: the database is authoritative, the environment is
  // the fallback.
  if (credentials === undefined) {
    return {
      clientId: config.bitnobClientId ?? '',
      clientSecret: config.bitnobClientSecret ?? '',
      requireSandbox,
    };
  }
  return {
    clientId: () => credentials.secretFor('bitnob', 'client_id', config.bitnobClientId),
    clientSecret: () =>
      credentials.secretFor('bitnob', 'client_secret', config.bitnobClientSecret),
    requireSandbox,
  };
}

export function createProviderBalancePort(
  config: ApiConfig,
  credentials?: ProviderCredentialService,
): ProviderBalancePort | undefined {
  const { bitnobBaseUrl } = config;
  if (bitnobBaseUrl === undefined) return undefined;

  return new BitnobBalanceAdapter(
    new BitnobClient({
      baseUrl: bitnobBaseUrl,
      ...bitnobCredentials(config, credentials),
    }),
  );
}

export function createCardPort(
  config: ApiConfig,
  credentials?: ProviderCredentialService,
): CardPort {
  const { bitnobBaseUrl } = config;

  /*
   * ONLY THE BASE URL DECIDES THIS NOW, and the key deliberately does not.
   *
   * A missing key used to mean an inert stub for the life of the process — so
   * a deployment that started without one could never be fixed by pasting a
   * key, only by a restart. The address is still required here because there
   * is nothing to call without it and no credential slot supplies one; the
   * key is asked for per request, and `BitnobClient` refuses with a message
   * naming where to put one.
   */
  if (bitnobBaseUrl === undefined) {
    new Logger('Cards').warn(
      'BITNOB_BASE_URL is not set: card routes will refuse requests.',
    );
    return unconfiguredCardPort();
  }

  return new BitnobCardAdapter(
    new BitnobClient({
      baseUrl: bitnobBaseUrl,
      ...bitnobCredentials(config, credentials),
    }),
  );
}

function unconfiguredCardPort(): CardPort {
  const refuse = async (): Promise<never> => {
    throw new ServiceUnavailableException({ error: 'card_provider_not_configured' });
  };
  return {
    issue: refuse,
    fund: refuse,
    freeze: refuse,
    unfreeze: refuse,
    terminate: refuse,
    get: refuse,
    reveal: refuse,
  };
}

/**
 * One adapter per service the instance is configured for — and NO entry for
 * the ones it is not.
 *
 * There is no stand-in that refuses, unlike the card port above, and the
 * difference is deliberate. A card port has one provider, so "not configured"
 * and "this operation is unavailable" are the same statement. Here five
 * services are served by three providers, and a map with a hole in it lets
 * `PurchaseService` answer `service_not_configured` for the one that is
 * missing while the other four work normally. A refusing stand-in would make
 * every service look present until somebody paid for one.
 */
export function createFulfilmentPorts(config: ApiConfig): ReadonlyMap<ServiceKind, FulfilmentPort> {
  const logger = new Logger('Fulfilment');
  const ports = new Map<ServiceKind, FulfilmentPort>();

  const { vtpassBaseUrl, vtpassApiKey, vtpassSecretKey, vtpassPublicKey } = config;
  if (
    vtpassBaseUrl !== undefined &&
    vtpassApiKey !== undefined &&
    vtpassSecretKey !== undefined &&
    vtpassPublicKey !== undefined
  ) {
    // One adapter instance per service rather than one shared: `service` is
    // part of the port's identity, and a caller asking a 'data' port for
    // airtime should not typecheck its way into a wrong VTpass endpoint.
    for (const service of ['airtime', 'data', 'utility'] as const) {
      ports.set(
        service,
        new VtpassAdapter({
          baseUrl: vtpassBaseUrl,
          apiKey: vtpassApiKey,
          secretKey: vtpassSecretKey,
          publicKey: vtpassPublicKey,
          service,
        }),
      );
    }
  } else {
    logger.warn('VTpass is not configured: airtime, data and utility routes will refuse.');
  }

  const { airaloBaseUrl, airaloClientId, airaloClientSecret } = config;
  if (
    airaloBaseUrl !== undefined &&
    airaloClientId !== undefined &&
    airaloClientSecret !== undefined
  ) {
    ports.set(
      'esim',
      new AiraloAdapter({
        baseUrl: airaloBaseUrl,
        clientId: airaloClientId,
        clientSecret: airaloClientSecret,
      }),
    );
  } else {
    logger.warn('Airalo is not configured: eSIM routes will refuse.');
  }

  const { twilioBaseUrl, twilioAccountSid, twilioAuthToken, twilioNumberPriceCents } = config;
  if (
    twilioBaseUrl !== undefined &&
    twilioAccountSid !== undefined &&
    twilioAuthToken !== undefined &&
    twilioNumberPriceCents !== undefined
  ) {
    ports.set(
      'number',
      new TwilioAdapter({
        baseUrl: twilioBaseUrl,
        accountSid: twilioAccountSid,
        authToken: twilioAuthToken,
        priceCents: twilioNumberPriceCents,
      }),
    );
  } else {
    // Credentials without a price is the interesting case: everything needed to
    // buy a number, and nothing saying what to charge for it. Selling at an
    // unset price is worse than not selling.
    logger.warn('Twilio is not configured (or has no price set): number routes will refuse.');
  }

  return ports;
}

/**
 * The bank rail, or a stand-in that refuses.
 *
 * Unlike the fulfilment map, this one gets a refusing stand-in rather than an
 * absent entry: there is exactly one rail, so "not configured" and "funding is
 * unavailable" really are the same statement, and a customer asking for an
 * account number deserves a clear refusal rather than a 500.
 */
/**
 * The naira funding rails, and the switch between them.
 *
 * BOTH are built when their configuration is present, and the SETTING decides
 * which opens the next account — read per call, so switching during a
 * provider incident is one action on the dashboard rather than a release
 * under pressure.
 *
 * Paystack is the default. It opens an account from a name and an email
 * address; Bitnob refuses anybody it has not already verified a BVN for,
 * which is the wrong gate on the screen a customer opens in order to put
 * money in.
 */
export function createFundingPort(
  config: ApiConfig,
  credentials?: ProviderCredentialService,
  settings?: SettingsService,
): FundingPort {
  const adapters = new Map<string, FundingPort>();

  const { paystackBaseUrl } = config;
  if (paystackBaseUrl !== undefined) {
    adapters.set(
      'paystack',
      new PaystackFundingAdapter({
        client: new PaystackClient({
          baseUrl: paystackBaseUrl,
          secretKey: paystackSecretKey(config, credentials),
        }),
        /*
         * FROM THE SETTING, not from the environment — and this was the bug.
         *
         * It used to read `config.paystackPreferredBank` once at
         * construction, while 044 seeds a `paystack_preferred_bank` row, the
         * dashboard offers a box for it and GO-LIVE tells an operator to
         * decide it. Nothing read that row, so filling it changed nothing;
         * and a live integration carrying more than one NUBAN provider
         * refuses a create that names no preferred bank.
         *
         * `settings` is absent on the unit-test and app-factory paths, where
         * the environment is the only source there is.
         */
        preferredBank:
          settings === undefined
            ? config.paystackPreferredBank
            : () => settings.paystackPreferredBank(config.paystackPreferredBank),
      }),
    );
  }

  const { bitnobBaseUrl } = config;
  if (bitnobBaseUrl !== undefined) {
    adapters.set(
      'bitnob',
      new BitnobFundingAdapter({
        client: new BitnobClient({
          baseUrl: bitnobBaseUrl,
          ...bitnobCredentials(config, credentials),
        }),
        amountUnit: config.bitnobNgnAmountUnit,
      }),
    );
  }

  if (adapters.size === 0 || settings === undefined) {
    if (adapters.size === 0) {
      new Logger('Funding').warn(
        'Neither PAYSTACK_BASE_URL nor BITNOB_BASE_URL is set: customers CANNOT ' +
          'be issued account numbers and cannot fund their wallets.',
      );
    }
    // No settings service is the unit-test and app-factory path, where a port
    // is built directly. One adapter and no switch is the honest shape there.
    const only = adapters.values().next();
    if (!only.done) return only.value;

    const refuse = async (): Promise<never> => {
      throw new ServiceUnavailableException({ error: 'funding_provider_not_configured' });
    };
    return {
      provider: 'paystack',
      createVirtualAccount: refuse,
      getVirtualAccount: refuse,
      listDeposits: refuse,
    };
  }

  return new SwitchingFundingPort({
    adapters,
    settings,
    // Paystack unless this deployment has no Paystack configuration at all,
    // in which case falling back to a rail that cannot answer would be worse
    // than falling back to the one that can.
    fallback: adapters.has('paystack') ? 'paystack' : 'bitnob',
  });
}

/** On-chain assets, or a stand-in that refuses. Same reasoning as the funding
 *  port: one rail, so "not configured" and "unavailable" are the same. */
/** Bank payouts, or a stand-in that refuses. Same reasoning as the other
 *  single rails: one provider, so "not configured" and "unavailable" are the
 *  same thing to a customer. */
export function createPayoutPort(
  config: ApiConfig,
  credentials?: ProviderCredentialService,
  settings?: SettingsService,
): PayoutPort {
  const adapters = new Map<string, PayoutPort>();

  /*
   * PAYSTACK FIRST, AND THIS IS THE BUG IT FIXES.
   *
   * There was only ever a Bitnob adapter here, built only when
   * `BITNOB_BASE_URL` is set. Paystack is the default FUNDING rail, so the
   * shipped deployment holds Paystack credentials and no Bitnob ones — and on
   * that deployment every method of this port refused. The Send screen asked
   * for the bank list, got `payout_provider_not_configured`, and told the
   * customer the list could not be loaded. Nothing was broken except that the
   * only adapter that could answer needed a credential nobody had.
   */
  const { paystackBaseUrl } = config;
  if (paystackBaseUrl !== undefined) {
    adapters.set(
      'paystack',
      new PaystackPayoutAdapter({
        client: new PaystackClient({
          baseUrl: paystackBaseUrl,
          secretKey: paystackSecretKey(config, credentials),
        }),
      }),
    );
  }

  const { bitnobBaseUrl } = config;
  if (bitnobBaseUrl !== undefined) {
    adapters.set(
      'bitnob',
      new BitnobPayoutAdapter({
        client: new BitnobClient({
          baseUrl: bitnobBaseUrl,
          ...bitnobCredentials(config, credentials),
        }),
      }),
    );
  }

  if (adapters.size === 0 || settings === undefined) {
    if (adapters.size === 0) {
      new Logger('Payouts').warn(
        'Neither PAYSTACK_BASE_URL nor BITNOB_BASE_URL is set: sending money to a ' +
          'bank will refuse, and the bank list will not load.',
      );
    }
    // No settings service is the unit-test and app-factory path. One adapter
    // and no switch is the honest shape there.
    const only = adapters.values().next();
    if (!only.done) return only.value;

    const refuse = async (): Promise<never> => {
      throw new ServiceUnavailableException({ error: 'payout_provider_not_configured' });
    };
    return {
      provider: 'paystack',
      banks: refuse,
      lookup: refuse,
      send: refuse,
      status: refuse,
    };
  }

  return new SwitchingPayoutPort({ adapters, settings, fallback: 'paystack' });
}

export function createCryptoPort(
  config: ApiConfig,
  credentials?: ProviderCredentialService,
): CryptoPort {
  // Only the address decides this — the key is resolved per request, so a
  // deployment started without one is fixed by pasting a key rather than by
  // a restart. See `bitnobApiKeyResolver`.
  const { bitnobBaseUrl } = config;

  if (bitnobBaseUrl === undefined) {
    new Logger('Crypto').warn(
      'BITNOB_BASE_URL is not set: crypto deposits and withdrawals ' +
        'will refuse.',
    );
    const refuse = async (): Promise<never> => {
      throw new ServiceUnavailableException({ error: 'crypto_provider_not_configured' });
    };
    return {
      provider: 'bitnob',
      createDepositAddress: refuse,
      quoteWithdrawal: refuse,
      send: refuse,
      withdrawalStatus: refuse,
      listDeposits: refuse,
    };
  }

  return new BitnobCryptoAdapter({
    client: new BitnobClient({
      baseUrl: bitnobBaseUrl,
      ...bitnobCredentials(config, credentials),
    }),
  });
}

/** FX, or a stand-in that refuses. Same reasoning as the other single rails. */
export function createFxPort(
  config: ApiConfig,
  credentials?: ProviderCredentialService,
): FxPort {
  // Only the address decides this — the key is resolved per request, so a
  // deployment started without one is fixed by pasting a key rather than by
  // a restart. See `bitnobApiKeyResolver`.
  const { bitnobBaseUrl } = config;

  if (bitnobBaseUrl === undefined) {
    new Logger('Fx').warn('BITNOB_BASE_URL is not set: FX routes will refuse.');
    const refuse = async (): Promise<never> => {
      throw new ServiceUnavailableException({ error: 'fx_provider_not_configured' });
    };
    return { provider: 'bitnob', rate: refuse, convert: refuse };
  }

  return new BitnobFxAdapter({
    client: new BitnobClient({
      baseUrl: bitnobBaseUrl,
      ...bitnobCredentials(config, credentials),
    }),
  });
}

/**
 * The email provider, or nothing at all.
 *
 * `undefined` rather than a refusing stand-in, and the difference matters
 * here. Every other port in this file gets a stand-in that throws
 * `..._not_configured`, because a customer asking for a card deserves a clear
 * refusal. Notifications are not requested by a customer — they are owed to
 * one — so there is no request to refuse. A stand-in that threw would turn
 * every queued receipt into an error in the worker's log and every password
 * reset into a 500 on a route that should have refused at the door instead.
 *
 * Absent means: the outbox still accepts rows, nothing drains them, and the
 * routes that depend on email refuse up front.
 */
export function createNotificationPort(config: ApiConfig): NotificationPort | undefined {
  const { resendApiKey, notificationFrom } = config;
  const logger = new Logger('Notifications');

  if (resendApiKey === undefined || notificationFrom === undefined) {
    logger.warn(
      'RESEND_API_KEY or NOTIFICATION_FROM is not set: NO EMAIL WILL BE SENT. Password ' +
        'reset is unavailable, and customers will not be told when a new device signs ' +
        'into their account.',
    );
    return undefined;
  }

  return new ResendNotificationAdapter({
    apiKey: resendApiKey,
    from: notificationFrom,
    ...(config.notificationReplyTo === undefined
      ? {}
      : { replyTo: config.notificationReplyTo }),
  });
}

/**
 * Chooses the rate-limit backend, and says out loud when it picks the one that
 * only works on a single box.
 *
 * The warning is deliberately loud. An in-process limiter is not visibly
 * different from a shared one until the day a second instance is started, and
 * at that point the limit has silently doubled with nothing in the logs to say
 * so.
 */
export function createRateLimitStore(config: ApiConfig): RateLimitStore {
  const logger = new Logger('RateLimit');

  if (config.redisUrl === undefined) {
    logger.warn(
      'REDIS_URL is not set: login rate limiting is IN-PROCESS. The limit ' +
        'multiplies by the number of instances, so do not run more than one.',
    );
    return new InMemoryRateLimitStore();
  }

  logger.log('login rate limiting is shared through Redis');

  // Wrapped, so a Redis outage degrades to per-instance counting instead of
  // answering 500 to every login. Without the wrapper the limiter throws and
  // takes the request with it: a cache being down locks every customer out of
  // their own money, and knocking over one Redis becomes a denial of service
  // against authentication itself. See ResilientRateLimitStore.
  //
  // `maxRetriesPerRequest` is left at ioredis's default rather than raised:
  // the point is to fail fast to the fallback, not to hold a login open while
  // a dead connection is retried twenty times.
  const redis = new Redis(config.redisUrl);

  // ioredis emits `error` on every failed reconnect. Unhandled, those become
  // unhandled 'error' events on an EventEmitter, which crashes the process —
  // so an outage would take the instance down before the fallback could do
  // anything about it.
  redis.on('error', () => undefined);

  return new ResilientRateLimitStore(new RedisRateLimitStore(redis));
}

/**
 * Closes the Redis connection on shutdown.
 *
 * Lives here rather than as a Nest lifecycle method on the store itself, so
 * `rate-limit.ts` stays a plain port with two adapters and does not import a
 * framework it otherwise has nothing to do with.
 */
@Injectable()
export class RateLimitLifecycle implements OnApplicationShutdown {
  constructor(@Inject(RATE_LIMIT_STORE) private readonly store: RateLimitStore) {}

  async onApplicationShutdown(): Promise<void> {
    // Unwrapped: the resilient store holds the Redis one, and closing has to
    // reach through to the connection or the process hangs on shutdown
    // waiting for a socket nobody owns any more.
    const inner = this.store instanceof ResilientRateLimitStore ? this.store.primary : this.store;
    if (inner instanceof RedisRateLimitStore) await inner.close();
  }
}

/**
 * Starts the reconciliation sweep once the app is up.
 *
 * Lives here for the same reason RateLimitLifecycle does: the service itself
 * stays a plain object with a `sweep()` a test can call, rather than something
 * that starts doing work to money the moment it is constructed. `onApplicationBootstrap`
 * rather than the constructor also means a failed boot never leaves a timer
 * running against a half-built app.
 */
@Injectable()
export class ReconciliationLifecycle implements OnApplicationBootstrap {
  constructor(@Inject(ReconciliationService) private readonly reconciler: ReconciliationService) {}

  onApplicationBootstrap(): void {
    this.reconciler.start();
  }
}

/** Starts the deposit reconciliation sweep — the only thing that notices a
 *  webhook that never arrived. */
@Injectable()
export class DepositLifecycle implements OnApplicationBootstrap {
  constructor(
    @Inject(DepositReconciliationService)
    private readonly deposits: DepositReconciliationService,
  ) {}

  onApplicationBootstrap(): void {
    this.deposits.start();
  }
}

/** Starts the crypto withdrawal reconciliation sweep. */
@Injectable()
export class CryptoLifecycle implements OnApplicationBootstrap {
  constructor(
    @Inject(CryptoReconciliationService)
    private readonly crypto: CryptoReconciliationService,
    @Inject(CryptoDepositReconciliationService)
    private readonly cryptoDeposits: CryptoDepositReconciliationService,
  ) {}

  onApplicationBootstrap(): void {
    this.crypto.start();
    // Deposits as well as withdrawals. Withdrawals had a sweep from the day
    // they shipped and deposits did not, which meant a lost deposit webhook
    // was money on a chain that never reached a balance and nothing would
    // ever notice.
    this.cryptoDeposits.start();
  }
}

/**
 * Starts the outbox worker.
 *
 * Separate from the other lifecycles because it is enabled independently, and
 * because it is the one whose absence is silent in the worst way: rows
 * accumulate, the API keeps answering "check your email", and nothing is ever
 * delivered. The worker says so at boot when nobody has turned it on.
 */
@Injectable()
export class NotificationLifecycle implements OnApplicationBootstrap {
  constructor(@Inject(NotificationWorker) private readonly worker: NotificationWorker) {}

  onApplicationBootstrap(): void {
    this.worker.start();
  }
}

/**
 * Starts the alerter.
 *
 * Separate lifecycle because it is enabled independently — and because an
 * instance that RECORDS failures without telling anybody is a legitimate
 * configuration for all but one box, exactly like the other sweeps.
 */
@Injectable()
export class ErrorAlertLifecycle implements OnApplicationBootstrap {
  constructor(@Inject(ErrorAlertService) private readonly alerts: ErrorAlertService) {}

  onApplicationBootstrap(): void {
    this.alerts.start();
  }
}

/**
 * Starts the balance comparison sweep. Its own lifecycle, like every other:
 * they are enabled independently.
 */
@Injectable()
export class BalanceReconciliationLifecycle implements OnApplicationBootstrap {
  constructor(
    @Inject(BalanceReconciliationService) private readonly balances: BalanceReconciliationService,
  ) {}

  onApplicationBootstrap(): void {
    this.balances.start();
  }
}

/**
 * Starts the transaction monitoring sweep.
 *
 * Its own lifecycle, like every other. This is the one whose absence is
 * hardest to notice — nothing fails, the queue is simply empty — so it must be
 * possible to see that it is off without reading a compose file.
 */
@Injectable()
export class MonitoringLifecycle implements OnApplicationBootstrap {
  constructor(@Inject(MonitoringService) private readonly monitoring: MonitoringService) {}

  onApplicationBootstrap(): void {
    this.monitoring.start();
  }
}

/**
 * Starts the retention sweep.
 *
 * Its own lifecycle rather than sharing one, for the same reason every other
 * sweep has its own: they are enabled independently, and the one whose job is
 * to delete data should be the easiest of all to switch off on its own.
 */
@Injectable()
export class RetentionLifecycle implements OnApplicationBootstrap {
  constructor(@Inject(RetentionService) private readonly retention: RetentionService) {}

  onApplicationBootstrap(): void {
    this.retention.start();
  }
}

/** Starts the gift card hold release sweep. Separate from the reconciliation
 *  lifecycle because the two are enabled independently. */
@Injectable()
export class GiftCardLifecycle implements OnApplicationBootstrap {
  constructor(@Inject(GiftCardHoldService) private readonly holds: GiftCardHoldService) {}

  onApplicationBootstrap(): void {
    this.holds.start();
  }
}

/**
 * Configuration is passed in rather than read from process.env inside the
 * module. A module that reaches for the environment is a module that cannot be
 * instantiated twice with different settings, which makes the rate-limit and
 * expiry behaviour untestable without mutating global state.
 */
@Module({})
export class AppModule {
  static forRoot(options: AppModuleOptions): DynamicModule {
    return {
      module: AppModule,
      controllers: [
        AuthController,
        WalletController,
        CardController,
        CardWebhookController,
        PurchaseController,
        GiftCardController,
        GiftCardReviewController,
        FundingController,
        DepositWebhookController,
        CryptoController,
        PayoutController,
        CryptoWebhookController,
        FxController,
        HealthController,
        MetricsController,
        KycController,
        ConsentController,
        DataRightsController,
        AdminController,
        DisputeController,
        AdminDisputeController,
        CountriesController,
        AdminCountriesController,
      ],
      providers: [
        { provide: API_CONFIG, useValue: options.config },
        { provide: CLOCK, useValue: options.clock ?? systemClock },
        { provide: DATABASE, useValue: options.pool ?? createPool(options.config) },
        { provide: ROUTE_POLICY, useValue: buildRoutePolicy() },
        CountriesService,
        {
          provide: RATE_LIMIT_STORE,
          useValue: options.rateLimitStore ?? createRateLimitStore(options.config),
        },
        RateLimitLifecycle,
        {
          provide: LEDGER,
          useFactory: (pool: Pool) => new LedgerService(pool),
          inject: [DATABASE],
        },
        /*
         * EVERY PORT IS WRAPPED HERE, and this is the only place it happens.
         *
         * `watched()` records whether each provider call succeeded, so the
         * question "is Bitnob down?" has an answer that is not a log grep.
         * Doing it at the injection boundary rather than at call sites means a
         * new flow is watched by construction, and a method added to a port
         * later cannot be silently missed — which is the failure the whole
         * thing exists to prevent.
         *
         * These moved from `useValue` to `useFactory` for one reason: a
         * factory can inject the pool, and health that lives in process memory
         * would be lost on exactly the restart an incident causes.
         */
        {
          provide: CARD_PORT,
          useFactory: (health: ProviderHealthService, credentials: ProviderCredentialService) => {
            const port = options.cardPort ?? createCardPort(options.config, credentials);
            return watched(port, 'bitnob', health);
          },
          inject: [ProviderHealthService, ProviderCredentialService],
        },
        {
          provide: PROVIDER_BALANCE_PORT,
          useFactory: (health: ProviderHealthService, credentials: ProviderCredentialService) => {
            const port =
              options.providerBalancePort ??
              createProviderBalancePort(options.config, credentials);
            // Optional: an instance with no Bitnob credentials has none, and
            // wrapping `undefined` would turn a deliberate absence into a
            // proxy that answers every call.
            return port === undefined ? undefined : watched(port, 'bitnob', health);
          },
          inject: [ProviderHealthService, ProviderCredentialService],
        },
        {
          provide: FULFILMENT_PORTS,
          useFactory: (health: ProviderHealthService, credentials: ProviderCredentialService) => {
            const ports = options.fulfilmentPorts ?? createFulfilmentPorts(options.config);
            // A MAP of three different providers behind one port, so each is
            // watched under its own name: VTpass being down is not Airalo
            // being down, and one health row for all three would say neither.
            return new Map(
              [...ports].map(([kind, port]) => [kind, watched(port, port.provider, health)]),
            );
          },
          inject: [ProviderHealthService, ProviderCredentialService],
        },
        {
          provide: FUNDING_PORT,
          useFactory: (
            health: ProviderHealthService,
            credentials: ProviderCredentialService,
            settings: SettingsService,
          ) =>
            watched(
              options.fundingPort ??
                createFundingPort(options.config, credentials, settings),
              // The rail that actually served is recorded on the account row;
              // this label is what `provider_health` buckets under, and the
              // switch reports its default. A deployment that flips to Bitnob
              // gets its health under 'bitnob' from the adapter's own errors.
              'funding',
              health,
            ),
          inject: [ProviderHealthService, ProviderCredentialService, SettingsService],
        },
        {
          provide: CRYPTO_PORT,
          useFactory: (health: ProviderHealthService, credentials: ProviderCredentialService) =>
            watched(
              options.cryptoPort ?? createCryptoPort(options.config, credentials),
              'bitnob',
              health,
            ),
          inject: [ProviderHealthService, ProviderCredentialService],
        },
        {
          provide: PAYOUT_PORT,
          useFactory: (
            health: ProviderHealthService,
            credentials: ProviderCredentialService,
            settings: SettingsService,
          ) =>
            watched(
              options.payoutPort ?? createPayoutPort(options.config, credentials, settings),
              // The rail that actually sent is recorded on the payout row;
              // this label is what `provider_health` buckets under, and the
              // switch reports its default — the same arrangement funding uses.
              'payouts',
              health,
            ),
          inject: [ProviderHealthService, ProviderCredentialService, SettingsService],
        },
        {
          provide: FX_PORT,
          useFactory: (health: ProviderHealthService, credentials: ProviderCredentialService) =>
            watched(
              options.fxPort ?? createFxPort(options.config, credentials),
              'bitnob',
              health,
            ),
          inject: [ProviderHealthService, ProviderCredentialService],
        },
        {
          provide: NOTIFICATION_PORT,
          useFactory: (health: ProviderHealthService, credentials: ProviderCredentialService) => {
            const port = options.notificationPort ?? createNotificationPort(options.config);
            return port === undefined ? undefined : watched(port, 'resend', health);
          },
          inject: [ProviderHealthService, ProviderCredentialService],
        },
        AuthService,
        SignInEventService,
        PinService,
        WalletService,
        SpendingLimitService,
        CardService,
        CardWebhookService,
        CardProtectionService,
        AffordabilityService,
        KycGateService,
        AccountSecurityService,
        PurchaseService,
        PurchaseOutcome,
        StaffService,
        ProfileService,
        AdminBootstrapService,
        StaffTotpService,
        SettingsService,
        TaxService,
        ConsentService,
        DataRightsService,
        PricingService,
        ProviderCredentialService,
        AuditService,
        AdminService,
        KycService,
        FundingService,
        DepositWebhookService,
        PaystackWebhookService,
        CryptoService,
        PayoutService,
        CryptoWebhookService,
        FxService,
        CryptoReconciliationService,
        CryptoDepositReconciliationService,
        CryptoLifecycle,
        DepositReconciliationService,
        DepositLifecycle,
        ErrorRecorder,
        ProviderHealthService,
        ReadinessService,
        MetricsService,
        ErrorAlertService,
        ErrorAlertLifecycle,
        NotificationService,
        NotificationWorker,
        NotificationLifecycle,
        GiftCardService,
        GiftCardHoldService,
        ReconciliationService,
        ReconciliationLifecycle,
        GiftCardLifecycle,
        LoginRateLimitGuard,
        PasswordResetRateLimitGuard,
        // Injected into AuthGuard rather than registered as a second global
        // guard: it has to run after the bearer check (so it has an account to
        // count against) and before the PIN (so a flood cannot spend scrypt).
        // Guard ordering cannot express "in the middle of that one".
        RequestRateLimiter,
        DisputeService,
        RetentionService,
        RetentionLifecycle,
        BalanceReconciliationService,
        MonitoringService,
        CaseService,
        BalanceReconciliationLifecycle,
        MonitoringLifecycle,
        PasswordResetService,

        // Registered globally, so it runs for every route including one whose
        // author never thought about authorisation. That is the whole point of
        // deny by default: the guard cannot be forgotten, only satisfied.
        { provide: APP_GUARD, useClass: AuthGuard },

        // Registered globally, so no unhandled failure anywhere in the app can
        // avoid being recorded. Same reasoning as the guard: a filter that has
        // to be remembered per controller is one that will be forgotten on the
        // controller that needed it.
        { provide: APP_FILTER, useClass: ErrorRecordingFilter },
      ],
    };
  }
}
