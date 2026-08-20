# Xetral

Multi-currency fintech platform. Nigeria-first. TypeScript end to end.
Real customer money. Bugs here are financial losses, not visual glitches.

Phase status and rationale: @docs/PHASES.md

---

## Rule 0 — this is a greenfield rebuild

Xetral previously ran as a WordPress plugin (~40k lines of PHP). It is **reference
material only** — business rules, provider quirks, Nigerian rails knowledge.

**Never** port its code, reproduce its patterns, or add anything WordPress-shaped:
no `wp_` prefixes, no PHP, no plugin idioms, no `waos`/`WAOS` identifiers. If a
suggestion traces back to "the plugin did it this way," that is a reason to look
closer, not a reason to copy.

Feature parity with the plugin is **not** a goal.

---

## The four rules

1. **Only the Ledger writes postings.** Every other module requests a journal entry
   and receives an id. This is what makes the system auditable, and it is the rule
   that will be under pressure from every deadline. Do not add a "quick" direct
   write to `postings` from a service.
2. **Money is never a float.** Integer minor units, `bigint` in TS, `BIGINT` in
   Postgres. No `number` for amounts. No `parseFloat`. No `toFixed`.
3. **Providers sit behind ports.** Adding or swapping one touches its adapter and
   nothing else. No provider SDK types leak past the adapter boundary.
4. **Invariants live in the database.** A rule enforced only in application code is
   a rule that holds until the first 3am manual fix. If it protects money, it is a
   constraint or a trigger.

---

## Money — non-obvious rules

Use `@xetral/shared`. Never hand-roll amount handling.

- `Money` is declared **`in out`** over its currency parameter. That annotation is
  load-bearing. Remove it and TypeScript widens the parameter to a union, making
  `add(ngn(100), usd(100))` **compile cleanly** — the guarantee silently ceases to
  exist. Three `@ts-expect-error` directives in `money.test.ts` fail the build if
  this regresses. Do not "simplify" them.
- Because `Money` is invariant, a bare `Money` parameter means `Money<Currency>` —
  the *union* of all currencies, which `Money<'NGN'>` is **not** assignable to.
  Helpers that read any currency must be generic (`<C extends Currency>`), even
  when they only read `.amount`. This looks like noise; it is not.
- Exponents are **per currency**, never a hardcoded 2. JPY is 0, BTC is 8, USDT is
  6. JPY sits in the registry precisely so any code assuming 2 fails in a test.
- Rounding mode is a **required argument with no default**. Every rounding choice
  moves money to someone; the caller must state which way and it must be visible
  in review.
- Fees are **basis points as integers** (150 = 1.5%), never decimals.
- `fromMajor()` takes a **string**, not a number. By the time a decimal is a JS
  number the precision is already gone.

---

## Ledger — non-obvious rules

Schema: `packages/ledger/sql/`. Tests must all print `PASS`. Any `TEST FAILED`
means an invariant is not wired up — do not proceed past it.

Three things that cost real debugging time. Do not rediscover them:

1. **The balance invariant is per currency, not per entry.** Not because a whole-
   entry check rejects valid FX trades — a correct trade sums to zero either way.
   Because a whole-entry check adds kobo to cents as raw integers, so two
   *independent* errors in different currencies cancel and commit. Test 4a is that
   case.
2. **`INSERT ... ON CONFLICT DO UPDATE` fires `BEFORE INSERT` triggers on the
   proposed row**, before the conflict is detected. An overdraft guard on that path
   sees the raw posting amount, not the merged balance, and rejects valid
   withdrawals. Balance rows are therefore seeded at account creation so the write
   path is always a plain `UPDATE`. Do not convert it back to an upsert.
3. **Deferred constraints do not fire until COMMIT.** A test that aborts before
   committing passes *even with the constraint deleted*. Tests must issue
   `SET CONSTRAINTS ALL IMMEDIATE` before asserting on a deferred check.

Also: journal entries and postings are **append-only**. Correct a mistake with a
reversing entry. Never `UPDATE` or `DELETE` them.

