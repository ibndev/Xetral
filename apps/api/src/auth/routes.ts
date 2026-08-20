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
      // Setting the first PIN cannot itself require a PIN. Changing one does,
      // and that is enforced in PinService because only it knows whether a PIN
      // already exists.
      .authenticated('POST', '/v1/auth/pin', { pin: false })

      .authenticated('GET', '/v1/wallets', { pin: false })
      .authenticated('GET', '/v1/wallets/transactions', { pin: false })
      // The first route in the platform to declare pin: true, and the reason
      // the flag exists. Reading a balance does not need a PIN; moving money
      // does.
      .authenticated('POST', '/v1/wallets/transfers', { pin: true })

      .authenticated('GET', '/v1/cards', { pin: false })
      .authenticated('GET', '/v1/cards/:id', { pin: false })
      // Issuing and funding move money onto a card.
      .authenticated('POST', '/v1/cards', { pin: true })
      .authenticated('POST', '/v1/cards/:id/fund', { pin: true })
      // Freezing is the PROTECTIVE action and takes no PIN: a customer watching
      // fraudulent charges land should not have to remember one first.
      // Unfreezing re-enables spending, so it does.
      .authenticated('POST', '/v1/cards/:id/freeze', { pin: false })
      .authenticated('POST', '/v1/cards/:id/unfreeze', { pin: true })
      .authenticated('POST', '/v1/cards/:id/terminate', { pin: true })

      // Airtime, data, utilities, eSIMs, numbers.
      .authenticated('GET', '/v1/purchases', { pin: false })
      .authenticated('GET', '/v1/purchases/catalogue', { pin: false })
      // Verifying a meter reads a name from the provider and moves nothing, so
      // no PIN. It is authenticated all the same: an open endpoint that turns a
      // meter number into a customer's name is a lookup service for anyone who
      // wants one.
      .authenticated('POST', '/v1/purchases/verify', { pin: false })
      // Buying spends the customer's wallet balance.
      .authenticated('POST', '/v1/purchases', { pin: true })

      .public(
        'POST',
        '/v1/webhooks/bitnob',
        'Bitnob has no session with us; the request is authenticated by an HMAC ' +
          'signature over the raw body, checked before anything is parsed',
      )
  );
}
