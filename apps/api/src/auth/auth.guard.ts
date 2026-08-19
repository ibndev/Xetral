import {
  ForbiddenException,
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { type RoutePolicyRegistry, verifyAccessToken } from '@xetral/identity';
import type { AccessTokenClaims } from '@xetral/identity';
import type { Request } from 'express';
import { API_CONFIG, CLOCK, ROUTE_POLICY } from '../tokens.js';
import type { Clock } from '../tokens.js';
import type { ApiConfig } from '../config.js';
import { routeKeyOf } from './route-key.js';

/** The claims a handler can rely on once the guard has allowed the request. */
export interface AuthenticatedRequest extends Request {
  auth?: AccessTokenClaims;
}

/**
 * The global guard. Registered with APP_GUARD, so it runs for every route in
 * the application — including ones whose author forgot it existed, which is
 * the entire point.
 *
 * The reference plugin's arrangement was the inverse: 45 routes declaring
 * `permission_callback => '__return_true'` with the real check inside each
 * handler. That is safe for exactly as long as nobody forgets, and a handler
 * missing its check looks identical to one whose check is three lines further
 * down. Here, a route with no declared policy is refused, so forgetting
 * produces a failing test rather than an open endpoint.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  readonly #logger = new Logger(AuthGuard.name);

  constructor(
    @Inject(ROUTE_POLICY) private readonly policy: RoutePolicyRegistry,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    // Only HTTP is served today. Anything else has not been reasoned about, so
    // it is refused rather than waved through by a default case.
    if (context.getType() !== 'http') {
      throw new ForbiddenException({ error: 'unsupported_transport' });
    }

    const route = routeKeyOf(context);
    if (route === undefined) {
      this.#logger.error(
        'could not identify the route being handled; refusing rather than guessing',
      );
      throw new ForbiddenException({ error: 'route_not_declared' });
    }

    const decision = this.policy.decide(route.method, route.path);

    if (!decision.allow) {
      // Deliberately logged as an error, not a warning. In a correct build this
      // is unreachable: it means a route is live that no policy describes.
      this.#logger.error(
        `${route.method} ${route.path} has no declared policy; denying. ` +
          `Declare it in routes.ts.`,
      );
      throw new ForbiddenException({ error: 'route_not_declared' });
    }

    if (decision.mode === 'public') return true;

    if (decision.requiresPin) {
      // FAIL CLOSED. Transaction-PIN enforcement is not built yet, and the one
      // thing that must never happen is a money-moving route going live while
      // its author believes `pin: true` is protecting it. Refusing loudly is
      // the only safe behaviour until the PIN check exists; a route that
      // declares `pin: true` cannot serve traffic until then.
      this.#logger.error(
        `${route.method} ${route.path} declares pin: true, but transaction-PIN ` +
          `enforcement is not implemented. Refusing.`,
      );
      throw new InternalServerErrorException({ error: 'pin_enforcement_unavailable' });
    }

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const claims = this.#verifyBearer(request);
    request.auth = claims;
    return true;
  }

  #verifyBearer(request: AuthenticatedRequest): AccessTokenClaims {
    const header = request.headers.authorization;
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
      throw new UnauthorizedException({ error: 'invalid_token' });
    }

    const result = verifyAccessToken(
      header.slice('Bearer '.length),
      this.config.accessTokenKeyring,
      this.clock.nowSeconds(),
    );

    if (!result.ok) {
      // The reason is recorded for us and withheld from the client: telling a
      // caller whether a token was forged or merely expired is free information
      // for somebody probing with tokens they did not issue.
      this.#logger.debug(`access token rejected: ${result.reason}`);
      throw new UnauthorizedException({ error: 'invalid_token' });
    }

    return result.claims;
  }
}
