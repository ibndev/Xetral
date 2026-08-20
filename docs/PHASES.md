# Build phases

Each phase is independently landable. A later phase adds files and migrations; it
does not require rewriting an earlier one. Where a phase changes something already
shipped, that is called out explicitly.

## Where things stand

| Phase | | Blocked on |
|---|---|---|
| 0 — Foundation | ✅ | |
| 1 — Ledger | ✅ | |
| 2 — Identity & auth | ✅ | |
| 3 — Provider ports + Bitnob adapter | ✅ | |
| 4 — NGN wallet | ✅ | funding split out to Phase 8 |
| 5 — Virtual USD cards | ✅ | Bitnob registration under review |
| 6 — Bills, eSIM, numbers | ✅ | |
| 7 — Gift cards | ✅ | ships flagged off by design |
| 8 — NGN funding rail | ✅ | |
| 9 — Crypto / USDT / stablecoin | not built | Bitnob registration under review |
| 10 — Multi-currency + FX / remittance | not built | Bitnob registration under review |
| 11 — Mobile and web clients | not built | |

Three phases remain, and the platform can now receive money as well as move it.
Phases 9 and 10 are implemented-to-the-port work waiting on Bitnob credentials,
not design work.

---

## Phase 0 — Foundation ✅

Monorepo, strict TypeScript, money primitives.

| File | What it is |
|---|---|
| `package.json`, `tsconfig.base.json` | workspace root, strict compiler settings |
| `packages/shared/src/money/currency.ts` | currency registry — every currency and its exponent |
| `packages/shared/src/money/money.ts` | `Money` type, currency-safe arithmetic, rounding, parsing |
| `packages/shared/src/money/money.test.ts` | 29 tests |

**Load-bearing detail:** `Money` is declared `in out` over its currency parameter.
Without that annotation TypeScript widens the parameter to a union and
`add(ngn(100), usd(100))` **compiles cleanly** — the guarantee silently does not
exist. This was found by compiling the failing case, not by reasoning about it.
Three `@ts-expect-error` directives in the test file fail the build if it ever
regresses.

---

## Phase 1 — Ledger ✅

Double-entry, immutable, multi-currency. Executed against PostgreSQL 16; all 12
invariant tests pass.

| File | What it is |
|---|---|
| `packages/ledger/sql/001_ledger.sql` | accounts, journal entries, postings, invariants, views |
| `packages/ledger/sql/001_ledger.test.sql` | 12 invariant tests |

Enforced **in the database**, not in service code:

- postings sum to zero **per currency** (deferred to COMMIT)
- a posting's currency must match its account's currency
- no zero-amount postings
- no duplicate `idempotency_key` — the webhook replay guard
- no customer overdrafts
- balances maintained by trigger, with a nightly drift view

Three findings from building it, recorded so they are not rediscovered:

1. **Per-currency is not about rejecting valid FX trades.** A correct trade sums to
   zero across the whole entry anyway. The danger is that a whole-entry check adds
   kobo to cents as raw integers, so two *independent* errors in different
   currencies cancel and commit. Test 4a is that case.
2. **`INSERT ... ON CONFLICT DO UPDATE` fires `BEFORE INSERT` triggers on the
   proposed row**, before the conflict is detected. An overdraft guard on that path
   sees the raw posting amount, not the merged balance, and rejects valid
   withdrawals. Balance rows are therefore seeded at account creation so the write
   path is always a plain `UPDATE`.
3. **Deferred constraints do not fire until COMMIT.** A test that aborts before
   committing passes even with the constraint deleted. Tests issue
   `SET CONSTRAINTS ALL IMMEDIATE`.

---

## Phase 2 — Identity & auth ✅

Short-lived access tokens, rotating refresh tokens with reuse detection, device
binding, transaction PIN separate from login credentials, biometric gate.
Executed against PostgreSQL 16; all 20 invariant blocks pass, plus 76 unit tests.

| File | What it is |
|---|---|
| `packages/identity/sql/002_identity.sql` | users, credentials, PINs, devices, sessions, refresh tokens, biometrics |
| `packages/identity/sql/002_identity.test.sql` | 20 invariant blocks |
| `packages/identity/src/tokens.ts` | refresh token minting and hashing |
| `packages/identity/src/access-token.ts` | short-lived signed access tokens |
| `packages/identity/src/secret-hash.ts` | the one scrypt path, shared by PINs and passwords |
| `packages/identity/src/pin.ts` | transaction PIN policy |
| `packages/identity/src/password.ts` | login password policy |
| `packages/identity/src/envelope.ts` | key-versioned AES-256-GCM envelopes |
| `packages/identity/src/policy.ts` | deny-by-default route policy |
| `packages/identity/src/redaction.ts` | log scrubbing |

Enforced **in the database**, not in service code:

- a refresh token is consumed at most once, and never un-consumed
- reuse of a consumed token revokes the whole family, atomically
- a session cannot be opened on a revoked device or on another user's device
- revoking a device revokes its live sessions
- revocation is final
- biometric enrolment requires an existing transaction PIN
- the PIN locks after five failures and cannot be verified while locked
- every stored secret carries a version prefix

