import { Inject, Injectable, Logger, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import type { DynamicModule, OnApplicationShutdown } from '@nestjs/common';
import Redis from 'ioredis';
import type { Pool } from 'pg';
import { AuthController } from './auth/auth.controller.js';
import { AuthGuard } from './auth/auth.guard.js';
import { AuthService } from './auth/auth.service.js';
import { LoginRateLimitGuard } from './auth/login-rate-limit.guard.js';
import { InMemoryRateLimitStore, RedisRateLimitStore } from './auth/rate-limit.js';
import type { RateLimitStore } from './auth/rate-limit.js';
import { buildRoutePolicy } from './auth/routes.js';
import { createPool } from './database.js';
import type { ApiConfig } from './config.js';
import { API_CONFIG, CLOCK, DATABASE, RATE_LIMIT_STORE, ROUTE_POLICY, systemClock } from './tokens.js';
import type { Clock } from './tokens.js';

export interface AppModuleOptions {
  readonly config: ApiConfig;
  /** Overridden in tests to make expiry and rate-limit windows deterministic. */
  readonly clock?: Clock;
  /** Overridden in tests so a suite can share one pool and close it cleanly. */
  readonly pool?: Pool;
  /** Overridden in tests to pin the backend regardless of REDIS_URL. */
  readonly rateLimitStore?: RateLimitStore;
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
      controllers: [AuthController],
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
        AuthService,
        LoginRateLimitGuard,

        // Registered globally, so it runs for every route including one whose
        // author never thought about authorisation. That is the whole point of
        // deny by default: the guard cannot be forgotten, only satisfied.
        { provide: APP_GUARD, useClass: AuthGuard },
      ],
    };
  }
}