### The ledger service

`LedgerService.post()` is the only code that writes postings. Everything else
builds a `LedgerIntent` — a request naming accounts by **role** — and hands it
over.

- **A replay is a success, not an error.** `post()` returns the existing entry
  with `replayed: true` when the idempotency key has already been used. A
  handler that treats the second delivery as a failure keeps failing, and the
  provider keeps retrying, for ever.
- **Never pre-check a balance.** Between the check and the write another request
  can spend the same money. Build the entry, let the overdraft guard decide, and
  translate the error. A pre-check is a second, weaker copy of the rule plus a
  race.
- **`InsufficientFundsError` carries no figure.** Returning "you have ₦4,300" to
  a caller that asked to send ₦5,000 turns a transfer endpoint into a balance
  oracle for a stolen session.
- Account roles resolve to ids inside the service, creating the account if it is
  the first posting. The two partial unique indexes make that race-safe: the
  loser of a concurrent create re-reads the winner's row.
- History is **keyset paginated** on the posting id, and shows only the
  customer's own leg. `OFFSET` shifts under an active account, producing
  duplicates and gaps.

---

## Identity & auth — non-obvious rules

Schema: `packages/identity/sql/`. Same contract as the ledger: every test prints
`PASS`, and a `TEST FAILED` means an invariant is not wired up.

1. **Refresh rotation is a database function, not service code.** Reuse detection
   rests on "was this token already consumed?", which in service code is a SELECT
   then an UPDATE — two requests carrying the same stolen token both read "not
   consumed" and both rotate. `rotate_refresh_token()` locks the family row before
   re-reading the token, so concurrent rotations serialise. Do not reimplement it
   in TypeScript, and do not write `consumed_at` directly.
2. **Reuse revokes the whole family, including the live token.** Revoking only the
   presented token leaves the generation the thief is holding alive. The accepted
   cost is that a client racing its own refresh gets logged out — fix that in the
   client with single-flight, never by weakening the check.
3. **Expiry is checked after consumption, and the order is load-bearing.** An
   expired-but-unused token is a lapsed session, not theft. Treating it as reuse
   revokes families over nothing and buries real incidents in the noise.
4. **A consumed token can never be un-consumed.** Append-only, same as the ledger.
   If `consumed_at` were clearable, "already used" would be a claim about the
   present rather than about history, and one UPDATE would erase the evidence.
5. **Only the hash is stored**, and the `^[0-9a-f]{64}$` CHECK is what makes that
   structural — a raw token is 43 base64url characters and cannot reach a row.
6. **Biometrics unlock the PIN; they do not replace it.** Enrolment requires an
   existing transaction PIN, enforced by trigger rather than by the endpoint.

Access tokens are signed, not stored, so they **cannot be revoked mid-life**.
15 minutes is the exact window a stolen one keeps working — that is why the number
is small, and raising it is a security decision. Anything needing immediate effect
(freezing an account) is checked at the point of action, not inferred from a token.

Authorisation is **deny by default** via `RoutePolicyRegistry`: an undeclared route
returns a denial, and making one public requires a written justification that
`publicRouteAudit()` can list.

Access tokens are **not JWTs**, deliberately — see the header comment in
`access-token.ts`. The version prefix selects a key, never an algorithm.

### Cards — non-obvious rules

Schema: `packages/ledger/sql/003_cards.sql`.

- The card's balance shown to a customer comes from the **ledger**, not from
  asking Bitnob. A provider figure can lag a settlement by days; reconciliation
  compares the two deliberately.
- `last4` has a `^[0-9]{4}$` CHECK. "Just the last four" becomes "the whole
  number" the first time somebody is in a hurry, and then a database dump holds
  PANs.
- **Termination is final**, and a card's `(provider, provider_card_id)` and
  owner are immutable — every webhook already delivered points at that row.
- **Freezing takes no PIN; unfreezing does.** The protective action has to be
  frictionless for a customer watching fraudulent charges land.