Findings from building it, recorded so they are not rediscovered:

1. **Reuse detection cannot live in service code.** It rests on "was this token
   already consumed?", which as a SELECT-then-UPDATE lets two requests carrying
   the same stolen token both read "not consumed" and both rotate — the theft is
   not merely undetected, it has been served twice. `rotate_refresh_token()`
   locks the family row before re-reading the token. Same reasoning that made
   `idempotency_key` a UNIQUE constraint rather than a check in Phase 1.
2. **Reuse must kill the family, not the presented token.** Revoking only what
   was replayed leaves the generation the attacker is holding alive. The
   accepted cost is that a client racing its own refresh gets logged out; that
   is a client bug to fix with single-flight, not a reason to weaken the check.
3. **Expiry is checked after consumption.** An expired-but-unused token is a
   lapsed session, not theft. Reversing the order revokes families over nothing
   and buries real incidents in the noise.
4. **`INSERT ... ON CONFLICT` is not the only trigger-ordering trap.** Setting
   `consumed_at` and `replaced_by_id` in two separate UPDATEs trips the
   append-only trigger on the second pass, because by then the token is already
   consumed. One UPDATE sets both.

Authorisation is **deny by default**: an endpoint must explicitly opt out. The
reference plugin had 45 routes declaring `permission_callback => '__return_true'`
with the real check inside each callback — safe only for as long as nobody forgets.
`RoutePolicyRegistry` inverts that: an undeclared route is denied, being public
requires a written justification, and `publicRouteAudit()` lists the whole opt-out
surface — the list the plugin never had.

**Known limitation, deliberate:** a signed access token cannot be revoked
mid-life. Revoking a session stops the next *refresh*, so a stolen access token
stays valid until it expires. Fifteen minutes is the size of that window and the
reason the number is small. Anything needing immediate effect — freezing an
account, blocking a transfer — is checked against `users.status` at the point of
the action, never inferred from the presence of a token.

### apps/api — the HTTP surface ✅

Landed after the rest of the phase, closing what was open.

| File | What it is |
|---|---|
| `apps/api/src/auth/auth.guard.ts` | global guard; denies any route without a declared policy |
| `apps/api/src/auth/routes.ts` | the whole route table and its policies, in one readable list |
| `apps/api/src/auth/auth.controller.ts` | login, refresh, logout, session |
| `apps/api/src/auth/auth.service.ts` | the flows, calling `rotate_refresh_token` and friends |
| `apps/api/src/auth/rate-limit.ts` | sliding-window limiter: in-memory and Redis, one contract |
| `apps/api/src/config.ts` | env parsing that refuses to boot without secrets |

Twenty-seven unit tests plus twenty-four end-to-end tests against PostgreSQL 16 and Redis 7.

Findings from wiring it up:

5. **A "public route" annotation next to each handler cannot be audited.** The
   policy lives in one list, and `route-coverage.test.ts` compares it against
   the router in *both* directions — a live route with no policy fails the
   build, and so does a policy for a route that no longer exists. The second
   direction matters as much: an audit that describes a surface which is not
   there invites the reader to stop trusting it.
6. **`pin: true` fails closed, deliberately.** Transaction-PIN enforcement was
   not built when this landed, and a money-moving route must not serve traffic
   while its author believes that flag is protecting it — so such a route could
   not respond at all. *Closed in Phase 4: the guard now verifies a real PIN.*
7. **esbuild does not emit `design:paramtypes`.** NestJS's usual constructor
   injection depends on it, so every dependency is named with an explicit
   `@Inject` token. Type-inferred injection compiles and then fails at runtime
   with an unhelpful "cannot resolve dependency at index 0".
8. **`@nestjs/common/constants` is unresolvable under native ESM.** It works
   under vitest and throws `ERR_MODULE_NOT_FOUND` once the bundle starts — the
   worst moment to discover it. The two metadata keys are literals now, with a
   canary test asserting they still match what Nest exports.

9. **Naive Redis rate limiting reintroduces the race the in-memory store never
   had.** Prune, count, then add is a read-modify-write; run it from several
   instances and each reads "room available" before any of them writes.
   JavaScript's single thread gave the in-memory version atomicity for free, so
   moving to Redis is exactly the step that removes it — the decision is one Lua
   script, and a test issues twenty concurrent attempts against a limit of five
   and asserts exactly five are allowed.

Both backends are held to **one shared contract suite**. Asserting "Redis
behaves like memory" with two hand-written suites lets them drift into testing
two different behaviours while both stay green — and the entire reason to run
Redis is that every instance agrees.

**Known limitation at the time, since closed:** transaction-PIN enforcement was
unbuilt, so no route could declare `pin: true` and serve traffic. It landed in
Phase 4 with the first money-moving endpoint.

---

## Continuous integration ✅

`.github/workflows/ci.yml`, against Postgres 16 and Redis 7 service containers:
SQL invariants on a dedicated database, typecheck, unit tests, end-to-end tests,
build, and a smoke test that boots the built bundle.

Two details that are not boilerplate:

- **The invariant step scans psql's output, not just its exit code.**
  `ON_ERROR_STOP` catches a raised `TEST FAILED`, but the ledger's drift check
  reports through a `SELECT` and exits zero. Verified by corrupting a
  materialised balance: psql exits 0 and only the output scan catches it. A
  reconciliation check that cannot fail the build is not a check.
- **The built bundle is started and probed.** Three failures in `apps/api` were
  invisible to both the compiler and the test suite and appeared only at
  startup. A green test run is not evidence the artifact runs.

---

## Phase 3 — Provider ports + Bitnob adapter ✅

Port interfaces first, then the Bitnob adapter behind one. 70 unit tests, plus
8 end-to-end against the real ledger schema.

| File | What it is |
|---|---|
| `packages/providers/src/ports/ledger-intent.ts` | what an adapter produces instead of writing postings |
| `packages/providers/src/ports/card.ts` | the virtual-card port |
| `packages/providers/src/ports/errors.ts` | provider failures classified by what to do about them |
| `packages/providers/src/bitnob/amounts.ts` | the one micro-unit conversion boundary |
| `packages/providers/src/bitnob/webhooks.ts` | signature verification, parsing, two-phase card mapping |
| `packages/providers/src/bitnob/client.ts` | HTTP boundary, endpoint table |
| `packages/providers/src/bitnob/card-adapter.ts` | `CardPort` implemented against Bitnob |

An adapter never writes postings. It produces a `LedgerIntent` naming accounts
by **role**, and the ledger resolves roles to ids — which keeps Rule 1 true
without every adapter needing to know the account tree.

Findings from building it:

1. **A float cannot be kept out of ledger maths by convention.** `display_amount`
   is simply absent from the parsed event, so there is no path by which it could
   reach a posting. A test sends a deliberately wrong one and asserts the
   posting is unaffected — which is a claim about the code's shape, not about
   anyone's discipline.
2. **Six decimal places into two does not always divide.** 1,234,567 micro-units
   is 123.4567 cents, and a cent is the smallest thing the ledger can represent.
   The remainder is therefore **recorded, never posted**: writing a whole cent
   to suspense would invent the other 0.5433 and make the entry a statement
   about money that does not exist.
3. **A JSON number past 2^53 has already lost precision.** `parseMicro` rejects
   an unsafe integer rather than coercing it, and says why — the fix is to have
   the provider send a string, and no care downstream recovers the lost unit.
4. **`LedgerIntent` postings are not `Money`-typed**, because `Money` is
   invariant: a bare `Money` field means `Money<Currency>` and `Money<'USD'>` is
   not assignable to it, so the field would reject every real caller. An entry
   spans currencies anyway. `posting()` is generic and is the only sanctioned
   way to build a leg.
5. **A timeout is deliberately not retryable.** It means we do not know whether
   the provider acted, and for "fund this card" the naive retry is exactly how
   one funding becomes two. The recovery path is reconciliation.
6. **"Pending with an unchanged balance" is not success.** Bitnob's card funding
   answers immediately that way, so the port models a distinct `pending` state
   rather than a boolean a caller could collapse. The adapter also distrusts a
   claimed success whose balance did not move — the numbers win over the label.
7. **Only the database can check the enums.** `EntryKind` and `AccountRef` are
   literal unions in TypeScript and enums in Postgres, and nothing but an
   insert proves they still agree. The e2e suite writes real intents against
   `001_ledger.sql`, which is also where replay is proven: the same webhook
   delivered twice raises a unique violation and the balance does not move a
   second time.

**CONFIRMED — and both guesses were wrong.** Checked against Bitnob's official
Node SDK (npm `bitnob`):

- The webhook signature is **HMAC-SHA512**, not SHA-256. Every webhook would
  have been rejected in production, presenting as a misconfigured secret.
- There are **no per-card sub-resources**. `POST /virtualcards/{id}/freeze` — a
  reasonable REST guess — does not exist; it is `POST /virtualcards/freeze`
  with `cardId` in the body, and funding is `/virtualcards/credit`, not
  `/topup`. Every path in the table was wrong.
- Request bodies are **camelCase** (`customerEmail`, `cardId`) even though
  webhook payloads are snake_case, and `/api/v1` belongs to the base URL.

The lesson worth keeping is not any one path: it is that a table of plausible
constants, with tests written from the same assumptions, passed everything and
would have failed on the first live call. The tests agreed with the code
because the same person wrote both.

**CONFIRM BEFORE GO-LIVE — the only open item in the codebase.** Bitnob
registration is currently UNDER REVIEW, and card issuing requires their
approval before use. The card webhook EVENT NAMES resolve with it — their
SDK does not define events, so the first real authorization is what settles the
two-phase naming. An unrecognised event throws rather than being acknowledged,
so a wrong name is loud and retried, never a dropped spend.

---

## Phase 4 — NGN wallet ✅

Balances, transfers, history, and the ledger service that writes them. The first
real money flow end to end, and the first route to require a transaction PIN.
206 unit tests plus 64 end-to-end.

