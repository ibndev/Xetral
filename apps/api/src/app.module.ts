import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import type { DynamicModule } from '@nestjs/common';
import type { Pool } from 'pg';
import { AuthController } from './auth/auth.controller.js';
import { AuthGuard } from './auth/auth.guard.js';
import { AuthService } from './auth/auth.service.js';
import { LoginRateLimitGuard } from './auth/login-rate-limit.guard.js';
import { InMemoryRateLimitStore } from './auth/rate-limit.js';
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
        { provide: RATE_LIMIT_STORE, useClass: InMemoryRateLimitStore },
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