- Registering a Bitnob customer is a **KYC step**, so `provider_customers` is
  never populated as a side effect of "get a card" — the card route refuses
  until it exists.
- An authorization the card cannot cover is **rethrown, not acknowledged**, so
  the provider retries: webhooks arrive out of order and a funding event landing
  a moment later makes the retry succeed. Acknowledging would drop a real spend
  from the books to save log noise.

### Purchases (bills, eSIM, numbers) — non-obvious rules

Schema: `packages/ledger/sql/004_purchases.sql`. One table for every "buy a thing
from a provider": the providers differ, the money question does not.

```
Reserve   wallet  -> pending          BEFORE the provider is asked for anything
Settle    pending -> provider_float   it happened
Reverse   pending -> wallet           it did not — a reversal naming the reserve
(neither)                             we do not know; the money stays held
```

- **The reference is derived from the customer's key, never generated.** The
  reserve entry is posted before the purchase row exists, so a crash in that gap
  leaves a retry with no row to find. A derived reference makes that retry reuse
  the same ledger idempotency key and the ledger answers `replayed: true`. A
  random one charges twice, only under a crash. `referenceFor()` is the one
  place it is built.
- **The customer's idempotency key is unique PER CUSTOMER.** Two customers will
  send the same key; a client counting from one is enough. `reference` is ours
  and globally unique, `(user_id, idempotency_key)` is theirs.
- **A timeout settles nothing and reverses nothing.** Reversing refunds a
  purchase that may have been delivered; retrying buys it twice. The row stays
  `reserved`, and `ReconciliationService` resolves it later by ASKING the
  provider. That worker never decides an outcome — a purchase the provider
  still calls `pending` stays held however old it is, and one held past
  `RECONCILE_STALE_SECONDS` is escalated to a human rather than auto-reversed.
  By then both remaining answers can be the wrong one.
- **Settling and reversing live in `purchase-outcome.ts`, used by both callers.**
  The request handler resolves what it learned synchronously; the worker
  resolves what nobody was left listening for. A second copy of those postings
  would be a second set of assumptions about the ledger, and the copy that
  drifts is the one that only runs at 4am against money nobody is watching.
- **Exactly one instance sets `RECONCILE_INTERVAL_SECONDS`.** Duplicate sweeps
  are safe — a session advisory lock serialises them and the ledger's
  idempotency key makes a repeat posting a replay — but asking a provider about
  the same purchase from four processes is rate-limited at best.
- **Delivery payloads are sealed with `envelope.ts`, never stored in the clear.**
  An electricity token is a bearer instrument. The `^v[0-9]+:` CHECK on
  `delivery_sealed` makes that structural.
- **An outcome is final**, by trigger, and identity and amount are immutable.
  Reopening a purchase would let a delivered token be re-delivered.
- **A catalogue price is a bigint and must be mapped at the HTTP boundary.**
  `JSON.stringify` throwing on one is correct behaviour, not a nuisance to patch
  with a global BigInt serialiser.
- **Verification is an optional capability**, not a port method — `verifyTarget`
  on the port would give Airalo and Twilio a method that throws. Use
  `supportsVerification()`.

### NGN funding — non-obvious rules

Schema: `packages/ledger/sql/006_funding.sql`. Bitnob dedicated Nigerian
virtual accounts. **The only inbound flow that creates money** rather than
moving money already ours.

```
Funding    provider_float -> customer_wallet    now owed to the customer
Suspense   provider_float -> suspense           it arrived; we cannot say whose
```

- **The deposit webhook is the most dangerous in the system.** Signature
  verification happens before a single byte is parsed, and the idempotency key
  is the provider's event id, so a redelivery is a replay the ledger refuses.
- **The NGN amount unit is a deployment value, guarded by a ceiling.**
  `BITNOB_NGN_AMOUNT_UNIT` (default `kobo`) and `DEPOSIT_CEILING_KOBO`. A
  factor-of-100 misread blows the ceiling, so the first wrong deposit is held
  in suspense rather than spent. All conversion lives in `ngn-amounts.ts`.