| File | What it is |
|---|---|
| `packages/ledger/src/ledger-service.ts` | the only code that writes postings |
| `packages/ledger/src/intent.ts` | `LedgerIntent` — a request for a journal entry |
| `packages/ledger/src/errors.ts` | ledger failures, named for what happened |
| `apps/api/src/auth/pin.service.ts` | transaction-PIN verification and lockout |
| `apps/api/src/wallet/wallet.service.ts` | balances, transfers, history |
| `apps/api/src/wallet/wallet.controller.ts` | `GET /v1/wallets`, `POST /v1/wallets/transfers`, history |

Findings from building it:

1. **A replay is a success.** `post()` returns the existing entry with
   `replayed: true` rather than throwing. A handler that treats a redelivery as
   a failure keeps failing and the provider keeps retrying, for ever — and the
   customer's retried transfer would otherwise look broken to them.
2. **Never pre-check a balance.** Between the check and the write another
   request can spend the same money, so the service builds the entry and lets
   the overdraft guard decide. A pre-check is a second, weaker copy of the rule
   *plus* a race.
3. **The insufficient-funds error carries no figure.** Returning "you have
   ₦4,300" to a caller that asked to send ₦5,000 turns a transfer endpoint into
   a balance oracle for anyone holding a stolen session.
4. **The PIN is checked after the bearer token.** Verifying a PIN for a caller
   whose session is forged would spend one of that customer's five attempts on
   a request they never made — a way to lock anyone out of their own money.
   There is a test asserting the PIN service is not even called.
5. **The fee defaults to zero.** A fee nobody configured is money taken from a
   customer because of a default, and the failure is silent: every transfer just
   costs slightly more than the product intended.
6. **History is keyset paginated and shows only the customer's own leg.** A
   transfer is −₦5,050 to the sender and +₦5,000 to the recipient; neither wants
   the other's side or the fee leg. `OFFSET` shifts under an active account,
   producing duplicates and gaps.
7. **`LedgerIntent` moved from `@xetral/providers` to `@xetral/ledger`.** A
   wallet transfer is not a provider concern and must not import one to describe
   an entry. The ledger owns the definition of what it accepts.
8. **Shared-database e2e suites need synthetic owner ids.** `accounts.owner_id`
   is polymorphic and unconstrained, so the ledger and provider suites invent
   owners — but taking `MAX(owner_id) + 1` eventually lands on an id the users
   sequence will issue, and then a real customer's "empty wallet" already has a
   balance. Found by running the suites together rather than one at a time.

**The one part of this phase that cannot land yet:** customer-facing NGN
*funding*. It needs a bank rail — virtual accounts — and none of the four live
providers offers one. The ledger side is built and tested (funding is an
ordinary entry), so what is missing is the provider and its webhook, not the
accounting. Choosing that provider is a prerequisite for taking real deposits.

## Phase 5 — Virtual USD cards (Bitnob) ✅

Issue, fund, freeze, terminate, and the auth/settlement webhooks landing in the
ledger. 10 card invariant blocks, plus 21 end-to-end covering the whole flow
over HTTP.

| File | What it is |
|---|---|
| `packages/ledger/sql/003_cards.sql` | provider customers, cards, termination invariants |
| `packages/ledger/sql/003_cards.test.sql` | 10 invariant blocks |
| `apps/api/src/cards/card.service.ts` | issue, fund, freeze, unfreeze, terminate |
| `apps/api/src/cards/webhook.service.ts` | verify, resolve the customer, post |
| `apps/api/src/cards/card.controller.ts` | card routes and the Bitnob webhook |

**This phase CORRECTS Phase 3.** The Bitnob adapter mapped an authorization as
`wallet -> pending`. A Bitnob virtual card is topped up from the wallet and
holds its own funds, so a purchase is authorised against the CARD's balance —
and drawing from the wallet would let a card funded with $10 authorise $500
because the wallet happened to hold it. Phase 3 had no card table to know
better. The flow is now:

```
Funding       wallet  -> card              reclassified, still the customer's
Authorization card    -> pending           committed, not yet spent
Settlement    pending -> provider_float    the hold becomes a real spend
Expiry        pending -> card              the hold lapsed
Termination   card    -> wallet            what is left comes back
```

The overdraft guard from Phase 1 already covers `customer_card`, so naming the
right account *is* the protection — no new rule was needed.

Findings from building it:

1. **Freezing takes no PIN; unfreezing does.** The protective action has to be
   frictionless: a customer watching fraudulent charges land should not have to
   remember a PIN first. Unfreezing re-enables spending, so it asks.
2. **Registering a provider customer is a KYC step, not a side effect.** It
   means sending identity documents to Bitnob, with its own consent and audit
   trail, so `provider_customers` is never populated by tapping "get a card" —
   the route refuses until the mapping exists.
3. **Provider call and ledger entry are ordered differently per operation, and
   deliberately.** Issuing calls Bitnob first: posting first and having them
   refuse would move a customer's money onto a card that does not exist.
   Funding posts first: the overdraft guard must decide before anything is sent.
   Terminating calls Bitnob first: a card emptied in our ledger but still live
   at the provider is the worse of the two failures.
