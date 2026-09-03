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
      // Liveness and readiness. Public because a load balancer has no session,
      // and deliberately carrying no detail about why an instance is not
      // ready — the endpoint is reachable by anything that can route to it.
      .public(
        'GET',
        '/health',
        'liveness for the orchestrator; touches nothing and reveals nothing',
      )
      .public(
        'GET',
        '/ready',
        'readiness for the load balancer; reports only ready or not ready',
      )

      /*
       * Metrics. Public HERE and guarded by its own bearer token inside the
       * controller — the shape the webhooks use, because a scraper has no
       * session to present.
       *
       * It is emphatically not public in effect: it publishes queue depths,
       * provider health and what the platform owes customers. With no
       * `METRICS_TOKEN` configured the route answers 404 rather than 401, so
       * an unconfigured deployment does not advertise that it is there.
       */
      .public(
        'GET',
        '/metrics',
        'scraped by monitoring, which has no session; guarded by METRICS_TOKEN ' +
          'inside the handler and absent entirely when that is unset',
      )

      .public(
        'GET',
        '/v1/countries',
        'the signup form needs the list of countries and their dialling codes ' +
          'BEFORE anybody has an account, the same reason the terms are ' +
          'public; it carries no customer data',
      )

      .public(
        'POST',
        '/v1/auth/register',
        'opens the first account, so requiring an existing session would be ' +
          'circular; rate limited by the same guard as login',
      )
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
      // Account recovery, and the two most carefully-worded justifications in
      // this file. Both MUST be public: a customer who has lost their password
      // has no session to present, so requiring one would make the endpoint
      // reachable only by people who do not need it.
      .public(
        'POST',
        '/v1/auth/password/forgot',
        'a customer who has forgotten their password has no session; requiring one ' +
          'would be circular. Answers 204 for every valid identifier whether or not an ' +
          'account exists, so it cannot be used to enumerate customers, and is rate ' +
          'limited per identifier because each accepted request sends mail to somebody ' +
          'who did not ask for it',
      )
      .public(
        'POST',
        '/v1/auth/password/reset',
        'authenticated by the single-use token from the reset email, which is checked ' +
          'by consume_password_reset_token under a row lock; the caller has no session ' +
          'by definition. Answers 204 and issues NO tokens, so a leaked link grants a ' +
          'password that can be used rather than an immediate live session',
      )

      .authenticated('POST', '/v1/auth/logout', { pin: false })
      .authenticated('GET', '/v1/auth/session', { pin: false })
      // Setting the first PIN cannot itself require a PIN. Changing one does,
      // and that is enforced in PinService because only it knows whether a PIN
      // already exists.
      .authenticated('POST', '/v1/auth/pin', { pin: false })
      // Confirms a PIN without moving money. `pin: true` means the guard does
      // the work and the handler is empty — and the same lockout applies, so
      // this is not a cheaper place to guess than a transfer is.
      .authenticated('POST', '/v1/auth/pin/verify', { pin: true })

      // Account recovery, for a customer who thinks somebody else is in their
      // account. Reading the device list takes NO pin: this is where they find
      // out, and putting a PIN in front of looking would hide the discovery
      // behind the factor they may be about to learn has been used.
      // Enrolling a second factor. Authenticated but NOT staff-only, and
      // deliberately: every staff route now requires an enrolled factor, so
      // gating enrolment behind staff() would be a circular lock that a newly
      // granted operator could never open.
      .authenticated('POST', '/v1/auth/totp/enrol', { pin: false })
      .authenticated('POST', '/v1/auth/totp/confirm', { pin: false })
      /*
       * NOT `staff()`, deliberately, and this is the one place that asymmetry
       * is correct. Its whole purpose is to be reachable by a session that is
       * not yet elevated — a staff policy would refuse the request that exists
       * to make elevation possible, which is the deadlock this endpoint was
       * added to break. `StaffTotpService.elevate` refuses anybody without a
       * confirmed second factor, so it grants a customer nothing at all.
       *
       * No PIN: this proves possession of the authenticator, which is a
       * different factor from the one a PIN proves, and demanding both to
       * start a work session is how a shared authenticator ends up on a desk.
       */
      .authenticated('POST', '/v1/auth/totp/elevate', { pin: false })
      // A customer's own handle. No PIN: it moves no money and is meant to be
      // shared, which is the opposite of a secret.
      .authenticated('GET', '/v1/auth/profile', { pin: false })

      .authenticated('GET', '/v1/auth/devices', { pin: false })
      // Acting on it does. All three are reachable with a stolen access token,
      // so without the PIN a thief could evict the real owner with the session
      // they took — turning a recovery control into an attack.
      .authenticated('POST', '/v1/auth/devices/:id/revoke', { pin: true })
      .authenticated('POST', '/v1/auth/devices/revoke-others', { pin: true })
      .authenticated('POST', '/v1/auth/password', { pin: true })

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
      // Naming a card takes NO PIN. Nothing moves, and it is the customer's
      // own note on their own list — asking for the secret that authorises
      // payments in order to write one trains people to type it for things
      // that are not payments.
      .authenticated('POST', '/v1/cards/:id/label', { pin: false })
      // Freezing is the PROTECTIVE action and takes no PIN: a customer watching
      // fraudulent charges land should not have to remember one first.
      // Unfreezing re-enables spending, so it does.
      // Reading the number needs a PIN. A card number, a CVV and an expiry
      // together are everything needed to spend online, and unlike a transfer
      // there is no ledger entry afterwards for anybody to notice — so a
      // stolen session must not be able to do it.
      .authenticated('POST', '/v1/cards/:id/reveal', { pin: true })
      .authenticated('POST', '/v1/cards/:id/freeze', { pin: false })
      .authenticated('POST', '/v1/cards/:id/unfreeze', { pin: true })
      // Replacing a card. A PIN, because it terminates the old one — and the
      // whole point of the flow is that the customer no longer trusts that
      // card, which is exactly when somebody else may be holding their
      // session.
      .authenticated('POST', '/v1/cards/:id/reissue', { pin: true })
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

      // Identity verification. Submitting is not a money movement, so no PIN;
      // it is authenticated because the documents attach to a known account.
      .authenticated('GET', '/v1/kyc', { pin: false })
      // What this customer's verification allows. Their own tier and the
      // ceilings that go with it — nobody else's.
      .authenticated('GET', '/v1/kyc/limits', { pin: false })
      .authenticated('POST', '/v1/kyc', { pin: false })

      /*
       * What a customer agreed to, and the one call that changes it.
       *
       * `pin: false` on BOTH, deliberately. Consent that is harder to withdraw
       * than to give is not freely given, so stopping the email cannot be
       * gated on a factor a customer may not remember — and nothing here moves
       * money.
       */
      .authenticated('GET', '/v1/consents', { pin: false })
      .authenticated('POST', '/v1/consents', { pin: false })

      /*
       * A customer's own data.
       *
       * The EXPORT declares `pin: true`, unlike every other read here. It is
       * every balance, every transaction, every device and every place they
       * have signed in from, in one file — the single read a stolen session
       * most wants, and the one whose consequence outlives the fifteen minutes
       * an access token lasts.
       *
       * ASKING costs no PIN, for the reason raising a dispute costs none: the
       * customer most likely to ask is one who has just found somebody else in
       * their account. Nothing is destroyed by asking.
       *
       * It is a POST rather than a GET so it cannot be triggered by a link, or
       * cached, or land in a browser history — and because it carries a PIN in
       * its body.
       */
      .authenticated('POST', '/v1/me/export', { pin: true })
      .authenticated('GET', '/v1/me/requests', { pin: false })
      .authenticated('POST', '/v1/me/requests', { pin: false })
      .authenticated('GET', '/v1/me/erasure-scope', { pin: false })

      // ---- The operations backend -------------------------------------
      //
      // Every route below is staff-only, and route-coverage.test.ts fails the
      // build if any /v1/admin/ route is declared any other way. Reading is
      // separated from acting by ROLE, so a support operator can look at a
      // customer without being able to freeze one.

      // Adding a country is reference data, not money — no PIN. Opening one
      // is a decision about where the platform operates, so it takes `admin`
      // rather than a narrower role.
      .staff('GET', '/v1/admin/countries', { pin: false, role: 'admin' })
      .staff('POST', '/v1/admin/countries', { pin: false, role: 'admin' })
      .staff('POST', '/v1/admin/countries/:code', { pin: false, role: 'admin' })

      .staff('GET', '/v1/admin/overview', { pin: false, role: 'support' })
      .staff('GET', '/v1/admin/drift', { pin: false, role: 'finance' })
      // What was collected on a revenue authority's behalf is a finance
      // figure. `finance`, so a support agent looking up a card cannot also
      // read the returns.
      .staff('GET', '/v1/admin/tax', { pin: false, role: 'finance' })
      // Who has not agreed to the words currently in force. `compliance`,
      // because it is the same question as an outstanding KYC review: a
      // customer the platform is processing without a current basis.
      .staff('GET', '/v1/admin/consents', { pin: false, role: 'compliance' })
      // Data requests. `compliance`, and the acting route takes a PIN: an
      // erasure is the one action in the system that cannot be undone by
      // appending.
      .staff('GET', '/v1/admin/data-requests', { pin: false, role: 'compliance' })
      .staff('POST', '/v1/admin/data-requests/:id/erase', { pin: true, role: 'compliance' })
      .staff('POST', '/v1/admin/data-requests/:id/resolve', { pin: true, role: 'compliance' })

      /*
       * Publishing a price.
       *
       * `finance`, and the writes take a PIN. Nothing in the application ever
       * wrote `fx_spread_policies` or `giftcard_rate_cards`, so a fresh
       * deployment refused every FX pair and gift cards could be switched on
       * and then 404 the first quote — with `psql` as the only way out.
       *
       * There is deliberately no update route. A published price is
       * append-only: changing one is retiring it and publishing its
       * replacement, which is what keeps a quote given last month explicable.
       */
      // Whether the providers are answering. `support`, deliberately the
      // widest role: the person taking the call about a card that will not
      // work is the one who needs to know Bitnob has been timing out.
      .staff('GET', '/v1/admin/providers', { pin: false, role: 'support' })
      .staff('GET', '/v1/admin/prices', { pin: false, role: 'finance' })
      .staff('POST', '/v1/admin/prices/fx', { pin: true, role: 'finance' })
      .staff('POST', '/v1/admin/prices/giftcard', { pin: true, role: 'finance' })
      .staff('POST', '/v1/admin/prices/:id/retire', { pin: true, role: 'finance' })
      .staff('GET', '/v1/admin/stuck', { pin: false, role: 'support' })
      // `admin`, not `support`: it names every flow that is switched off and
      // every credential that is absent, which is a map of where this
      // deployment is soft.
      .staff('GET', '/v1/admin/readiness', { pin: false, role: 'admin' })

      .staff('GET', '/v1/admin/users', { pin: false, role: 'support' })
      .staff('GET', '/v1/admin/users/:id', { pin: false, role: 'support' })
      // Freezing an account stops a customer's money moving. An operator who
      // walked away from an unlocked laptop should not have left that behind.
      .staff('POST', '/v1/admin/users/:id/status', { pin: true, role: 'compliance' })

      .staff('GET', '/v1/admin/kyc', { pin: false, role: 'compliance' })
      .staff('POST', '/v1/admin/kyc/:id/review', { pin: true, role: 'compliance' })

      .staff('GET', '/v1/admin/suspense', { pin: false, role: 'finance' })
      // Moves real money to a named customer.
      .staff('POST', '/v1/admin/suspense/:id/attribute', { pin: true, role: 'finance' })

      // PROVIDER CREDENTIALS, and `admin` rather than `finance`.
      //
      // Replacing a provider key is not adjusting a fee: it is the action that
      // decides whether money can move at all, and a wrong one presents as
      // every card declining or every webhook answering 401. It also sits
      // beside the role grants for a reason — both are the privileges that
      // create every other privilege.
      //
      // The listing needs `admin` too. It carries no secret, but it is a map
      // of which integrations are live and which are unconfigured, which is
      // the first thing worth knowing to somebody probing.
      .staff('GET', '/v1/admin/credentials', { pin: false, role: 'admin' })
      .staff('GET', '/v1/admin/credentials/:provider/:name/rotations', {
        pin: false,
        role: 'admin',
      })
      /*
       * NO TRANSACTION PIN, and the reason is a category error rather than a
       * relaxation.
       *
       * A transaction PIN is the factor that authorises MONEY LEAVING A
       * CUSTOMER'S OWN ACCOUNT. Pasting a provider key moves nothing: it is an
       * administrative act, already gated by the `admin` role read fresh from
       * the database and by a session elevated with an authenticator code
       * minutes earlier.
       *
       * Requiring it here also had a cost that pointed the wrong way. Every
       * operator had to hold a customer transaction PIN to do their job, and
       * the refusal said "enter the six-digit code from your authenticator
       * app" beside a field labelled PIN — so an operator with two correct
       * secrets was told they were wrong. Demanding a third factor for a
       * non-money action is how a shared PIN ends up on a desk, which is the
       * same argument 014 makes about codes.
       *
       * The PIN stays on everything that MOVES money, staff routes included:
       * freezing an account, attributing a suspense deposit, resolving a
       * dispute. `route-coverage.test.ts` keeps that list honest.
       */
      .staff('POST', '/v1/admin/credentials/:provider/:name', { pin: false, role: 'admin' })

      // THE COMPLIANCE QUEUE, on the `compliance` role — the same people who
      // review identity, because the two questions are the same one asked at
      // different moments. Not `dispute_reviewer`: a customer complaint and a
      // monitoring signal are different jobs, and 018 already made that split
      // rather than reusing the gift card reviewer.
      //
      // Resolving takes a PIN. It is not a money movement, but it is the act
      // that says a person looked and decided, and that is the record a
      // regulator inspects.
      .staff('GET', '/v1/admin/risk/signals', { pin: false, role: 'compliance' })
      .staff('POST', '/v1/admin/risk/signals/:id/resolve', {
        pin: true,
        role: 'compliance',
      })

      // The case file, on the same role as the signals it groups.
      //
      // Opening and noting take NO PIN: a reviewer writes several notes while
      // working one case, and demanding the factor on each is how a shared
      // authenticator ends up on somebody's desk — the lesson the staff second
      // factor already records. Closing takes one, because it resolves every
      // signal attached and is the act a regulator inspects.
      // CARDS, for the agent on the phone to a customer.
      //
      // Reading is `support`: a declined-card call is the commonest support
      // conversation there is, and it was previously one nobody on this side
      // could follow. The view carries four digits of the number and no more.
      //
      // FREEZING is `compliance`, and there is deliberately no staff
      // terminate. Freezing stops spending and the customer can undo it;
      // terminating moves their money and cannot be undone, and there is no
      // support conversation in which doing that without them is right.
      .staff('GET', '/v1/admin/cards/:id', { pin: false, role: 'support' })
      .staff('POST', '/v1/admin/cards/:id/freeze', { pin: true, role: 'compliance' })

      // A customer's verification tier. `compliance`, not `support`: it decides
      // how much money may leave an account in a day, which is the same kind
      // of decision as approving the identity behind it.
      .staff('POST', '/v1/admin/users/:id/tier', { pin: true, role: 'compliance' })

      .staff('GET', '/v1/admin/risk/cases', { pin: false, role: 'compliance' })
      .staff('GET', '/v1/admin/risk/cases/:id', { pin: false, role: 'compliance' })
      .staff('POST', '/v1/admin/risk/cases', { pin: false, role: 'compliance' })
      .staff('POST', '/v1/admin/risk/cases/:id/notes', { pin: false, role: 'compliance' })
      .staff('POST', '/v1/admin/risk/cases/:id/close', { pin: true, role: 'compliance' })

      .staff('GET', '/v1/admin/settings', { pin: false, role: 'finance' })
      .staff('GET', '/v1/admin/settings/:key/history', { pin: false, role: 'finance' })
      // Changing a fee or a limit affects every customer at once.
      .staff('POST', '/v1/admin/settings/:key', { pin: true, role: 'finance' })

      // Granting a role is the action that creates every other privilege, so
      // it is the one that needs the highest one.
      .staff('GET', '/v1/admin/staff', { pin: false, role: 'admin' })
      .staff('POST', '/v1/admin/staff/grant', { pin: true, role: 'admin' })
      .staff('POST', '/v1/admin/staff/revoke', { pin: true, role: 'admin' })

      .staff('GET', '/v1/admin/audit', { pin: false, role: 'admin' })

      // What is currently failing. `admin` rather than `support`: an error
      // message describes how the platform is built, and the smallest
      // audience that can act on it is the right one.
      .staff('GET', '/v1/admin/errors', { pin: false, role: 'admin' })
      // Acknowledging one takes no PIN — it moves no money and hides nothing,
      // because a recurrence reopens the fingerprint by itself.
      .staff('POST', '/v1/admin/errors/:fingerprint/resolve', { pin: false, role: 'admin' })

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

      // Disputes. NO PIN on raising or withdrawing one: a dispute moves no
      // money, and the customer most likely to raise one has just discovered
      // that somebody else is using their account — which is exactly when
      // demanding the factor that person may already have is worst. The same
      // reasoning freezes a card without a PIN and asks for one to unfreeze.
      .authenticated('POST', '/v1/disputes', { pin: false })
      .authenticated('GET', '/v1/disputes', { pin: false })
      .authenticated('POST', '/v1/disputes/:id/withdraw', { pin: false })

      // The reviewer's side. Its own role rather than borrowing the gift card
      // reviewer's: a dispute is a different job with a different risk, and
      // somebody holding both should be a staffing decision.
      .staff('GET', '/v1/admin/disputes', { pin: false, role: 'dispute_reviewer' })
      // Upholding one pays money out of our own account, so it takes the PIN
      // and — through the guard — a fresh second factor.
      .staff('POST', '/v1/admin/disputes/:id/resolve', {
        pin: true,
        role: 'dispute_reviewer',
      })

      // Funding. Issuing an account creates one at the provider, so it is a
      // POST — but it takes no PIN: receiving money is not spending it, and a
      // customer should never be blocked from being paid.
      .authenticated('POST', '/v1/funding/account', { pin: false })
      // Reading whether one exists, which is a different question from
      // issuing one — see the controller.
      .authenticated('GET', '/v1/funding/account', { pin: false })
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
      /*
       * CONVERTING TAKES NO PIN; REMITTING DOES.
       *
       * A PIN is the second factor for money LEAVING the account. Converting
       * moves a customer's own money between their own wallets — nothing
       * leaves and nobody else can receive it — so demanding it there teaches
       * people to type the secret that authorises payments for something that
       * is not one. Remitting lands the converted money in somebody else's
       * wallet, which is a payment.
       *
       * Two routes rather than one branch, because the policy is per route and
       * `convertSchema` deliberately has no recipient field: the PIN-free path
       * cannot be handed somebody to pay.
       */
      .authenticated('POST', '/v1/fx/convert', { pin: false })
      .authenticated('POST', '/v1/fx/remit', { pin: true })

      /*
       * SENDING MONEY TO A BANK.
       *
       * Three routes, three answers to the PIN question, and the split is the
       * decision rather than an accident of shape:
       *
       *  - the bank list is a catalogue, identical for every customer;
       *  - the name lookup destroys nothing and the customer most likely to
       *    check twice is one being careful, so it costs no PIN — the same
       *    reasoning that lets a dispute be raised without one. It is still
       *    metered by the authenticated ceiling, because a lookup with no
       *    limit is a way to walk a bank's account space and harvest names;
       *  - sending moves money that cannot be recalled.
       */
      .authenticated('GET', '/v1/payouts/banks', { pin: false })
      .authenticated('GET', '/v1/payouts/lookup', { pin: false })
      .authenticated('GET', '/v1/payouts', { pin: false })
      .authenticated('POST', '/v1/payouts', { pin: true })

      .public(
        'POST',
        '/v1/webhooks/bitnob/crypto',
        'Bitnob has no session with us; authenticated by an HMAC over the raw body, ' +
          'checked before anything is parsed. Carries on-chain deposit events, which ' +
          'credit customer balances',
      )

      .public(
        'POST',
        '/v1/webhooks/paystack/deposits',
        'Paystack has no session with us; the request is authenticated by an ' +
          'HMAC-SHA512 over the raw body keyed by the SECRET KEY — the same value ' +
          'that authorises outbound calls, because Paystack has no separate ' +
          'webhook secret. This is the default rail, so it is the route that ' +
          'creates most customer balances and the one where ' +
          'verification-before-parsing matters most',
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