- **The ceiling is asymmetric on purpose.** It catches over-crediting, which is
  spent before anyone notices. Under-crediting surfaces as a customer complaint
  within the hour and is recoverable, and a floor would reject the small
  deposits that are most of the traffic.
- **An unattributable deposit posts to `suspense`, never nowhere.** The money
  arrived whatever we can work out about it.
- **A lost webhook is only found by asking.** `DepositReconciliationService`
  posts under the SAME key the webhook would have used, so a late delivery is a
  replay rather than a second credit.
- **A virtual account is permanent and immutable.** Customers save the number
  as a bank beneficiary; changing the owner or number redirects money silently.
  One live account per (user, currency), enforced by a partial UNIQUE INDEX —
  **not** an EXCLUDE constraint, because `ON CONFLICT` cannot target one.
- **Issuing requires `provider_customers` to exist.** KYC is a prerequisite,
  never a side effect of tapping "add money".
- **A forged webhook answers 401 and is dropped**, never 500 and never retried.

### Crypto (USDT, BTC, on-chain) — non-obvious rules

Schema: `packages/ledger/sql/007_crypto.sql`. Needed **no new entry kinds** —
`crypto_deposit` and `crypto_withdrawal` have been in `001_ledger.sql` since
Phase 1.

```
Deposit seen        provider_float   -> customer_pending   visible, NOT spendable
Deposit confirmed   customer_pending -> customer_wallet    final
Withdrawal reserved customer_wallet  -> customer_pending   the guard decides
Withdrawal sent     customer_pending -> provider_float     unrecallable
Withdrawal failed   a reversal naming the reservation      it never left
```

- **A deposit is two events, like a card spend.** One confirmation can be
  reorganised away, so money sits in `customer_pending` until the threshold.
  The two phases carry DIFFERENT idempotency keys derived from one event —
  without the suffix the confirmation replays the seen entry.
- **The threshold is per chain and stored per deposit row.** A Bitcoin block is
  ten minutes and a Tron block is three seconds. Storing it on the row means
  raising it later cannot un-confirm money already spent.
- **Address validation is checksum validation.** Base58Check (Tron, legacy
  BTC), bech32 (SegWit), EIP-55 (ETH/BSC). Shape checks accept a transposed
  character; checksums do not, and a wrong address cannot be undone.
- **Never hand-roll a hash here.** Keccak-256 comes from `@noble/hashes`, and
  Node's `sha3-256` is a different function that would silently break EIP-55.
  Import `@noble/hashes/sha3.js` — the extensionless specifier is CommonJS-only
  and fails under native ESM.
- **A crypto deposit to an unknown address is NOT suspense.** An address we did
  not issue is not ours; the event throws and is retried.
- **`max_fee` is part of consent.** Fees move between quote and request.
- **An unrecognised provider status throws**, never defaults — one default
  reverses money that is on a chain, the other lies about money that never left.

### Gift cards — non-obvious rules

Schema: `packages/ledger/sql/005_giftcards.sql`. Ships behind
`GIFT_CARDS_ENABLED`, which defaults to **false**.

Buying cards FROM customers inverts every other flow: they hand us a bearer
instrument whose value we cannot verify at the moment we pay. Two controls
follow, and both are in the schema.

```
Submit      (nothing)                                an offer, not a transaction
Approve     giftcard_inventory -> customer_pending   paid, and NOT spendable
Release     customer_pending   -> customer_wallet    the hold matured
Claw back   a reversal naming the approval           only while still held
Reject      (nothing)                                no entry ever existed
```

- **Every payout is approved by a human.** There is no auto-approval path and
  no threshold below which one exists — "small" is what a fraudster sends first
  to find where the threshold is.
- **The hold is enforced by the database clock, in two places**: the
  `giftcard_holds_due` view and the state-machine trigger. A release worker
  with a skewed clock must not be able to shorten the only control still
  standing after approval.