4. **An authorization the card cannot cover is rethrown, not acknowledged.**
   Webhooks arrive out of order, so a funding event landing a moment later makes
   the retry succeed on its own. Acknowledging would drop a real spend from the
   books permanently to save some log noise.
5. **The balance a customer sees comes from the ledger, not from Bitnob.** A
   provider figure can lag a settlement by days; reconciliation compares the two
   deliberately, and the ledger is what we owe.
6. **`last4` has a CHECK.** "Just the last four" becomes "the whole number" the
   first time somebody is in a hurry, and then a database dump contains PANs.
7. **A shared invariant database needs resolve-or-create for PLATFORM
   accounts.** `provider_float` has one row per currency for the whole database,
   so the card suite inserting it unconditionally aborted the run once the
   ledger suite had already created it — a unique violation that reads as a card
   bug and is not. Found by running the three SQL suites in CI order rather than
   alone.

**Still operational:** Bitnob card issuing requires their approval before any of
this works against the live provider. The e2e suite drives a stand-in for the
`CardPort`, so everything on our side of the port — ledger entries, the
overdraft guard, signature verification, the replay constraint — is exercised
for real; the provider calls are not.

**Still to confirm before go-live**, unchanged from Phase 3: the webhook
signature header and encoding, and the endpoint paths in `BITNOB_ENDPOINTS`.

## Phase 6 — Bills, eSIM, numbers ✅

VTpass (airtime, data, utilities), Airalo (eSIM), Twilio (virtual numbers) — three
providers behind **one** port, and one purchase flow over all five services. 113
provider unit tests, 11 purchase invariant blocks, 14 end-to-end over HTTP.

| File | What it is |
|---|---|
| `packages/providers/src/ports/fulfilment.ts` | the port all three implement |
| `packages/providers/src/ports/fulfilment.contract.ts` | the suite all three are held to |
| `packages/providers/src/vtpass/vtpass-adapter.ts` | airtime, data, utilities |
| `packages/providers/src/airalo/airalo-adapter.ts` | eSIM |
| `packages/providers/src/twilio/twilio-adapter.ts` | virtual numbers |
| `packages/ledger/sql/004_purchases.sql` | purchases, the outcome trigger, the reconciliation queue |
| `packages/ledger/sql/004_purchases.test.sql` | 11 invariant blocks |
| `apps/api/src/purchases/purchase.service.ts` | reserve → settle or reverse |
| `apps/api/src/purchases/purchase.controller.ts` | catalogue, verify, buy, list |

The money flow, and the reason it is three entries rather than one:

```
Reserve   wallet  -> pending          the overdraft guard decides, BEFORE we order
Settle    pending -> provider_float   it really happened
Reverse   pending -> wallet           it definitely did not — appended, not edited
(neither)                             we do not know; the money stays held
```

**This phase EXTENDS Phase 1's intent model.** `LedgerIntent` gained
`reversesEntryId`, because a purchase that fails is the first flow that has to
undo an entry it posted moments earlier. `journal_entries` already had the column
and the CHECK; the intent had no way to fill it, so a reversal was expressible in
SQL and not in the service that is the only thing allowed to write one.

Findings from building it:

1. **A random reference per attempt is a double charge waiting for a crash.**
   The reserve entry is posted before the purchase row exists, so a process that
   dies in that gap leaves a retry with no row to find. A reference *derived*
   from the customer's key makes that retry reuse the same ledger idempotency
   key, and the ledger answers `replayed: true`. A generated one would charge
   twice — only under a crash, which is the hardest double charge there is to
   reproduce and the easiest to ship.
2. **A customer's idempotency key cannot be globally unique.** Two customers
   will send the same key — a client counting from one is enough — so the
   customer key is unique **per customer** and the provider-facing reference is
   ours. It was one globally unique column until a test made two customers
   collide, and the failure mode was the second customer getting an error with
   their money already reserved.
3. **A timeout settles nothing and reverses nothing.** Reversing would refund a
   purchase that may have been delivered; retrying would buy it twice. The row
   stays `reserved` and `pending_purchases` — an assertion in the invariant
   suite, not a reporting SELECT — is the queue that resolves it. This is the
   same rule as `ProviderTimeoutError` not being retryable, one layer up.
4. **`JSON.stringify` throws on a bigint, and that is the correct behaviour.**
   A catalogue price is minor units; it is mapped to a major-unit string at the
   HTTP boundary. The tempting fix is a global BigInt serialiser, which is how a
   money amount silently becomes a JSON number somewhere else six months later.
5. **A delivery payload is sealed, not stored.** An electricity token is a
   bearer instrument: whoever holds it before it is used can spend it. The CHECK
   on `delivery_sealed` (`^v[0-9]+:`) makes that structural rather than
   customary, so a plaintext token cannot reach a row even by accident.
6. **Three adapters, one contract suite.** Written once and run against all
   three, for the same reason the two rate-limit backends share one: three
   hand-written suites drift into testing three behaviours while all staying
   green, and the entire point of a port is that the caller cannot tell which
   implementation answered.
