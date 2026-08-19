import { HttpException, HttpStatus, Inject, Injectable } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { API_CONFIG, CLOCK, RATE_LIMIT_STORE } from '../tokens.js';
import type { Clock } from '../tokens.js';
import type { ApiConfig } from '../config.js';
import type { RateLimitStore } from './rate-limit.js';

/**
 * Applied to the login route only.
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
    const request = context.switchToHttp().getRequest<Request>();
    const now = this.clock.nowMs();
    const { perIdentifier, perIp } = this.config.loginRateLimit;

    // Express resolves req.ip through the trust-proxy setting configured in
    // main.ts. If that setting is wrong this value is attacker-controlled, which
    // is why the hop count is explicit configuration rather than `true`.
    const ip = request.ip ?? request.socket.remoteAddress ?? 'unknown';

    const body: unknown = request.body;
    const identifier =
      typeof body === 'object' && body !== null && 'identifier' in body
        ? (body as { identifier?: unknown }).identifier
        : undefined;

    const decisions = [await this.store.hit(`ip:${ip}`, perIp.max, perIp.windowSeconds, now)];

    // A malformed body has no identifier to key on. The per-IP bucket still
    // applies, so a flood of junk payloads is not a way around the limit.
    if (typeof identifier === 'string' && identifier.trim() !== '') {
      decisions.push(
        await this.store.hit(
          `id:${identifier.trim().toLowerCase()}`,
          perIdentifier.max,
          perIdentifier.windowSeconds,
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
}
