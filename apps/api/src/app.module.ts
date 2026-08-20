import { Inject, Injectable, Logger, Module, ServiceUnavailableException } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import type { DynamicModule, OnApplicationShutdown } from '@nestjs/common';
import Redis from 'ioredis';
import type { Pool } from 'pg';
import { LedgerService } from '@xetral/ledger';
import { BitnobCardAdapter, BitnobClient } from '@xetral/providers';
import type { CardPort } from '@xetral/providers';
import { AuthController } from './auth/auth.controller.js';
import { AuthGuard } from './auth/auth.guard.js';
import { AuthService } from './auth/auth.service.js';
import { PinService } from './auth/pin.service.js';
import { WalletController } from './wallet/wallet.controller.js';
import { WalletService } from './wallet/wallet.service.js';
import { CardController, CardWebhookController } from './cards/card.controller.js';
import { CardService } from './cards/card.service.js';
import { CardWebhookService } from './cards/webhook.service.js';
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
      controllers: [AuthController, WalletController, CardController, CardWebhookController],
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
        AuthService,
        PinService,
        WalletService,
        CardService,
        CardWebhookService,
        LoginRateLimitGuard,

        // Registered globally, so it runs for every route including one whose
        // author never thought about authorisation. That is the whole point of
        // deny by default: the guard cannot be forgotten, only satisfied.
        { provide: APP_GUARD, useClass: AuthGuard },
      ],
    };
  }
}