7. **Verification is an optional capability, not a port method.** VTpass can
   confirm a meter belongs to who the customer thinks; Airalo and Twilio have
   nothing to confirm. Putting `verifyTarget` on the port would give two
   adapters a method that throws, and a caller a reason to catch and ignore it.
   `supportsVerification()` is a type guard, so the compiler knows which is
   which.
8. **One ApiConfig fixture, not three.** Adding the encryption keyring broke
   three hand-written copies at once, which is the mild version. The bad version
   is one suite quietly keeping the old shape and testing a config production
   does not have.

**CONFIRMED against each provider's own SDK or published documentation.** Two
findings changed the code rather than just the comments:

14. **VTpass's `request_id` must carry a Lagos timestamp, and that fights
    determinism.** Their format is `YYYYMMDDHHMM` in Africa/Lagos followed by a
    unique tail. The obvious implementation reads the clock inside the adapter,
    and it is wrong twice over: a retry a minute later becomes a second
    purchase in their eyes, and reconciliation days later requeries an id that
    never existed. `PurchaseRequest` therefore carries `initiatedAt` — the
    purchase row's `created_at` — and the id is a pure function of it. That is
    also why `status()` takes a lookup rather than a bare reference: an adapter
    reconstructing a provider-side id needs both halves.
15. **Airalo signs every body, including the one it sends form-encoded.**
    `airalo-signature` is HMAC-SHA512 over the payload's JSON, keyed by the
    client secret — while the token exchange goes over the wire as
    `application/x-www-form-urlencoded`. Signing the bytes actually sent is the
    natural thing to do and is rejected. The adapter serialises once and signs
    that exact string, so the signature cannot cover a payload that differs
    from the body.

Twilio needed no change: the `2010-04-01` paths and form-encoded Basic auth
were already right.

### The reconciliation worker ✅

Landed after the rest of the phase, closing the one thing it left open: money
held against an outcome nobody would ever look up.

| File | What it is |
|---|---|
| `apps/api/src/purchases/purchase-outcome.ts` | settling and reversing, shared by both callers |
| `apps/api/src/purchases/reconciliation.service.ts` | the sweep, and what it refuses to do |
| `apps/api/src/purchases/reconciliation.e2e.test.ts` | 7 end-to-end, each from a really-held purchase |

A timeout leaves a purchase `reserved`, which is right at that moment and
unacceptable to leave for ever. The sweep asks `FulfilmentPort.status()` and
relays the answer — and that is the whole of its authority.

Findings from building it:

9. **It must never decide an outcome, only relay one.** A worker that reversed
   on age alone would refund delivered electricity tokens on a bad afternoon,
   and the money would be gone in both directions at once. A purchase the
   provider still calls `pending` stays held however old it is; one held past
   `RECONCILE_STALE_SECONDS` is ESCALATED to a person. That is deliberately not
   an automated action, because by then the automated actions have all been
   tried.
10. **An unreachable provider is not a failed purchase.** Treating a refused
    connection as "it did not happen" refunds every delivered purchase during
    an outage. The row keeps its money held and the next sweep asks again.
11. **`SELECT ... FOR UPDATE SKIP LOCKED` protects nothing here.** `pool.query`
    runs each statement in its own implicit transaction, so those row locks are
    released the moment the claim query returns — before a single provider has
    been asked — while reading in review as though they guarded the work that
    follows. Mutual exclusion is a session advisory lock held across the whole
    sweep instead.
12. **Two callers, one settle.** The request handler and the worker resolve
    purchases at opposite ends of the same flow, so both go through
    `PurchaseOutcome`. Two copies of "how a purchase settles" would drift, and
    the copy that drifts is the one that only runs against money nobody is
    watching.
13. **The report counts are lower bounds in the tests, not equalities.** A sweep
    is global by design and resolves whatever an earlier suite left behind, so
    correctness is asserted on the specific purchase and the specific customer's
    balance. A worker whose tests demanded exact global counts would be a worker
    that only works on an empty database.

**Still not built, deliberately:** nothing schedules a sweep unless an operator
sets `RECONCILE_INTERVAL_SECONDS`, and exactly one instance should. The default
is off and bootstrap warns about it, rather than every instance behind a load
balancer sweeping at once.

## Phase 7 — Gift cards ✅ *(ships flagged off)*

Buying gift cards FROM customers, behind `GIFT_CARDS_ENABLED`, which defaults
to false. 17 invariant blocks, 20 end-to-end, 4 guard tests.

| File | What it is |
|---|---|
| `packages/ledger/sql/005_giftcards.sql` | staff roles, rate cards, submissions, the state machine |
| `packages/ledger/sql/005_giftcards.test.sql` | 17 invariant blocks |
| `packages/identity/src/policy.ts` | `staff()` and `staffRouteAudit()` |
| `apps/api/src/auth/staff.service.ts` | who holds a role, read fresh per request |
| `apps/api/src/giftcards/giftcard.service.ts` | quote, submit, review, claw back |
| `apps/api/src/giftcards/hold-release.service.ts` | the sweep that makes held money spendable |

