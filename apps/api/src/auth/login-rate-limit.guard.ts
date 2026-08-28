import { HttpException, HttpStatus, Inject, Injectable } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { API_CONFIG, CLOCK, RATE_LIMIT_STORE } from '../tokens.js';
import type { Clock } from '../tokens.js';
import type { ApiConfig, RateLimitRule } from '../config.js';
import type { RateLimitStore } from './rate-limit.js';

/**
 * The shared body of every credential-endpoint limiter.
 *
 * Written once and parameterised rather than copied per endpoint, for the same
 * reason the two rate-limit BACKENDS share one contract suite: two
 * hand-written copies drift into two behaviours while both keep passing, and
 * the copy that drifts is the one guarding the endpoint nobody thought about.
 *
 * `bucket` is what keeps the endpoints independent. Login and password reset
 * must not share a counter — a customer who mistyped their password three
 * times would otherwise be unable to ask for a reset, which is precisely the
 * moment they need one.
 */
async function enforce(
  context: ExecutionContext,
  store: RateLimitStore,
  clock: Clock,
  bucket: string,
  rules: { readonly perIdentifier: RateLimitRule; readonly perIp: RateLimitRule },
): Promise<boolean> {
  const request = context.switchToHttp().getRequest<Request>();
  const now = clock.nowMs();

  // Express resolves req.ip through the trust-proxy setting configured in
  // main.ts. If that setting is wrong this value is attacker-controlled, which
  // is why the hop count is explicit configuration rather than `true`.
  const ip = request.ip ?? request.socket.remoteAddress ?? 'unknown';

  const body: unknown = request.body;
  const identifier =
    typeof body === 'object' && body !== null && 'identifier' in body
      ? (body as { identifier?: unknown }).identifier
      : undefined;

  const decisions = [
    await store.hit(`${bucket}:ip:${ip}`, rules.perIp.max, rules.perIp.windowSeconds, now),
  ];

  // A malformed body has no identifier to key on. The per-IP bucket still
  // applies, so a flood of junk payloads is not a way around the limit.
  if (typeof identifier === 'string' && identifier.trim() !== '') {
    decisions.push(
      await store.hit(
        `${bucket}:id:${identifier.trim().toLowerCase()}`,
        rules.perIdentifier.max,
        rules.perIdentifier.windowSeconds,
        now,
      ),
    );
  }

  const blocked = decisions.find((d) => !d.allowed);
  if (blocked !== undefined) {
    throw new HttpException(
      { error: 'too_many_attempts', retry_after_seconds: blocked.retryAfterSeconds },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }

  return true;
}

/**
 * Applied to the login and registration routes.
 *
 * Refresh is not rate limited here and does not need to be: rotation makes a
 * refresh token single-use, so replaying one is self-limiting and already
 * revokes the family. Login is the endpoint where guessing is free, so login is
 * where the limit belongs.
 */
@Injectable()
export class LoginRateLimitGuard implements CanActivate {
  constructor(
    @Inject(RATE_LIMIT_STORE) private readonly store: RateLimitStore,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // The bucket name is the historical one, so an in-flight deployment's
    // Redis keys keep counting the same requests across the change.
    return await enforce(context, this.store, this.clock, 'login', this.config.loginRateLimit);
  }
}

/**
 * Applied to `POST /v1/auth/password/forgot`.
 *
 * A TIGHTER limit than login, and for a different reason. Login is limited
 * because guessing is free; this is limited because each accepted request
 * SENDS AN EMAIL TO SOMEBODY ELSE. Without a per-identifier ceiling, the
 * endpoint is a mail bomb aimed at any address an attacker chooses, delivered
 * by our own sending domain — which costs the victim their inbox and costs us
 * the sender reputation that every other security email depends on.
 *
 * The per-identifier bucket is what actually stops that; the per-IP bucket
 * only slows down an attacker with one address.
 */
@Injectable()
export class PasswordResetRateLimitGuard implements CanActivate {
  constructor(
    @Inject(RATE_LIMIT_STORE) private readonly store: RateLimitStore,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    return await enforce(
      context,
      this.store,
      this.clock,
      'password_reset',
      this.config.passwordResetRateLimit,
    );
  }
}