- **A clawback works only while the money is held.** After release it may be
  spent, and clawing back would overdraw a customer who did nothing wrong.
- **Roles are read fresh per request, never carried in the access token.** A
  signed token cannot be revoked mid-life; a role baked into one outlives its
  own withdrawal by fifteen minutes.
- **The role is checked before the PIN**, so probing an admin path cannot spend
  a customer's PIN attempts.
- **`/v1/admin/` routes must be declared with `staff()`**, and
  `route-coverage.test.ts` fails the build otherwise. Using `authenticated()`
  by mistake leaves an approval endpoint open to every signed-in customer.
- **Card codes are sealed** (`^v[0-9]+:` CHECK) and never returned to a
  customer. A reviewer reveals ONE deliberately; the queue listing carries none.
- **Rate cards are append-only.** Editing one rewrites the price of every past
  trade. Retire and republish.
- **The rate IS the FX** — "N1,250.00 per USD of face value" — so this phase
  needs none of Phase 10's machinery.

### apps/api

- `AuthGuard` is registered with `APP_GUARD`, so it runs for **every** route. A
  route with no entry in `auth/routes.ts` is refused, and
  `route-coverage.test.ts` fails the build if a controller declares one the
  policy does not (and vice versa, so the audit cannot describe a route that no
  longer exists).
- A route declaring `pin: true` has its transaction PIN verified by `AuthGuard`
  before the handler runs. The PIN is read from the request body, and the check
  happens **after** the bearer token — verifying a PIN for a caller whose
  session is forged would spend one of that customer's five attempts on a
  request they never made, which is a way to lock anyone out of their own money.
- Nest's route metadata keys are hardcoded in `route-key.ts`, not imported from
  `@nestjs/common/constants`: that module is unresolvable under native ESM and
  the failure only appears once the bundle starts. A canary test asserts the
  literals still match.
- DI uses explicit `@Inject` tokens throughout. esbuild — what vitest
  transpiles with — does not emit `design:paramtypes`, so type-inferred
  injection compiles and then fails at runtime.
- Rate limiting has two backends behind `RateLimitStore`, chosen by whether
  `REDIS_URL` is set. Both are held to **one shared contract suite**
  (`rate-limit.contract.ts`) — the point of Redis is that every instance gives
  the same answer, and two hand-written suites would drift into testing two
  behaviours while staying green. Without `REDIS_URL` the limiter is
  in-process and bootstrap logs a warning; that is correct for one box only.
- The Redis limiter is a **Lua script, not three commands**. Prune-count-add
  over separate round trips is a read-modify-write, and under the concurrency
  that justifies running Redis at all, several instances each read "room
  available" and each write. JavaScript's single thread gave the in-memory
  store that atomicity for free; Redis has to be told.

---

## Providers

Live set: **Bitnob** (NGN virtual accounts, crypto, USDT, stablecoin, virtual
USD cards, FX),
**VTpass** (airtime, data, bills), **Airalo** (eSIM), **Twilio** (virtual numbers).

Do **not** reintroduce Reloadly, Maplerad, Anchor, Paystack or ALAT. They appear in
the reference plugin and are out of scope.

### Bitnob specifics — verified from their docs

- **Card spend is two events, not one.** Authorization, then Settlement up to 7–14
  business days later, each with its own webhook. If no settlement arrives the hold
  expires and funds return. Bitnob's own docs warn that treating them as one
  transaction produces an incorrect balance. This is why the `customer_pending`
  account exists: auth moves card → pending, settlement moves pending → float,
  expiry is an ordinary reversal.
- **A card spends its OWN balance, not the wallet.** A Bitnob virtual card is
  topped up from the wallet and holds its own funds. Authorising against the
  wallet would let a card funded with $10 spend whatever the wallet held. The
  overdraft guard already covers `customer_card`, so naming the right account
  *is* the protection.
- **Webhook amounts are micro-units: 1 USD = 1,000,000.** Six decimals where the
  ledger uses two. The sibling `display_amount` is a **float** and must never touch
  ledger maths — it is for display only. Conversion happens at exactly one audited
  boundary inside the adapter, with its own tests.