**The shape of this flow is the fraud model.** Everywhere else the customer
gives us money and we give them a thing. Here they give us a THING whose value
we cannot verify at the moment we pay — a code that may already be redeemed,
may be redeemed by the seller minutes later, or may belong to a card bought
with a stolen credit card and voided weeks afterwards. There is no arrangement
in which paying immediately is safe, so:

```
Submit      (nothing)                                an offer, not a transaction
Approve     giftcard_inventory -> customer_pending   paid, and NOT spendable
Release     customer_pending   -> customer_wallet    the hold matured
Claw back   a reversal naming the approval           only while still held
Reject      (nothing)                                no entry ever existed
```

Findings from building it:

1. **A hold needed no new ledger machinery.** `customer_pending` already exists
   and the wallet already reports it as unspendable, so the hold is an ordinary
   posting to an account built in Phase 1 for card authorizations. The flow
   that looked like it needed the most new invariants needed the fewest.
2. **The hold period is enforced by the DATABASE clock, twice.**
   `giftcard_holds_due` selects on `now()` and the state-machine trigger
   refuses a release whose `hold_until` has not passed. A release worker on a
   box with a skewed clock is exactly how a fraudulent card gets cashed out,
   and the hold is the only control still standing once a card is approved.
3. **A clawback is possible only while the money is held.** After release it
   may already be spent, so clawing back would overdraw a customer who did
   nothing wrong. The state machine refuses it with a reason rather than
   letting the overdraft guard refuse it with a constraint violation.
4. **Roles are read fresh, never carried in the token.** A signed access token
   cannot be revoked mid-life, so a role baked into one keeps working for
   fifteen minutes after it is withdrawn — and the moment you most want to
   remove someone's approval rights is the moment you have just found out why.
   Same rule the codebase already applies to `users.status`.
5. **The role is checked BEFORE the PIN.** A customer poking at an admin path
   must not have one of their five PIN attempts spent proving they are not
   staff; that is a way to lock somebody out of their own money from an
   endpoint they were never allowed to call. Asserted, not commented.
6. **`/v1/admin/` is a structural guarantee, not a convention.**
   `route-coverage.test.ts` fails the build if any admin route is declared with
   `authenticated()` instead of `staff()`, and if any staff route lives outside
   that prefix. Forgetting `staff()` would leave an approval endpoint reachable
   by any signed-in customer — authenticated, so not obviously wrong in a diff.
7. **The queue does not carry card codes.** Revealing one is a separate,
   deliberate request against a single submission. A backlog listing that
   returned every code would put a page of bearer instruments into a browser
   tab, a log and a screenshot every time somebody glanced at it.
8. **The rate is the FX.** Gift cards are quoted as "N1,250.00 per USD of face
   value", which is how the Nigerian market actually prices them — so this
   phase needs none of Phase 10's machinery. The rate is a price we set and
   review, not a market quote.
9. **Rate cards are append-only.** Editing one in place silently rewrites the
   price of every past trade, which is noticed only when a customer produces a
   screenshot. Retire and republish; the submission stores the id it was quoted
   against.
10. **"Flagged off" has to mean tested-and-disabled.** Both states are covered
    end to end: a suite boots one app with the flag off and asserts every route
    refuses with `gift_cards_disabled` (while still authenticating — a disabled
    feature must not become an unauthenticated one), and another with it on
    that drives the whole flow. A flag protecting code that has never run is
    not a safety mechanism.

**Before enabling, an operator must:** publish rate cards, grant
`giftcard_reviewer` to real people, set `GIFTCARD_RELEASE_INTERVAL_SECONDS` on
exactly one instance, and set `GIFT_CARD_HOLD_DAYS` deliberately. Bootstrap
warns loudly if the feature is on and nobody is releasing holds — that failure
is silent and slow: customers are paid and can never spend it.

---

## Phase 8 — NGN funding rail ✅ *(Bitnob dedicated virtual accounts)*

**The phase that lets the platform receive money.** Everything before it could
move, spend and reconcile funds that were already in a wallet; nothing put them
there. A customer now gets a dedicated Nigerian account number in their own
name, transfers to it from any bank, and Bitnob tells us. 15 invariant blocks,
25 provider unit tests, 12 end-to-end.

| File | What it is |
|---|---|
| `packages/ledger/sql/006_funding.sql` | virtual accounts, deposits, the suspense path |
| `packages/ledger/sql/006_funding.test.sql` | 15 invariant blocks |
| `packages/providers/src/ports/funding.ts` | the bank-rail port |
| `packages/providers/src/bitnob/ngn-amounts.ts` | the one NGN conversion, and the ceiling |
| `packages/providers/src/bitnob/funding-adapter.ts` | `FundingPort` against Bitnob |
| `packages/providers/src/bitnob/funding-webhooks.ts` | a deposit event into a `LedgerIntent` |
| `apps/api/src/funding/funding.service.ts` | issuing the account, listing deposits |
| `apps/api/src/funding/deposit-webhook.service.ts` | verify, resolve, post |
| `apps/api/src/funding/deposit-reconciliation.service.ts` | the sweep for webhooks that never came |

