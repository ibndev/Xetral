import { Inject, Injectable, Logger, Module, ServiceUnavailableException } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import type { DynamicModule, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import Redis from 'ioredis';
import type { Pool } from 'pg';
import { LedgerService } from '@xetral/ledger';
import {
  AiraloAdapter,
  BitnobCardAdapter,
  BitnobClient,
  TwilioAdapter,
  VtpassAdapter,
} from '@xetral/providers';
import type { CardPort, FulfilmentPort, ServiceKind } from '@xetral/providers';
import { AuthController } from './auth/auth.controller.js';
import { AuthGuard } from './auth/auth.guard.js';
import { AuthService } from './auth/auth.service.js';
import { PinService } from './auth/pin.service.js';
import { WalletController } from './wallet/wallet.controller.js';
import { WalletService } from './wallet/wallet.service.js';
import { CardController, CardWebhookController } from './cards/card.controller.js';
import { CardService } from './cards/card.service.js';
import { CardWebhookService } from './cards/webhook.service.js';
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
import {
  DepositWebhookController,
  FundingController,
} from './funding/funding.controller.js';
import { FundingService } from './funding/funding.service.js';
import { DepositWebhookService } from './funding/deposit-webhook.service.js';
import { DepositReconciliationService } from './funding/deposit-reconciliation.service.js';
import { BitnobCryptoAdapter, BitnobFundingAdapter } from '@xetral/providers';
import type { CryptoPort, FundingPort } from '@xetral/providers';
import {
  CryptoController,
  CryptoWebhookController,
} from './crypto/crypto.controller.js';
import { CryptoService } from './crypto/crypto.service.js';
import { CryptoWebhookService } from './crypto/crypto-webhook.service.js';
import { CryptoReconciliationService } from './crypto/crypto-reconciliation.service.js';
import { LoginRateLimitGuard } from './auth/login-rate-limit.guard.js';
import { InMemoryRateLimitStore, RedisRateLimitStore } from './auth/rate-limit.js';
import type { RateLimitStore } from './auth/rate-limit.js';
import { buildRoutePolicy } from './auth/routes.js';
import { createPool } from './database.js';
import type { ApiConfig } from './config.js';
import {
  API_CONFIG,
  CARD_PORT,
  CLOCK,
  DATABASE,
  FULFILMENT_PORTS,
  CRYPTO_PORT,
  FUNDING_PORT,
  LEDGER,
  RATE_LIMIT_STORE,
  ROUTE_POLICY,
  systemClock,
} from './tokens.js';
import type { Clock } from './tokens.js';

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
  /** Overridden in tests so purchases run without live VTpass/Airalo/Twilio. */
  readonly fulfilmentPorts?: ReadonlyMap<ServiceKind, FulfilmentPort>;
  /** Overridden in tests so funding runs without a live Bitnob. */
  readonly fundingPort?: FundingPort;
  /** Overridden in tests so crypto runs without a live Bitnob. */
  readonly cryptoPort?: CryptoPort;
}

/**
 * The card port, or a stand-in that refuses every call.
 *
 * An instance with no Bitnob credentials still serves wallets and auth. Booting
 * with a placeholder key instead would move the failure to the first real card
 * request, where it looks like a provider outage rather than a missing
 * environment variable.
 */
export function createCardPort(config: ApiConfig): CardPort {
  const { bitnobBaseUrl, bitnobApiKey } = config;

  if (bitnobBaseUrl === undefined || bitnobApiKey === undefined) {
    new Logger('Cards').warn(
      'BITNOB_BASE_URL or BITNOB_API_KEY is not set: card routes will refuse requests.',
    );
    return unconfiguredCardPort();
  }

  return new BitnobCardAdapter(new BitnobClient({ baseUrl: bitnobBaseUrl, apiKey: bitnobApiKey }));
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
export function createFundingPort(config: ApiConfig): FundingPort {
  const { bitnobBaseUrl, bitnobApiKey } = config;

  if (bitnobBaseUrl === undefined || bitnobApiKey === undefined) {
    new Logger('Funding').warn(
      'BITNOB_BASE_URL or BITNOB_API_KEY is not set: customers CANNOT be issued account ' +
        'numbers and cannot fund their wallets.',
    );
    const refuse = async (): Promise<never> => {
      throw new ServiceUnavailableException({ error: 'funding_provider_not_configured' });
    };
    return {
      provider: 'bitnob',
      createVirtualAccount: refuse,
      getVirtualAccount: refuse,
      listDeposits: refuse,
    };
  }

  return new BitnobFundingAdapter({
    client: new BitnobClient({ baseUrl: bitnobBaseUrl, apiKey: bitnobApiKey }),
    amountUnit: config.bitnobNgnAmountUnit,
  });
}

/** On-chain assets, or a stand-in that refuses. Same reasoning as the funding
 *  port: one rail, so "not configured" and "unavailable" are the same. */
export function createCryptoPort(config: ApiConfig): CryptoPort {
  const { bitnobBaseUrl, bitnobApiKey } = config;

  if (bitnobBaseUrl === undefined || bitnobApiKey === undefined) {
    new Logger('Crypto').warn(
      'BITNOB_BASE_URL or BITNOB_API_KEY is not set: crypto deposits and withdrawals ' +
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
    };
  }

  return new BitnobCryptoAdapter({
    client: new BitnobClient({ baseUrl: bitnobBaseUrl, apiKey: bitnobApiKey }),
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
  return new RedisRateLimitStore(new Redis(config.redisUrl));
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
    if (this.store instanceof RedisRateLimitStore) await this.store.close();
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
  ) {}

  onApplicationBootstrap(): void {
    this.crypto.start();
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
        CryptoWebhookController,
      ],
      providers: [
        { provide: API_CONFIG, useValue: options.config },
        { provide: CLOCK, useValue: options.clock ?? systemClock },
        { provide: DATABASE, useValue: options.pool ?? createPool(options.config) },
        { provide: ROUTE_POLICY, useValue: buildRoutePolicy() },
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
        {
          provide: CARD_PORT,
          useValue: options.cardPort ?? createCardPort(options.config),
        },
        {
          provide: FULFILMENT_PORTS,
          useValue: options.fulfilmentPorts ?? createFulfilmentPorts(options.config),
        },
        {
          provide: FUNDING_PORT,
          useValue: options.fundingPort ?? createFundingPort(options.config),
        },
        {
          provide: CRYPTO_PORT,
          useValue: options.cryptoPort ?? createCryptoPort(options.config),
        },
        AuthService,
        PinService,
        WalletService,
        CardService,
        CardWebhookService,
        PurchaseService,
        PurchaseOutcome,
        StaffService,
        FundingService,
        DepositWebhookService,
        CryptoService,
        CryptoWebhookService,
        CryptoReconciliationService,
        CryptoLifecycle,
        DepositReconciliationService,
        DepositLifecycle,
        GiftCardService,
        GiftCardHoldService,
        ReconciliationService,
        ReconciliationLifecycle,
        GiftCardLifecycle,
        LoginRateLimitGuard,

        // Registered globally, so it runs for every route including one whose
        // author never thought about authorisation. That is the whole point of
        // deny by default: the guard cannot be forgotten, only satisfied.
        { provide: APP_GUARD, useClass: AuthGuard },
      ],
    };
  }
}
