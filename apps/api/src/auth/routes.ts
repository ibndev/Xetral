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

      // Gift cards. Every one of these refuses with `gift_cards_disabled`
      // until GIFT_CARDS_ENABLED is set — the policy is declared regardless,
      // because a route that exists must be policed whether or not it is
      // currently serving.
      .authenticated('GET', '/v1/giftcards', { pin: false })
      .authenticated('POST', '/v1/giftcards/quote', { pin: false })
      // Selling a card hands over a bearer instrument from the customer's
      // account, so a stolen session must not be able to do it.
      .authenticated('POST', '/v1/giftcards', { pin: true })

      // The privileged surface. Declared with staff(), which is what makes
      // them staff-only — and route-coverage.test.ts fails the build if any
      // /v1/admin/ route is declared any other way.
      .staff('GET', '/v1/admin/giftcards/queue', { pin: false, role: 'giftcard_reviewer' })
      .staff('POST', '/v1/admin/giftcards/:id/reveal', {
        pin: false,
        role: 'giftcard_reviewer',
      })
      // Approving pays a customer. A reviewer who walked away from an unlocked
      // laptop should not have left an approval button behind.
      .staff('POST', '/v1/admin/giftcards/:id/review', {
        pin: true,
        role: 'giftcard_reviewer',
      })
      .staff('POST', '/v1/admin/giftcards/:id/clawback', {
        pin: true,
        role: 'giftcard_reviewer',
      })

      // Funding. Issuing an account creates one at the provider, so it is a
      // POST — but it takes no PIN: receiving money is not spending it, and a
      // customer should never be blocked from being paid.
      .authenticated('POST', '/v1/funding/account', { pin: false })
      .authenticated('GET', '/v1/funding/deposits', { pin: false })

      // Crypto. Receiving an address takes no PIN; sending takes one, because
      // a broadcast transaction cannot be recalled by anyone.
      .authenticated('POST', '/v1/crypto/addresses', { pin: false })
      .authenticated('GET', '/v1/crypto/withdrawals', { pin: false })
      .authenticated('GET', '/v1/crypto/withdrawals/quote', { pin: false })
      .authenticated('POST', '/v1/crypto/withdrawals', { pin: true })

      // FX and remittance. Converting spends one balance to create another,
      // and remitting sends it to somebody else — both move money.
      .authenticated('GET', '/v1/fx/quote', { pin: false })
      .authenticated('GET', '/v1/fx/trades', { pin: false })
      .authenticated('POST', '/v1/fx/convert', { pin: true })

      .public(
        'POST',
        '/v1/webhooks/bitnob/crypto',
        'Bitnob has no session with us; authenticated by an HMAC over the raw body, ' +
          'checked before anything is parsed. Carries on-chain deposit events, which ' +
          'credit customer balances',
      )

      .public(
        'POST',
        '/v1/webhooks/bitnob/deposits',
        'Bitnob has no session with us; the request is authenticated by an HMAC ' +
          'signature over the raw body, checked before anything is parsed. This is ' +
          'the route that creates customer balances, so it is also the one where ' +
          'verification-before-parsing matters most',
      )

      .public(
        'POST',
        '/v1/webhooks/bitnob',
        'Bitnob has no session with us; the request is authenticated by an HMAC ' +
          'signature over the raw body, checked before anything is parsed',
      )
  );
}