```
Funding    provider_float -> customer_wallet    the money is now owed to them
Suspense   provider_float -> suspense           it arrived; we cannot say whose
```

`wallet_funding` has existed since Phase 1 and every e2e suite has been
exercising it through a `fund()` helper standing in for exactly this webhook.
So the accounting is not new. What is new is that the money is real.

**No new provider was introduced.** Bitnob was already live for cards, and
`provider_customers` — the KYC mapping built in Phase 5 — is the same table
that gates account issuance here. Rule 0 stays intact: Paystack, Anchor and
ALAT remain out of scope.

Findings from building it:

1. **This is the only webhook that CREATES money.** Every other inbound event
   moves funds already ours to move; this one turns a provider's say-so into a
   spendable balance. That asymmetry is why the amount conversion, the ceiling
   and the suspense path all exist, and why signature verification happens
   before a single byte is parsed.
2. **The amount unit could not be verified, so being wrong was made
   recoverable instead.** `BITNOB_NGN_AMOUNT_UNIT` is a stated deployment value
   (default `kobo`) and `DEPOSIT_CEILING_KOBO` refuses to credit anything above
   it. A factor-of-100 misread on any realistic transfer blows the ceiling, so
   the FIRST wrong deposit is held in suspense rather than spent. That is a
   different and stronger claim than "we checked the docs".
3. **The guard is deliberately asymmetric.** It catches reading an amount too
   LARGE, because that money is spendable before anyone notices. Reading one
   too small is not caught and does not need to be: the customer says "I sent
   more than that" within the hour and a correcting entry fixes it. Guarding
   both ways would mean a floor, and a floor rejects the small deposits that
   are most of the traffic.
4. **An unattributable deposit goes to `suspense`, never nowhere.** The money
   arrived whatever we can work out about it, and dropping the event because it
   matched no account is how a real transfer disappears from a real person's
   life. `suspense` has existed since Phase 1 for exactly this.
5. **A lost webhook is the failure a bank rail cannot otherwise detect.** The
   customer transferred, the provider recorded it, the webhook never came — and
   nothing is retrying, so waiting does not help. The sweep ASKS, and posts
   under the SAME idempotency key the webhook would have used, so a late
   delivery is a replay rather than a second credit.
6. **`ON CONFLICT` cannot target an EXCLUDE constraint.** "One live account per
   customer" was written as an exclusion constraint and the issuing path could
   not use it — two racing requests got an error instead of the loser reading
   the winner's row, on the one request a customer makes when they are trying
   to give us money. A partial UNIQUE INDEX supports both.
7. **A dedicated account number is permanent, so its row is immutable.** A
   customer saves it as a bank beneficiary and pays into it for years. Changing
   the owner or the number would silently redirect money, including transfers
   in flight during the UPDATE.
8. **Issuing an account is gated on KYC, not on asking.** `provider_customers`
   must already exist — the same rule Phase 5 applies to cards. A Nigerian bank
   account cannot be issued to an unidentified person, and registering somebody
   as a side effect of tapping "add money" would hide a regulatory step behind
   a convenience.
9. **A forged webhook answers 401, not 500.** A 500 pages somebody over a
   stranger's probe and tells the sender we are broken rather than that they
   are unauthorised. Found by booting the built bundle and curling it, not by a
   test.

**Before taking real deposits, an operator must:** set `BITNOB_BASE_URL`,
`BITNOB_API_KEY` and `BITNOB_WEBHOOK_SECRET`; set `DEPOSIT_CEILING_KOBO`
deliberately; set `DEPOSIT_RECONCILE_INTERVAL_SECONDS` on exactly one instance;
and confirm `BITNOB_NGN_AMOUNT_UNIT` against the first real deposit — which,
if wrong, will be sitting in suspense rather than in somebody's balance.

---

## Phase 9 — Crypto: USDT, stablecoins, on-chain

Bitnob. Deposits, withdrawals, and the `crypto_deposit` / `crypto_withdrawal`
entry kinds that already exist in `001_ledger.sql` and have never been written.

Blocked with Phase 5 on the same dependency: Bitnob registration is under
review.

---

## Phase 10 — Multi-currency and FX / remittance

Bitnob. The `fx_trade` entry kind and `revenue_fx_spread` account exist and are
unused. The ledger was built multi-currency from Phase 1 precisely so this phase
adds a flow rather than a migration — the per-currency balance invariant is
already the thing that makes an FX entry safe.

Also blocked on Bitnob.

---

## Phase 11 — The customer-facing clients

`apps/mobile` (Expo, iOS + Android) and `apps/web` (Next.js) are in the
documented layout and do not exist. Everything shipped so far is an HTTP API
with no user in front of it.

---

## Deployment

Coolify (self-hosted, Apache-2.0) on Hetzner, Cloudflare free tier in front, GitHub
Actions for CI, EAS for mobile builds.

A single box is fine to start and is **not** an acceptable production topology for
a licensed fintech. Split app and database onto separate nodes with streaming
replication before taking real deposit volume.