- Webhook `event_id` is the natural source for `idempotency_key`. Format the key as
  `bitnob:<event_id>` so two providers cannot collide.
- JSON keys in webhook payloads are snake_case. Request bodies to their REST
  API are **camelCase** (`customerEmail`, `cardId`) — the two do not match, and
  both are verified against their official Node SDK.
- The webhook signature is **HMAC-SHA512**, hex, in `x-bitnob-signature`. It was
  SHA-256 here on the strength of "everyone uses SHA-256", which would have
  rejected every webhook in production and looked like a bad secret.
- Card endpoints have **no per-card sub-resources**. Every operation is a flat
  POST to a verb path (`/virtualcards/freeze`) with `cardId` in the body, under
  a base URL that includes `/api/v1`.
- Card issuing **requires approval** from Bitnob before use. The card webhook
  EVENT NAMES are the one thing still unconfirmed, and they resolve as part of
  that approval — an unrecognised event throws and is retried, so a wrong name
  is loud rather than a dropped spend.

### The fulfilment port

VTpass, Airalo and Twilio implement **one** port (`ports/fulfilment.ts`) and are
held to **one** contract suite (`ports/fulfilment.contract.ts`). Three
hand-written suites drift into testing three behaviours while all staying green,
and the whole point of a port is that a caller cannot tell which implementation
answered. Add an adapter, add it to the contract.

Per-provider quirks are absorbed inside the adapter and stop there: VTpass codes
(`000` success, `099` pending) and naira-as-text amounts, Airalo's OAuth2 token
cache, Twilio's form-encoded bodies. None of that shape reaches a caller.

Twilio is priced by **us**, not by Twilio: `priceCents` is what the customer pays,
and an instance that has not set it cannot sell a number.

**VTpass's `request_id` is derived, never generated.** It must start with a
`YYYYMMDDHHMM` stamp in Africa/Lagos, so `PurchaseRequest` carries `initiatedAt`
— the purchase row's `created_at` — and `vtpassRequestId()` builds the same
string every time from it. Reading the clock instead would give a retry a new
id (a second purchase, to VTpass) and leave reconciliation requerying an id that
never existed.

**Airalo signs every body it sends**: `airalo-signature`, HMAC-SHA512 of the
payload's JSON, keyed by the client secret. The token exchange is the awkward
one — form-encoded on the wire, signed as JSON. The adapter serialises once and
signs the exact string it sends, so the two cannot drift.

### Working in `packages/providers`

- An adapter never writes postings. It produces a `LedgerIntent` — a *request*
  for a journal entry naming accounts by ROLE — and hands it over. Resolving a
  role to an account id is the ledger's job.
- `LedgerIntent` postings carry `amountMinor` + `currency` rather than `Money`,
  because `Money` is invariant: a bare `Money` field means `Money<Currency>` and
  would reject every real caller. Build legs with `posting()`, which is generic
  and cannot mix an amount up with the wrong code.
- All micro-unit conversion lives in `bitnob/amounts.ts` and nowhere else. A
  second conversion inline at a call site is how a settlement ends up off by a
  factor of 10,000.
- `parseMicro` **rejects** a JSON number beyond `MAX_SAFE_INTEGER` rather than
  coercing it. By then `JSON.parse` has already rounded it and the lost unit is
  unrecoverable; the fix is to ask the provider for a string.
- A sub-cent remainder is **recorded, never posted**. A cent is the smallest
  unit the ledger can hold, so posting a whole one would invent the rest.
- `ProviderTimeoutError` is deliberately **not** retryable. A timeout means we
  do not know whether the provider acted, and the naive retry is how one card
  funding becomes two. Reconcile instead.
- Every provider's endpoint table, auth scheme and signature is **verified
  against that provider's own SDK or published docs**, and each says which in a
  header comment. When one of these was a guess it was wrong — every Bitnob
  card path, and the webhook hash — so treat an unsourced constant here as a
  bug rather than a detail.

