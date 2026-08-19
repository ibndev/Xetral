import { RoutePolicyRegistry } from '@xetral/identity';

/**
 * Every route this application serves, and its authorisation policy.
 *
 * This is the file a reviewer reads to answer "what is reachable without
 * signing in?". It is deliberately one list rather than an annotation next to
 * each handler: a decorator on a controller method is easy to read one at a
 * time and impossible to audit as a whole, which is how a plugin ends up with
 * 45 public routes and nobody able to name them.
 *
 * A route missing from this list is denied by AuthGuard, and
 * `route-coverage.test.ts` fails the build if a controller declares a route
 * this list does not.
 */
export function buildRoutePolicy(): RoutePolicyRegistry {
  return (
    new RoutePolicyRegistry()
      .public(
        'POST',
        '/v1/auth/login',
        'issues the first session; requiring an existing session would be circular',
      )
      .public(
        'POST',
        '/v1/auth/refresh',
        'authenticated by the refresh token in its body, which is single-use and ' +
          'checked by rotate_refresh_token; the access token is expected to be expired here',
      )
      .authenticated('POST', '/v1/auth/logout', { pin: false })
      .authenticated('GET', '/v1/auth/session', { pin: false })
  );
}