---

## Security posture

- **Deny by default.** An endpoint must explicitly opt out of auth. The reference
  plugin had 45 routes declaring `permission_callback => '__return_true'` with the
  real check inside each callback — safe only until someone forgets once.
- Transaction PIN is **separate** from login credentials. Biometrics unlock the
  PIN; they do not replace it.
- Refresh tokens rotate on every use, with **reuse detection**: a token presented
  twice means it was stolen — revoke the whole device family.
- Never log full PANs, BVNs, tokens, or provider secrets. Never commit `.env`.
- Encryption envelopes carry a **key version** (`v1:`) so keys can be rotated.

---

## Conventions

- Commits are per phase or per file, with a message explaining *why*, not what.
- Every money-touching change needs a test that fails without it.
- Comments explain **why**, especially where the obvious approach is wrong. The
  codebase is deliberately heavy on this; match it.
- Never widen a type or add `any` to silence the compiler on a money path. The
  compiler is the cheapest auditor available.

---

## Commands

```bash
npm install
npm test                                # all workspaces, via turbo
npm test --workspace @xetral/shared     # money primitives (vitest)
npm test --workspace @xetral/identity   # tokens, PIN, envelopes, policy (vitest)
npm test --workspace @xetral/api        # guard, route coverage, rate limiting
npm test --workspace @xetral/providers  # conversion, webhooks, card and fulfilment adapters
npm test --workspace @xetral/ledger     # intent validation (service is e2e-only)

# SQL invariants — needs live PostgreSQL 16. Apply migrations in order; the
# test files are NOT idempotent, so run them against a freshly created database.
createdb xetral
psql -d xetral -v ON_ERROR_STOP=1 -f packages/ledger/sql/001_ledger.sql
psql -d xetral -v ON_ERROR_STOP=1 -f packages/identity/sql/002_identity.sql
psql -d xetral -v ON_ERROR_STOP=1 -f packages/ledger/sql/003_cards.sql
psql -d xetral -v ON_ERROR_STOP=1 -f packages/ledger/sql/004_purchases.sql
psql -d xetral -v ON_ERROR_STOP=1 -f packages/ledger/sql/005_giftcards.sql
psql -d xetral -v ON_ERROR_STOP=1 -f packages/ledger/sql/006_funding.sql
psql -d xetral -v ON_ERROR_STOP=1 -f packages/ledger/sql/007_crypto.sql
psql -d xetral -v ON_ERROR_STOP=1 -f packages/ledger/sql/001_ledger.test.sql
psql -d xetral -v ON_ERROR_STOP=1 -f packages/identity/sql/002_identity.test.sql
psql -d xetral -v ON_ERROR_STOP=1 -f packages/ledger/sql/003_cards.test.sql
psql -d xetral -v ON_ERROR_STOP=1 -f packages/ledger/sql/004_purchases.test.sql
psql -d xetral -v ON_ERROR_STOP=1 -f packages/ledger/sql/005_giftcards.test.sql
psql -d xetral -v ON_ERROR_STOP=1 -f packages/ledger/sql/006_funding.test.sql
psql -d xetral -v ON_ERROR_STOP=1 -f packages/ledger/sql/007_crypto.test.sql

# API flows end to end. Needs both services: Postgres for the auth flows,
# Redis for the rate-limiter contract.
DATABASE_URL=postgres://... REDIS_URL=redis://localhost:6379 npm run test:e2e
```

CI (`.github/workflows/ci.yml`) runs all of the above against Postgres 16 and
Redis 7, then boots the built bundle and checks a guarded route answers 401.
That last step is not ceremony: three failures in this app were invisible to
both the compiler and the tests and appeared only at startup.

## Deployment

Coolify (self-hosted) on Hetzner, Cloudflare free tier in front, GitHub Actions CI,
EAS for mobile builds. A single box is fine now and is **not** an acceptable
production topology for a licensed fintech — split app and database onto separate
nodes with streaming replication before taking real deposit volume.
