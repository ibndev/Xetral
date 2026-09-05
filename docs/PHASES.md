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
| 9 — Crypto / USDT / stablecoin | ✅ | Bitnob credentials to go live |
| 10 — Multi-currency + FX / remittance | ✅ | Bitnob credentials to go live |
| 11 — Mobile and web clients | ✅ | |
| 12 — Pre-deployment audit | ✅ | Bitnob credentials to go live |
| 13 — Closing the audit's findings | ✅ | all four tiers landed |
| 14 — Bitnob v2, and paying a bank | ✅ | Bitnob credentials to go live |
| 15 — Funding without KYC, KYC before a card | ✅ | Paystack credentials to go live |
| 16 — One identifier, a code to get back in, a price that keeps itself | ✅ | ExchangeRate-API key to go live |

All eleven phases are built, a **pre-deployment audit** (Phase 12) closed what
building them phase by phase had left between the phases, and **Phase 13** is
working through what that audit found, in the order the findings would cost
money — all four tiers are now closed. Every money flow
has an HTTP surface, a customer screen and an operations screen in front of it;
Bitnob's live credentials are the only thing between the card, crypto and FX
flows and production traffic.

---

---

## Before it takes real money

Each phase below ends with its own **"an operator must"** paragraph. Those are
kept as the record of why each item exists — but the operational list is now
one thing, in one place, and it is checked by the build:

- **`deploy/GO-LIVE.md`** — what the categories mean and what order to work in.
- **`apps/api/src/golive/go-live-checklist.ts`** — the list itself, as data.
  `go-live.test.ts` fails the build if it and the code disagree in either
  direction.
- **`GET /v1/admin/readiness`** — the same list asked of a running deployment.


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

## Phase 9 — Crypto: USDT, stablecoins, on-chain ✅

Deposit addresses, two-phase confirmed deposits, and irreversible withdrawals.
19 invariant blocks, 34 provider unit tests, 18 end-to-end.

| File | What it is |
|---|---|
| `packages/ledger/sql/007_crypto.sql` | addresses, deposits, withdrawals, both state machines |
| `packages/ledger/sql/007_crypto.test.sql` | 19 invariant blocks |
| `packages/providers/src/ports/crypto.ts` | the on-chain port |
| `packages/providers/src/crypto/address.ts` | address validation, with checksums |
| `packages/providers/src/bitnob/crypto-adapter.ts` | `CryptoPort` against Bitnob |
| `packages/providers/src/bitnob/crypto-webhooks.ts` | on-chain events into `LedgerIntent`s |
| `apps/api/src/crypto/crypto.service.ts` | addresses, quotes, withdrawals |
| `apps/api/src/crypto/crypto-webhook.service.ts` | seen, then confirmed |
| `apps/api/src/crypto/crypto-reconciliation.service.ts` | withdrawals nobody answered for |

**This phase needed no new entry kinds.** `crypto_deposit` and
`crypto_withdrawal` have been in `001_ledger.sql` since Phase 1, and the
two-phase shape is the one Phase 5 built for card authorizations. The ledger
was designed for this in Phase 1 and the design held.

```
Deposit seen        provider_float   -> customer_pending    visible, not spendable
Deposit confirmed   customer_pending -> customer_wallet     final
Withdrawal reserved customer_wallet  -> customer_pending    the guard decides
Withdrawal sent     customer_pending -> provider_float      on a chain, unrecallable
Withdrawal failed   a reversal naming the reservation       it never left
```

Findings from building it:

1. **A deposit is not final when first seen, so it is not spendable when first
   seen.** One confirmation can be reorganised away, and a customer who
   withdrew against it would have spent money that stopped having happened.
   `customer_pending` — built in Phase 1 for card authorizations — was already
   exactly the right account, and the confirmation threshold is checked by the
   database so a service with a stale config cannot lower it.
2. **The threshold is stored per deposit row, not read from config at
   confirmation time.** Raising it later must not retroactively un-confirm
   money already credited and possibly spent.
3. **The confirmation threshold has to be per chain.** A Bitcoin block is ten
   minutes and a Tron block is three seconds; one global number would either
   make Bitcoin deposits unusable or Tron deposits unsafe.
4. **Address validation is the only control that prevents an irreversible
   mistake**, and shape checks are not enough. Every format here is verified by
   its CHECKSUM — Base58Check for Tron and legacy Bitcoin, bech32 for SegWit,
   EIP-55 for Ethereum and BSC — because that is what turns a single transposed
   character from a lost balance into a rejected request.
5. **Do not hand-roll a hash in a codebase that moves money.** The first
   Keccak-256 here was written by hand; it produced plausible digests and every
   known-answer vector rejected it. Replaced with `@noble/hashes`. Node's
   built-in `sha3-256` is NOT the same function — it uses the standardised
   padding — and would have silently broken every EIP-55 check.
6. **A fee ceiling is part of consent.** Network fees move between the quote
   and the request, so `max_fee` lets a customer say what they agreed to and
   the request is refused rather than silently costing more.
7. **An unrecognised provider status throws rather than defaulting.**
   Defaulting to `failed` would reverse a withdrawal that is on a chain;
   defaulting to `broadcast` would tell a customer money left when it did not.
   Neither is a safe guess.
8. **A crypto deposit to an unknown address cannot go to suspense**, unlike a
   naira one. An address we did not issue is not ours, so the money is not ours
   and recording it would invent a liability. The event throws and is retried.
9. **The two phases carry different idempotency keys derived from one event.**
   Without the suffix the confirmation would replay the seen entry and the
   money would never become spendable.
10. **`@noble/hashes/sha3` does not resolve under native ESM** — the
    extensionless specifier is CommonJS-only, so it compiles and fails at
    import. The same trap `@nestjs/common/constants` set in Phase 2, and the
    same fix: use the `.js` specifier.

**Before going live, an operator must:** set `BITNOB_BASE_URL` and
`BITNOB_API_KEY`; set `CRYPTO_RECONCILE_INTERVAL_SECONDS` on exactly one
instance; and review `CRYPTO_CONFIRMATIONS_*` per chain — the defaults are
deliberately conservative, and lowering one is a decision about how much reorg
risk to accept.

**CONFIRM BEFORE GO-LIVE:** the endpoint paths in `BITNOB_CRYPTO_ENDPOINTS` and
the event names in `BITNOB_CRYPTO_EVENTS`, which resolve with the same Bitnob
approval that gates cards. An unrecognised event throws and is retried, so a
wrong name is loud rather than a dropped deposit.

---

## Phase 10 — Multi-currency and FX / remittance ✅

Converting between currencies, and sending across them. 12 invariant blocks,
14 rate-math unit tests, 17 end-to-end.

| File | What it is |
|---|---|
| `packages/ledger/sql/008_fx.sql` | spread policies, executed trades |
| `packages/ledger/sql/008_fx.test.sql` | 12 invariant blocks |
| `packages/providers/src/ports/fx.ts` | the FX port |
| `packages/providers/src/fx/rate-math.ts` | the one place a rate is applied |
| `packages/providers/src/bitnob/fx-adapter.ts` | `FxPort` against Bitnob |
| `apps/api/src/fx/fx.service.ts` | quote, convert, remit |

**This phase added a flow, not a migration** — exactly as Phase 1 predicted.
`fx_trade` and `revenue_fx_spread` have been in the schema since then, and the
balance invariant has been PER CURRENCY since then, which is the thing that
makes a two-currency entry safe:

```
NGN legs:  wallet -X,  provider_float +(X - spread),  revenue_fx_spread +spread
USD legs:  provider_float -Y,  wallet +Y
```

Findings from building it:

1. **A rate is a RATIO, not a decimal.** `quoteMinor = baseMinor * numerator /
   denominator`, both integers. "Minor units per major unit" — which is how the
   gift card rate card works — is fine for USD to NGN and collapses in the
   other direction, where one kobo is 0.0006 cents and any per-major integer
   rounds to zero.
2. **The per-currency balance invariant earns its keep here.** Test 2 posts an
   entry that is +1,000 kobo and −1,000 cents: a whole-entry sum is exactly
   zero and it would commit, crediting ten dollars from nowhere. This is the
   case Phase 1 finding 1 described, and this is the flow it was guarding.
3. **A test can pass for the wrong reason, and only a specific assertion
   catches it.** That same block was green while never reaching the balance
   check — it was failing on the overdraft guard, because an earlier block had
   spent the customer's naira. Tightening the handler from `WHEN OTHERS` to
   "and the message must say `unbalanced journal entry`" turned a
   green-and-meaningless test into a real one.
4. **`Money` invariance bites helpers that look like they only read numbers.**
   `convertWithSpread(amount: Money<Currency>, …)` compiles and then rejects
   every caller, because a bare `Money` is the union. It has to be generic.
   CLAUDE.md records this rule; the code still walked into it, which is why the
   rule is written down.
5. **The spread comes off the base amount, before conversion.** That makes it
   revenue in the base currency and keeps each currency balanced without a
   cross-currency fudge leg.
6. **Both roundings are stated, and they favour opposite parties.** The spread
   rounds DOWN (the customer keeps the fraction); the conversion rounds DOWN
   (we do). Netting them into one number would hide both.
7. **A remittance is ONE entry, not a conversion plus a transfer.** Two entries
   would leave a window in which the money sits in a wallet the sender never
   meant to hold it in, and a crash in that window strands it there.
8. **Believe the fill, not the quote.** If the provider delivers less than
   quoted, the customer receives what was delivered. Crediting the quote would
   pay the difference out of the float, silently, on every partial fill.
9. **A timed-out swap records nothing.** We do not know whether it happened;
   posting would risk crediting twice on retry. The derived reference makes the
   retry idempotent at the provider instead — the one place where doing nothing
   is the safe move rather than holding money.
10. **Shared invariant databases collide on names, not just on ids.** These
    keys are prefixed `p10:` because `001_ledger.test.sql` has used
    `test:fx-1` for its own FX test since Phase 1, and the unprefixed name
    aborted this whole file on its first block in CI order.

**Before going live, an operator must:** set `BITNOB_BASE_URL` and
`BITNOB_API_KEY`, and publish an `fx_spread_policies` row per pair and
direction. There is no default spread and no default minimum: an unpublished
pair is refused rather than quoted from a number nobody reviewed.

**CONFIRM BEFORE GO-LIVE:** the paths in `BITNOB_FX_ENDPOINTS`, with the rest
of the Bitnob surface.

---

## Phase 11 — The customer-facing clients ✅

`apps/web` (Next.js) and `apps/mobile` (Expo), over one shared, tested client
package. 34 client unit tests.

| File | What it is |
|---|---|
| `packages/client/src/session.ts` | tokens, and single-flight refresh |
| `packages/client/src/money.ts` | money as strings, formatted without a float |
| `packages/client/src/client.ts` | the typed HTTP surface |
| `packages/client/src/errors.ts` | API codes as a union a caller can switch on |
| `apps/web/src/app/api/auth/*` | the BFF that keeps the refresh token out of the browser |
| `apps/mobile/src/session.ts` | tokens in the Keychain and Keystore |

**The clients carry two obligations the backend deliberately handed them**, and
both are named in earlier phases rather than invented here.

1. **Single-flight refresh.** Phase 2 chose to revoke a whole device family on
   a replayed refresh token, and recorded that the cost — a client racing its
   own refresh signs itself out — "is a client bug to fix with single-flight,
   never a reason to weaken the check". `Session.refresh()` is that fix: one
   in-flight rotation, every other caller awaiting the same promise. A screen
   firing four requests on mount is the ordinary case, and without the latch it
   would sign the customer out for opening a page.
2. **Money stays a string.** The API sends major units as decimal strings
   precisely so no float is involved. `formatAmount` groups digits without ever
   producing a number, and there is deliberately no `toNumber` for somebody to
   reach for. A test formats an eight-decimal BTC balance and a value past
   `MAX_SAFE_INTEGER`, which is where `Intl.NumberFormat` would start lying —
   in the digits a customer reads to decide whether they have been paid.

Findings from building it:

1. **Where a refresh token lives is a per-platform security decision, so it is
   a port.** `TokenStore` has two implementations and neither is a default:
   the web keeps the refresh token in an **httpOnly, SameSite=strict cookie**
   set by the app's own route handlers, so page JavaScript cannot read it;
   mobile keeps it in the **Keychain/Keystore** via SecureStore, marked
   `WHEN_UNLOCKED_THIS_DEVICE_ONLY` so a restored backup cannot resurrect a
   session on hardware the customer no longer owns. `localStorage` and
   `AsyncStorage` are wrong on both platforms and for the same reason.
2. **The web app proxies the API rather than calling it cross-origin.** No CORS
   policy to get subtly wrong, and the API's address is never published to the
   page — so a later change cannot quietly start calling it directly and skip
   the cookie handling.
3. **The session must be a singleton.** The single-flight latch lives on the
   instance, so a component constructing its own would refresh in parallel with
   everybody else's — the exact race the latch exists to prevent.
4. **An idempotency key belongs to the ATTEMPT, not the submit handler.** Both
   clients generate it when the form mounts and reuse it across retries.
   Generating it inside the handler defeats the guard entirely, and a phone on
   a patchy connection is where double-sends actually happen.
5. **`network` is our error code, not the server's.** Routing it through the
   response parser made it fall through to `unknown`, so a dropped connection
   read as a server fault. "Insufficient funds" and "your train went into a
   tunnel" need very different words on screen.
6. **A client must not widen the server's error union.** An unrecognised code
   becomes `unknown` rather than being passed through, so a proxy or an error
   page cannot inject something a caller's `switch` would then handle as if we
   had sent it.
7. **Both bundlers resolve `.js` specifiers literally.** The repo imports that
   way because native ESM requires it; Next needs `resolve.extensionAlias` and
   Metro needs a `resolveRequest` hook. Changing the imports instead would
   break Node — the same shape as the `@nestjs/common/constants` and
   `@noble/hashes/sha3` traps.
8. **React 18 and React 19 coexist by nesting.** Next 15 wants 19 and React
   Native 0.76 wants 18.3.1; npm hoists one and nests the other, which works
   and is worth knowing before somebody "fixes" the duplicate.

**Verified end to end against the running API**: sign-in through the BFF sets
an `HttpOnly; SameSite=strict; Secure` cookie and returns a body containing
**no refresh token**; a refresh rotates the cookie and returns only an access
token; and replaying the previous cookie answers `401 invalid_grant` — Phase
2's reuse detection firing through the whole web stack.

### Biometric unlock ✅

Landed after the rest of the phase.

| File | What it is |
|---|---|
| `apps/mobile/src/biometrics.ts` | the Keychain gate, and what it will not do |
| `apps/mobile/app/security.tsx` | enrolling, which confirms the PIN first |
| `apps/api/src/auth/auth.controller.ts` | `POST /v1/auth/pin/verify` |

**Face ID unlocks the PIN. It does not replace it**, and the implementation is
shaped entirely by that sentence — which `002_identity.sql` has enforced from
the other side since Phase 2, by a trigger that refuses enrolment for a user
with no PIN.

The customer's real transaction PIN is stored in the Keychain behind
`requireAuthentication: true`, so the OS refuses to return it without a face, a
finger or the device passcode. A successful scan hands the PIN back and the app
sends it to the server exactly as if it had been typed. **The server is
unchanged**: it verifies a scrypt hash and counts a wrong PIN toward the
five-attempt lockout. There is no endpoint anywhere that accepts "the user
passed Face ID" in place of a PIN.

1. **A new endpoint exists so enrolment cannot store a WRONG PIN.**
   `POST /v1/auth/pin/verify` declares `pin: true`, so `AuthGuard` does the
   verifying and the handler is empty — reaching the body *is* the answer.
   Without it, a mistyped PIN is discovered on a real transfer, which spends
   one of the customer's five attempts on a request they never intended.
2. **The gate is the OS's, not ours.** `expo-local-authentication` reports what
   the device supports; the actual refusal comes from the Keychain declining to
   return the value. The app never sees biometric data, only whether the
   Keychain agreed.
3. **A cancelled scan sends nothing.** Customers dismiss the sheet to type the
   PIN instead, and every screen keeps manual entry available. Falling back to
   "send it anyway" would be a payment nobody approved.
4. **Signing out forgets the stored PIN.** Leaving it means a face on that
   phone still unlocks the PIN of an account nobody is signed in to — which is
   precisely the case a customer handing over their device was guarding
   against.

**Not built, and deliberately:** the mobile app has not been run on a simulator
or a device from here, so it is typechecked and configured rather than
demonstrated. Biometrics in particular cannot be exercised without hardware.

---

## Deployment

Configuration lives in [`deploy/`](../deploy). Coolify (self-hosted, Apache-2.0)
on Hetzner, Cloudflare in front, GitHub Actions for CI, EAS for mobile builds.

**Three nodes, not one**: `app`, `db-primary`, `db-standby`, on a private
network, with only `app` publicly addressable and streaming replication between
the two databases.

That used to be a warning in this file rather than a configuration, and the
warning was the weaker thing. A single box means a single disk failure ends the
records of a business holding customer deposits; it means an out-of-memory
application process competes with Postgres and the OOM killer picks; and it
means the database is one firewall mistake from the public internet.

`deploy/` contains the compose files for each node, a primary config whose every
setting is a decision rather than a copied number, `pg_hba.conf` with no `trust`
line and no `0.0.0.0/0`, a script that turns a fresh node into a streaming
standby, and a promotion script that refuses to run until the operator has
confirmed the old primary is stopped — because two databases that both accept
writes give two divergent sets of postings and no way afterwards to say which is
the real ledger.

Replication is not backup. `deploy/standby/backup.sh` takes nightly base
backups, because a mistaken `DELETE` replicates to the standby faithfully in
under a second.

---

## Phase 12 — The pre-deployment audit ✅

Not a feature. A full read of the codebase before first deployment, then a
full RUN of it — and the second half found things the first could not.

| File | What it is |
|---|---|
| `docs/AUDIT.md` | every finding, ordered by what it costs |
| `packages/ledger/sql/009_admin.sql` | settings, audit log, KYC, status changes, the work-queue views |
| `packages/ledger/sql/009_admin.seed.sql` | the defaults, all in the safe direction |
| `packages/ledger/sql/009_admin.test.sql` | 15 invariant blocks |
| `apps/api/src/settings/settings.service.ts` | database-backed policy, 30s cache, env fallback |
| `apps/api/src/kyc/kyc.service.ts` | submit, review, and the provider mapping approval creates |
| `apps/api/src/admin/` | the operations surface and its audit trail |
| `apps/api/src/health/health.controller.ts` | liveness and readiness |
| `apps/api/src/wallet/spending-limits.service.ts` | the daily ceiling, as a ledger precondition |
| `apps/web/src/app/admin/` | eight operations screens |
| `apps/web/src/app/{signup,kyc,cards,bills,fx,crypto,settings}/` | the six customer flows that had no way in |

**Five things blocked operation entirely**, and the second is the one that
mattered most: nothing anywhere wrote `provider_customers`, and cards and
virtual accounts both refuse until that row exists — so every customer was
permanently `kyc_required` with no path out. There was also no way to become a
customer (no registration endpoint), no way to set `users.status` (so `frozen`
was a column no code could write), no exit from `suspense`, and no liveness or
readiness endpoint.

Findings from the reading pass:

1. **Tests that seed their fixtures cannot see a missing endpoint.** Every
   suite created users with an `INSERT`, so none of them noticed there was no
   way to register. The new e2e suite goes through the endpoint deliberately.
2. **Operational parameters were deploy-time constants**, so changing a fee was
   a release and turning a feature off during an incident was a release under
   pressure. They are rows now, with bounds enforced by CHECKs — a 15% fee
   typed where basis points were meant is refused whether it arrives through
   the dashboard or through psql.
3. **The database being authoritative fails silently in the other direction.**
   Somebody sets `TRANSFER_FEE_BASIS_POINTS`, restarts, and watches nothing
   happen. Bootstrap now names every environment value being overridden.
4. **Gift cards need both switches.** Everything else the database decides
   alone; the one flow that pays out against an unverifiable bearer instrument
   takes a deployment change AND an operator action, and either being off means
   off.
5. **A daily limit cannot be a plain pre-check** — two transfers arriving
   together each find room and both post. It runs as a `precondition` inside
   the ledger's own transaction, holding a per-customer advisory lock. Ten
   concurrent callers against a ₦1,000 ceiling let five through; with the lock
   removed all ten pass.
6. **Its first shape deadlocked the connection pool.** It held a pool
   connection across a call that needed another one, so `pool.max` concurrent
   transfers wedge the API. Ten callers against a pool of eight found it.
   Nothing else would have, until production.
7. **A replay must skip the limit**, or a customer whose request timed out is
   told they hit a ceiling for a transfer that in fact succeeded.
8. **The client named 18 of the 70 error codes the API emits**, so a weak
   password or a frozen card read as "Something went wrong. Please try again."
   The union and its recognition set are one list now, with a test scanning the
   API source in both directions.

### Then it was run, and that found eight more ✅

Every one invisible to the compiler, to the unit suites and to the e2e suites
as they stood. The full list is in `docs/AUDIT.md`; four are worth repeating
here because they are about how this codebase is tested, not about what it
does:

9. **Three controllers were imported and never mounted.** Health, KYC and the
   entire admin surface were absent from `app.module.ts`'s `controllers` array,
   so every one of their routes answered 404 in the built bundle — while
   `route-coverage.test.ts` reported full coverage, because it walked its own
   hand-written list. *The coverage test contained the exact failure it exists
   to prevent.* It reads the list off the module now.
10. **Freezing an account raised every time.** `UPDATE sessions` against a
    table called `auth_sessions` — and the right name alone would still have
    failed the `revocation_is_complete` CHECK. A SQL string is invisible to
    TypeScript, and no unit test can hold an opinion about one either.
11. **Setting a transaction PIN returned 500 on the web.** The proxy answered
    every upstream 204 with a JSON body, which is a body on a status that
    forbids one. No web customer could set a PIN, and without a PIN they cannot
    move money at all.
12. **The browser token store replayed its own refresh token.** `Session`'s
    single-flight latch is real, correct, and on the wrong function: on a fresh
    load every caller of `read()` exchanged the cookie. Two components mounting
    signed the customer out for opening a page — the precise cost Phase 2
    accepted and assigned to the client to fix, reintroduced one layer below
    where the fix was put.

**What changed as a result:** CI boots both bundles and probes them. The API
must mount health, admin and KYC, answer 401 on a guarded route, and answer 401
rather than 500 to three forged webhooks. The web app is served and its HTML
read — every `<script>` must carry the CSP nonce, because a page whose scripts
the browser refuses renders perfectly and does nothing.

Verified by driving the built stack in Chromium: register, submit identity, set
a PIN, read a balance; then as staff, approve that identity and watch
`provider_customers` gain a row, change the transfer fee and watch its history
record 0 → 125, and find both in the audit log.

**Before taking real traffic, an operator must:** grant `admin` to a real
person (the first grant has no `admin` to make it, so it is an `INSERT`), then
grant the narrower roles through the dashboard; review every row in
`platform_settings`; and set the four worker intervals on exactly one instance.

---

## Phase 13 — Closing the audit's findings ✅

Not a feature. The pre-deployment audit produced a list; this is that list
being worked through, sequenced by what each gap would cost rather than by
what it would take to build.

### Tier 1 — the holes that were open right now ✅

| File | What it is |
|---|---|
| `packages/ledger/sql/011_ledger_immutability.sql` | the append-only rule, finally enforced |
| `apps/api/src/settings/kill-switches.test.ts` | proof that a switch does something |
| `apps/api/src/crypto/crypto-deposit-reconciliation.service.ts` | the sweep deposits never had |
| `deploy/docker-compose.app.yml` | the workers, on one instance |

1. **`001_ledger.sql` has said "no UPDATE, no DELETE, ever" in a comment since
   Phase 1, and nothing enforced it.** The audit ran the UPDATE against a live
   database and moved ₦5,000 into a wallet out of nowhere. `apply_posting_to_balance`
   fires on INSERT only, so the materialised balance did not follow and the
   books silently disagreed with themselves. Every OTHER append-only rule in
   this schema had a trigger; the ledger was the one relying on convention.
2. **`crypto_enabled` and `fx_enabled` were rows nothing read.** An operator
   could switch crypto off during a provider incident, watch the dashboard
   confirm it, and withdrawals would keep going out. Worse than no switch,
   because it is trusted exactly when it matters. Nothing in the type system
   catches an unused accessor, so a scanner test does.
3. **Withdrawals had a reconciliation sweep from the day they shipped and
   deposits did not.** A lost deposit webhook was money on a chain that would
   never reach a balance, with nothing retrying.
4. **And a double credit, found on the way.** The funding webhook keyed its
   idempotency on `event_id` — which identifies a DELIVERY — while the
   reconciliation sweep only ever learns `data.id`, which identifies the
   MONEY. A sweep beating a delayed redelivery credited the customer twice.
   An existing test claimed to cover this and passed: its "late webhook" had
   no `account_number`, so it resolved to no owner and landed in suspense.
   Both paths key on `data.id` now.

### Tier 2 — the platform could not be operated without these ✅

| File | What it is |
|---|---|
| `packages/providers/src/ports/notification.ts` | the email port, and the retry rule it inverts |
| `packages/identity/sql/012_notifications.sql` | the outbox, sealed and append-only |
| `packages/identity/sql/013_password_reset.sql` | the way back into an account |
| `packages/identity/src/totp.ts` | RFC 6238, against its own vectors |
| `packages/identity/sql/014_staff_totp.sql` | the second factor, and the replay guard |
| `packages/ledger/sql/015_error_events.sql` | knowing something is broken |
| `deploy/standby/verify-restore.sql` | proof that a backup is a ledger |

**There was no email of any kind.** No provider, no port, no template — and
therefore no password reset, so a customer who forgot their password had no
route back to their money at all. That is the gap the whole tier hangs off.

Findings from building it:

1. **A transactional outbox, because email is both the least reliable
   component and the carrier of the most dangerous credential.** Sending inside
   the transaction mails receipts for money that then rolls back; sending after
   it loses messages when the process dies in the gap. A row written in the
   same transaction has neither problem.
2. **The outbox would otherwise be a list of live account-takeover links.** A
   rendered reset email contains a bearer token, so the body is sealed under
   the same `^v[0-9]+:` CHECK that guards electricity tokens — and a DELIVERED
   message has its body erased.
3. **One rule is inverted for this port alone: a notification timeout IS
   retryable.** Everywhere else a timeout means do nothing and reconcile,
   because we cannot tell whether the provider acted. Here, not sending is
   worse than sending twice.
4. **`enqueueBestEffort` needs a SAVEPOINT, not a try/catch.** Any error inside
   a Postgres transaction poisons it, so the obvious "a receipt is worth less
   than the transfer" implementation takes the transfer down with it.
5. **`available` is not `deliverable`, and only booting found it.** With a
   keyring but no provider, enqueueing succeeds and nothing drains it — so
   `/password/forgot` answered 204 and told a locked-out customer to check an
   inbox nothing would reach.
6. **TOTP is hand-written, which is allowed here and was not for Keccak.** The
   rule is never write the primitive and never trust an implementation no
   published vector has judged; RFC 6238 ships six vectors and the suite runs
   all of them.
7. **Demanding a fresh code per action is unusable, and the tests are what
   showed it.** Codes are single-use and change every thirty seconds, so a
   reviewer working a queue is refused on their second approval — and the
   predictable outcome is a shared authenticator on somebody's desk, which is
   worse than no second factor because it looks like control. A verified code
   elevates the SESSION for ten minutes; the PIN is still required throughout.
8. **`claims.sub` is a UUID and the new queries cast it to bigint**, so the
   entire staff surface answered 500. A SQL string is invisible to TypeScript —
   the same shape as the freeze that wrote to a table called `sessions`.
9. **The TypeScript union and the Postgres enum drifted, and only an insert
   proved it.** `operations_alert` typechecked, passed every unit test, and
   failed on the first real enqueue. Phase 3's finding about `EntryKind`, in a
   new place; there is a test that writes every declared kind now.
10. **Sixteen guard tests were SKIPPING rather than failing.** The guard gained
    a dependency the probe module did not provide, `beforeAll` threw, and
    vitest reported the suite as skipped. A green summary line with a smaller
    number in it.
11. **A backup nobody has restored is a hope with a cron entry.** The drill was
    run for real — a genuine base backup, encrypted, decrypted, recovered into
    a live instance — and then deliberately broken. With one posting deleted,
    every structural check still passed: "204 entries, 423 postings" reads as
    entirely plausible. Only the per-currency balance check caught it.
12. **`pg_basebackup` does not copy the configuration on a Debian layout**,
    because it lives outside PGDATA. The restore fails with an error that reads
    like a corrupt archive. Worth knowing before an incident rather than during
    one.

### Tier 3 — the product did not work, and nowhere was safe to find out ✅

| File | What it is |
|---|---|
| `packages/providers/src/ports/card.ts` | `CardSecrets`, deliberately not part of a card |
| `packages/ledger/sql/016_card_reveals.sql` | that a reveal happened, never what it showed |
| `apps/api/src/cards/card.service.ts` | the two ceilings, counted in rows |
| `apps/api/src/config.ts` | the environment, and what staging refuses |
| `apps/api/src/environment.test.ts` | the refusals, as tests |
| `deploy/docker-compose.staging.yml` | one box, sandbox providers, no route to anything real |

**Every virtual card issued since Phase 5 was unusable.** `003_cards.sql`
stores `last4` and an expiry and nothing else — correctly, because a database
dump must not contain PANs — with the consequence that there was no way for a
customer to see the number: no port method, no endpoint, nothing to call. A
card you cannot read is not a product.

Findings from building it:

1. **The reveal is a PASS-THROUGH, and every other decision follows from
   that.** Fetched from the provider, handed to a customer who proved a PIN,
   and dropped. "Never stored" is a property of the schema rather than a rule
   somebody keeps: there is no column that could hold a card number, and the
   test asserts `card_reveals` has none whose name could tempt anybody.
2. **`CardSecrets` is a separate type from `VirtualCard` at every layer.** As
   optional members of the ordinary card view, a PAN would ride along in every
   listing, every cached response and every log line that serialises a card —
   and nothing would fail on the day it did. Two types means a card number
   only reaches code that named it.
3. **The rate limit is counted in ROWS, not in memory.** An attacker's loop
   outlives a pod restart and an in-process counter does not. There are two
   ceilings because they catch different things: per card, and per customer —
   the second is what sees a stolen session walking through every card on an
   account, which a per-card limit never does. Both were proved load-bearing
   by removing them and watching the test fail.
4. **A frozen card can still be revealed; a terminated one cannot.** Freezing
   stops spending, not looking — a customer disputing charges still needs to
   read the number. A terminated card's number is dead at the provider.
5. **Bitnob's card response shape was not what the adapter required, and only
   a probe found it.** Their SDK reads `cardNumber`, `cvv2` and a single
   `expiry`; the schema here demanded `last4`, `expiry_month` and
   `expiry_year`, and an SDK-shaped payload threw `unexpected card shape`.
   The read accepts both now. Being tolerant on a read costs nothing; being
   wrong costs every card. Phase 3's lesson again — a table of plausible
   constants passes tests written from the same assumptions.
6. **A staging environment whose only protection is "we set different
   variables" is one variable away from test traffic moving real money.** Both
   protections here are REFUSALS. `XETRAL_ENVIRONMENT` is required with no
   default, and when it says `staging` the API exits at boot if any provider
   URL points at a live host, naming every offender at once so three mistakes
   are not three deploys. Verified against the built bundle both ways.
7. **The second refusal is about email, and it is the one a restored backup
   makes urgent.** A staging database is usually restored from production,
   because that is the only way to test against realistic data — and the
   moment it is, the outbox worker holds every real customer's address and a
   queue of messages about transfers that never happened. It will send them,
   and it cannot be un-sent. Delivery is confined to `NOTIFICATION_ALLOWLIST`,
   which is EMPTY by default, and a message to anyone else is ABANDONED rather
   than retried: the address will not become allowed by waiting.
8. **A test can fail for the harness rather than the product, and both are
   worth fixing.** The staging e2e suite minted a fresh keyring per app, so
   the staging worker could not open what the main app had sealed — while the
   two negative tests passed, because the allowlist check runs before
   decryption. A green pair either side of a broken one.

### Tier 4 — the gaps that were nobody's emergency ✅

| File | What it is |
|---|---|
| `apps/api/src/auth/request-rate-limit.service.ts` | a ceiling on every route, derived not declared |
| `apps/web/src/lib/forwarded.ts` | the header without which every web customer is one client |
| `packages/ledger/sql/017_transfer_velocity.sql` | what an account takeover looks like |
| `packages/ledger/sql/018_disputes.sql` | somewhere to say "I did not do this" |
| `packages/ledger/sql/019_retention.sql` | the only job here whose purpose is deletion |
| `apps/web/src/app/legal/` | the notice, rendered from the schema |
| `.github/dependabot.yml` | knowing about a package before the news does |

Nothing here was on fire, which is why it was last. Each item is a control the
platform was operating without and would have missed on a specific bad day.

Findings from building it:

1. **Only three endpoints had a rate limit, and the limit on one of them was a
   denial of service against our own customers.** Login, registration and
   password reset were capped; every other route — history, card details,
   transfers — was unbounded, so a stolen session could read an account as fast
   as the network allowed. Worse, the web app reached the API over a
   server-side `fetch` and forwarded no client address, so its per-IP bucket
   was ONE bucket for every web customer at once. Probed against the built
   bundle: three logins with three different `x-forwarded-for` values each got
   their own bucket; three carrying none — what the app was sending — shared
   one, and the third was refused. At the production default the thirty-first
   sign-in from the whole web app in any fifteen minutes was being turned away.
2. **The rate class is DERIVED from the policy, not declared per route**, and
   the asymmetry is the argument. A forgotten authorisation declaration gives a
   403 somebody fixes that morning; a forgotten rate limit gives nothing at all
   until the day it is abused. Forgetting fails open, so it has to be
   impossible rather than discouraged.
3. **It is keyed on the customer, and that is a Nigeria-specific decision.**
   Carriers here put whole subscriber pools behind a handful of addresses, so a
   per-address ceiling tight enough to stop one stolen session refuses a
   network, and one loose enough not to is not a ceiling.
4. **A daily total is blind to the shape of a takeover.** It does not look like
   one large transfer; it looks like several ordinary ones to people the
   customer has never paid, minutes apart, each fitting under the ceiling until
   the account is empty. The velocity rules count instead of measuring — which
   also means they need no currency, unlike the kobo limit.
5. **Velocity REFUSES rather than freezing, and that is the difference from
   the card protections rather than an inconsistency.** A card authorization is
   a notification: the network approved it before we heard, so only the next
   one can be protected. A transfer has not happened yet, so the correct action
   is to not do it.
6. **A dispute posts nothing when raised.** A claim is an assertion about a
   fact, not a fact. Crediting on the strength of one makes "dispute
   everything" a free withdrawal, and reversing that credit later takes money
   from a customer who has spent it — the same line the gift card flow draws
   between an offer and a transaction.
7. **There is no clawback from the recipient, and its absence is a decision.**
   A bank can reach into the other side because both sides sit in one regulated
   system with a process behind it. We cannot, so an upheld dispute is our
   loss, posted to its own expense account rather than netted against revenue —
   which means somebody has to look at the number.
8. **Retention is two laws pulling opposite ways.** AML says keep five years;
   the NDPA says do not keep longer than needed. `retention_coverage` lists
   every table against its decision and the invariant suite fails on an
   UNDECIDED row, in both directions — because a deletion job is a list of what
   somebody thought of, and the tables nobody thought of are the ones that
   accumulate customer data for years.
9. **Two append-only triggers refused the sweep and were right in different
   ways.** `staff_totp_used_steps` grows without bound for no purpose, so its
   trigger now permits deleting a row older than the window in which a code
   could still be presented — and nothing else. `card_reveals` was going to be
   purged and is not: a trail a scheduled job can delete from is one an
   intruder can prune, and the way to hold less there is to store less.
10. **The privacy notice is rendered from the schema.** A notice written once
    from a template describes what somebody intended, and the gap opens
    silently because nothing checks a paragraph. A test reads
    `019_retention.sql` and fails the build if any period the page quotes
    disagrees with the setting the sweep reads.
11. **The dependency scan found a real one on its first run.** `apps/web` was
    on Next 15.1.3, carrying an authorization-bypass-in-middleware advisory —
    and this app's CSP, with the nonce that makes the page hydrate, lives in
    middleware. Every 15.x release is in the affected range, so it was an
    upgrade to 16.
12. **Next 16 defaults to Turbopack, which cannot resolve this repo's `.js`
    specifiers.** `resolveExtensions` appends to a bare specifier and does
    nothing for one already carrying `.js`; `experimental.extensionAlias` is
    accepted, printed as active, and ignored. The first failure was `Call
    retries were exceeded`, which says nothing about module resolution. The
    build declares `--webpack`, because dropping the extensions would fix the
    web build by breaking every other workspace. The same trap
    `@nestjs/common/constants` and `@noble/hashes/sha3` set, in a third place.
13. **The gate is scoped to what serves customer traffic, and the exclusion is
    written down.** A repo-wide audit reports thirty findings, nearly all in
    the Expo and Metro toolchain, and failing on those trains everybody to skip
    the step. `apps/mobile` is named in the workflow as deliberately excluded
    rather than left as a gap.
14. **Two tests passed for the wrong reason and were rewritten.** A dispute
    invariant asserted the deadline was immutable while updating zero rows,
    because an earlier block had resolved the only open one. A retention test
    ran two sweeps with `Promise.all` and found no contention, because a sweep
    finishes in milliseconds — the lock is now genuinely held by another
    connection while the sweep is asked to run.

**Before publishing, an operator must:** replace the bracketed company name,
registered address, DPO address and NDPC reference in `apps/web/src/app/legal/`,
have the terms reviewed by a Nigerian lawyer, grant `dispute_reviewer` to real
people, and set `RETENTION_INTERVAL_SECONDS` on exactly one instance.

---

## Phase 14 — Talking to Bitnob again, and paying a bank ✅

Not a feature list. One blocking bug that had made every Bitnob-backed flow
fail, and the flow the product was missing once it worked.

| File | What it is |
|---|---|
| `packages/providers/src/bitnob/signing.ts` | the four headers, and why a bearer token was refused |
| `packages/ledger/sql/042_bitnob_v2.sql` | two credentials, and the retirement of the one that cannot work |
| `packages/ledger/sql/043_bank_payouts.sql` | payouts, their state machine and the queue that sees a stuck one |
| `packages/providers/src/ports/payout.ts` | the port, generic over its currency |
| `packages/providers/src/bitnob/payout-adapter.ts` | quote, initialize, finalize |
| `apps/api/src/payouts/` | reserve, send, reverse — Phase 9's shape |

### The bug: every Bitnob call was being refused

`BitnobClient` sent `authorization: Bearer <api key>`. That is how Bitnob's v1
API worked and how their published Node SDK still reads. v2 does not accept
it: it wants four headers carrying an HMAC-SHA256 over
`CLIENT_ID:TIMESTAMP:NONCE:PAYLOAD`, and a bearer token gets a `401` reading
*Invalid HMAC signature*.

From inside the app that is indistinguishable from a wrong key, which is
exactly what it looked like: cards, crypto, FX quotes and dedicated naira
account numbers all reported "something went wrong" while `/admin/credentials`
correctly said the credential was set. It was. It was the wrong SHAPE of
credential, sent the wrong way, and nothing anywhere could say so.

Findings from fixing it:

1. **A CORRECT CONSTANT DECAYS, and this table has now been wrong twice.**
   Phase 3 replaced a REST-shaped guess with paths from Bitnob's own published
   SDK — right at the time, and now a description of an API that no longer
   answers. `/api/v1/virtualcards/*` is `/api/cards` with per-card paths;
   `/addresses/generate-naira-account`, which this repo's own header admitted
   was a guess, is `/api/virtual-accounts`. "Verified against the vendor's SDK"
   is a claim about a DATE as much as a source.
2. **The script that exists to catch this had never been run.**
   `verify-bitnob-sandbox.mjs` was written in Phase 13 for precisely this
   failure. It is rewritten to sign, and its FIRST probe is now the one that
   proves signing works at all.
3. **THE STAGING GUARD BECAME UNPASSABLE AND UNSOUND AT ONCE.** It refused to
   boot unless `BITNOB_BASE_URL` contained "sandbox" — and v2 serves sandbox
   and production from ONE host, with the SECRET selecting between them. So a
   correct base URL would not boot, and a URL contrived to contain the word
   would pass while pointing at production. A check that cannot see the thing
   it guards is worse than none, because it is trusted. It moved to where the
   secret is used: the client asks `/api/whoami` once, before its first
   money-moving call, and refuses a `live` account. Not at boot — a provider
   call during startup is a new way for the API to fail to start.
4. **The v1 key is RETIRED, not renamed.** It is neither an id their API
   recognises nor a secret it can verify against, so carrying its value
   forward would turn "you are still on the old credential" into "your
   credential is wrong" — the same misdiagnosis, preserved in the schema.
5. **The webhook hash was already right and stays.** SHA-256 signs what we
   SEND and SHA-512 verifies what we RECEIVE. Two schemes, not an
   inconsistency to tidy up.

**Verified by recomputing the signature the way their server would**, against
the built bundle: `/api/whoami` and `/api/trading/quotes` both verify over the
exact bytes sent, with no authorization header, seconds not milliseconds, and
a hex nonce. Pointed at an account reporting `live`, a staging instance sent
`/api/whoami` and nothing else.

### Then: paying a bank

Sending money had only ever meant sending it to another Xetral customer.

```
Reserve   customer_wallet  -> customer_pending    the guard decides, BEFORE asking
Sent      customer_pending -> provider_float      it left
Failed    a reversal naming the reserve           it never left
(neither)                                          we do not know; it stays held
```

Phase 9's shape exactly, and deliberately: an on-chain withdrawal and a bank
payout ask the same question. No new entry kind and no new account role.

6. **The beneficiary name is the BANK'S, and the schema makes it so.** An
   account number that passes every format check can still belong to a
   stranger. The service re-fetches the name rather than accepting one from
   the request — anything a client can send, a stolen session can send — and
   `payoutSchema` is `.strict()`, so a caller-supplied name is refused rather
   than silently ignored.
7. **A lookup costs no PIN and a payout does.** Nothing is destroyed by
   asking, and an unknown account answers exactly as an unreachable bank does,
   so the endpoint cannot be used to map which numbers are live where.
8. **`Money` invariance bit twice in one afternoon, and vitest could not see
   it.** `PayoutRequest` with a bare `Money` field compiled and rejected every
   caller holding `ngn(…)`; making it generic then made the test's own
   `PayoutRequest[]` unwidenable — not even with a cast. The answer both times
   is the one `LedgerIntent` already records: carry `amountMinor` and a code.
   The unit tests passed throughout, because vitest transpiles without
   typechecking.
9. **The coverage checks demanded the rest.** 019 refused a table with no
   retention decision, 036 refused a view nobody classified AND a queue with
   no arm in the overview, `kill-switches.test.ts` refused a switch nothing
   reads and a service asserting a switch that does not exist, `di-tokens`
   caught five constructor parameters that would have resolved to `undefined`
   at runtime, and `error-codes` caught four codes the client would have
   flattened to "Something went wrong". Every one of them fired before a human
   read the diff.

**Before sending real money to a bank, an operator must:** set
`BITNOB_CLIENT_ID` and `BITNOB_CLIENT_SECRET` (the old `BITNOB_API_KEY` is
read by nothing), point `BITNOB_BASE_URL` at `https://api.bitnob.com` with no
version segment, apply migrations 041–043, and decide `transfer_fee_basis_points`
deliberately — a payout charges the same fee a wallet transfer does, and the
shipped default is zero.

**What Bitnob does NOT offer, recorded so it is not searched for again:** there
is no card-acquiring product. They issue cards to customers; they do not accept
a customer's own card as a funding instrument. Funding a wallet is the
dedicated virtual account (bank transfer in) or crypto.

---

## Phase 15 — Putting money in without KYC, and asking for it before a card ✅

Not a feature list. One requirement that had been written down in the wrong
place, and one screen asking for the wrong secret.

| File | What it is |
|---|---|
| `packages/providers/src/ports/funding.ts` | the port, carrying an identity rather than a provider's prerequisite |
| `packages/providers/src/paystack/` | client, funding adapter, webhook verification |
| `apps/api/src/funding/funding-provider.ts` | the switch, read per call |
| `apps/api/src/funding/paystack-webhook.service.ts` | verify, resolve, post |
| `packages/ledger/sql/044_paystack_funding.sql` | the setting, the credential slot, who issued an account |
| `packages/ledger/sql/045_card_fee_split.sql` | what a card costs US, and its finish |
| `apps/api/src/cards/card-colours.test.ts` | the three the database accepts and the three both apps offer |

### The requirement that was in the wrong place

`FundingPort` took a `providerCustomerId` and nothing else, so an account could
only be issued to a customer some provider had already verified. The comment
above it said a Nigerian bank account cannot be issued to an unidentified
person.

That is true of **Bitnob**, which will not issue one without a verified BVN. It
is not true of the rail. CBN's tiered KYC permits a tier 1 account on a name and
a phone number, capped — and `029_kyc_tiers.seed.sql` has capped tier 0 at
₦50,000 a day since it landed. So the platform enforced the ceiling while
refusing the account that ceiling exists for, on the screen a customer opens in
order to put money in.

1. **THE REQUIREMENT DID NOT DISAPPEAR, IT MOVED TO WHERE IT IS TRUE.** The port
   now carries the identity the platform HAS — name, email, phone, and a
   provider customer id where one exists — and each adapter decides what it
   needs. The Bitnob adapter refuses an unverified customer in its own code with
   its own reason and its own `kyc_required` code, before it calls anything;
   `bitnob/funding-adapter.test.ts` asserts all three, and the e2e asserts the
   other half — that the SAME customer is issued an account on the default rail.
   The two halves have to be tested together, because either alone reads as
   correct.
2. **PAYSTACK IS THE DEFAULT, AND RULE 0 IS DELIBERATELY REVERSED FOR IT.** The
   rule is about not inheriting the reference plugin's architecture by
   inheriting its providers, not about the vendor. This is one rail chosen on
   its own merits, and nothing else from the plugin comes with it.
3. **THE RAIL IS A SETTING, read per call with five seconds of cache.** The
   reason to switch is almost always that the current provider is having a bad
   afternoon, and 009's argument is that an operational decision taken under
   pressure should not be a release.
4. **SWITCHING MOVES NOBODY.** A dedicated account number is permanent and saved
   in somebody's banking app as a beneficiary, so `virtual_accounts` records the
   ISSUER and reads are routed by the row rather than by the setting. Reading
   the issuer off the currently-configured port would relabel every existing
   account the moment an operator flipped it — and an unresolvable deposit does
   not fail loudly, it posts to SUSPENSE.
5. **`charge.success` IS NOT ENOUGH; the channel must be `dedicated_nuban`.**
   Paystack fires that event for every successful charge, so crediting on the
   event name alone would turn any other Paystack product on the same
   integration into a way to create wallet balances.
6. **PAYSTACK BEARS A TOKEN AND BITNOB SIGNS, one directory apart.** Copying
   either scheme onto the other is a 401 that reads as a bad key — which is
   exactly what `bitnob/signing.ts` exists because of.

### The screen that asked for the wrong secret

`kyc_required` is refused by ISSUING, not by the card list. So an unverified
customer saw the offer, tapped Create card, was asked for a transaction PIN,
typed it, and only then learnt they needed to verify — on the one screen where
the requirement is regulatory rather than ours.

7. **THE REGULATOR IS NAMED, because the rule is theirs.** Both apps now gate
   the issue panel on an approved identity and say so: "As required by CBN,
   please complete your KYC", with a Verify KYC button. Telling somebody the
   rule that binds us is the difference between "they want more forms" and
   "this is the law".
8. **WHAT SIGNUP ALREADY TOOK IS NOT ASKED AGAIN.** The identity form opened
   with five empty boxes, two of which the account already held. The session
   carries the name and the phone, and both arrive filled in and STILL
   EDITABLE — the name on a BVN is not always the name somebody typed about
   themselves, and the reviewer reads it off a document either way. Neither is
   a claim about identity: `kyc_submissions.full_name` remains the only name a
   money decision or a card may carry.
9. **THE $2 IS TWO INDEPENDENT PAIRS ON ONE ENTRY, not one net figure.** The
   customer pays the price and the issuer bills the platform for issuing.
   Booking the whole of it as revenue made the margin on a card look like 100%
   and left the cost of the product nowhere in the books; netting them would
   report $1 of turnover on a $2 sale, understating the business and hiding the
   cost at the same time. Each pair sums to zero on its own — which is the
   property the per-currency balance invariant already guarantees, used for a
   second purpose.
10. **A COLOUR PICKER WHOSE ONLY FEEDBACK IS THE PICKER IS A LIST OF WORDS WITH
    BACKGROUNDS.** The chosen finish is held by the page rather than the form,
    so the specimen ABOVE it redraws — the choice is made against the thing
    being chosen. `card-colours.test.ts` reads the CHECK out of the migration
    and fails the build if the three offered and the three accepted disagree in
    either direction, and if the column's default is not one of them.
11. **AND THE INSERT THAT WROTE IT WAS WRONG IN A WAY NOTHING COULD SEE.** The
    statement referenced `$9` and the array passed eight values, so EVERY issue
    answered 500 while the compiler, every unit suite and the e2e file's own
    types were satisfied. A SQL string is invisible to TypeScript — the same
    shape as the freeze that wrote to a table called `sessions` — and only a
    round trip catches it. There is one now: the finish the customer chose is
    read back out of the response, and an omitted one must come back as the
    default rather than as whatever the column happened to hold.

**Before taking real deposits on the default rail, an operator must:** set
`PAYSTACK_SECRET_KEY` (one credential — it both authorises calls and verifies
webhooks, because Paystack signs with the same key), apply migrations 044 and
045, give Paystack the `/v1/webhooks/paystack/deposits` URL, decide
`paystack_preferred_bank`, and set `card_issuance_provider_cost_cents` to what
the issuer actually bills — the shipped default is $1 against a $2 price, and
both are rows an operator reviews.

---

## Phase 16 — One identifier, a code to get back in, and a price that keeps itself ✅

Not a feature list. Four things a customer could see were wrong, and each one
turned out to be a rule in the wrong place rather than a bug in a screen.

| File | What it is |
|---|---|
| `apps/api/src/auth/auth.service.ts` | the session read, split so a newer migration cannot take out the name and phone |
| `apps/api/src/auth/profile.service.ts` | the payment link, built from the phone number |
| `packages/ledger/sql/056_reset_codes.sql` | a reset is a code, and what makes six digits safe |
| `packages/ledger/sql/057_reference_rates.sql` | where a rate came from, and noticing when a feed stops |
| `packages/providers/src/exchangerate/` | the reference feed behind a port of its own |
| `apps/api/src/fx/rate-feed.service.ts` | the sweep that keeps every corridor priced |
| `apps/web/src/ui/keyboard-aware.tsx` | the keyboard, and the fixed bar that ignores it |

### The Request payment panel showed an em dash

`describeSession` reads the customer's name, phone and PIN state, and at some
point `u.country` and a join to `countries` were added to that one query.
`countries` arrives in 040 and `payout_method` in 046, so on a database behind
either, the query throws — and the catch returns EVERY FIELD AS NULL.

1. **The comment above that method already recorded this exact failure**, about
   `handle` and 039, and it happened again one migration later because the
   protection was a paragraph rather than a shape. The split is structural now:
   `#core` reads only `users` and `transaction_pins`, which have existed since
   002, and everything newer is a separate query that is allowed to fail.
2. **A missing migration must cost only what depends on it.** A deployment
   behind 040 now shows the customer their name, their number and their PIN
   state and falls back to the platform default for the personalisation.

### The identifier is the phone number

3. **A HANDLE WAS A SECOND NAME FOR THE SAME PERSON.** Minted from the email
   address, changeable once, and the only identifier a customer had to be
   taught — while every screen already knew their number. Two identifiers for
   one account is two things to get wrong, for no capability the number does
   not have. `POST /v1/auth/profile/handle` is gone, and so are
   `handle_taken`, `handle_invalid` and the screens that used them.
4. **A link already in the world still resolves.** `payLinkTarget` unwraps
   `/pay/<segment>` first and reads all digits as a number and anything else as
   a handle, because nobody re-reads a link they have already sent.
5. **THE LINK DROPS THE `+`**, because a plus in a URL is a space to enough
   software that a shared link arrives broken. Both readers put it back, and
   `payment-link.test.ts` asserts all three halves — the generator, the landing
   page and the parser — because a template string in one workspace and a
   directory name in another are what the `/pay` 404 was made of.
6. **AND THE LINK NO LONGER NEEDS `APP_BASE_URL` TO EXIST.** Unset, the API
   returns none and each app fills it in from the origin it is already running
   on. "No link yet — this deployment has no public address set" was an
   operator's problem printed where a customer was standing, on the screen they
   opened in order to ask to be paid.

### A reset is a code

7. **A LINK NEEDS AN ADDRESS, AND THAT TOOK THE FLOW DOWN.** With
   `APP_BASE_URL` unset the service refused before it did anything —
   "Password resets are unavailable right now. Contact support." — on the one
   path whose premise is that a customer has nothing left to contact support
   WITH. A code needs no address, and on a phone it does not send somebody out
   to a browser and back.
8. **SIX DIGITS IS A MILLION POSSIBILITIES, and three things pay for that.**
   The stored hash is an HMAC keyed by a secret that is not in the database —
   an unkeyed digest of a six-digit code IS the code to anybody holding a dump.
   The attempt ceiling is a COLUMN, because an attacker's loop outlives a pod
   restart. And the code is presented WITH the identifier, so a guess is
   against one account rather than against all of them at once.
9. **THE CEILING IS CHARGED AGAINST THE LIVE CODES, not the row a guess
   matched** — a wrong guess matches no row, so a per-row counter can never be
   incremented by the attack it exists to stop. That is why it is a second
   database function rather than an argument to the first.
10. **Running out of attempts is SAID OUT LOUD**, unlike the three refusals
    013 collapses into one. Those must stay indistinguishable because they tell
    a prober whether a guess was real; this one tells an attacker what they
    already know and tells the customer the only thing that helps: ask again.

### A price that keeps itself current

11. **053 GAVE AN OPERATOR A FORM AND THAT WAS THE WHOLE MECHANISM.** Eight
    fiat currencies is fifty-six numbers to retype, every day, or every
    corridor quotes a price from whenever somebody last had time — and the
    failure is silent, because the quote succeeds at the wrong number.
12. **A REFERENCE RATE IS NOT AN FX QUOTE**, so it is a port of its own.
    `FxPort` quotes a price we can DEAL at and then executes the swap; this
    one answers what the market says and can do nothing at all.
13. **A RATE A PERSON PUBLISHED IS NEVER OVERWRITTEN**, which is what `source`
    is for — and `prices_without_an_author` excludes feed rates by that source
    rather than by their absent author, or it would fill with fifty-six entries
    a day until nobody read it.
14. **THE FEED'S OWN FAILURE IS THE THING NOTHING ELSE CAN SEE.** A key that
    expires, a quota exhausted, an interval unset on the one instance that had
    it — none of them error. The rows stay, the screen renders, and customers
    are quoted whatever it last said. `stale_reference_rates` exists for that
    and the prices screen shows every rate's age.
15. **The rate is a decimal string at a FIXED six places**, which is what makes
    two syncs comparable as text — and comparing is what decides whether
    anything is republished at all. A varying width would make `1650.1` and
    `1650.100000` look like a price change.

### The keyboard covered the field

16. **TWO CAUSES ON THE WEB THAT LOOK LIKE ONE.** `.tabbar` is fixed to the
    LAYOUT viewport, which a keyboard does not change, so it stays where the
    bottom of the screen used to be — over the middle of the page. No amount of
    scrolling moves it. The second is that a browser's own scroll-into-view
    leaves a field flush against the keyboard with its hint and its error
    underneath.
17. **ON ANDROID THE HANDLING DID NOTHING AT ALL.** `behavior={... : undefined}`
    relies entirely on `adjustResize`, and under the edge-to-edge Android 15
    enforces the platform draws behind the keyboard and leaves the app to
    handle the inset. `height` is safe under both, because
    `KeyboardAvoidingView` measures the OVERLAP rather than the keyboard.
18. **Both fixes live where they cannot be forgotten** — the root layout on the
    web, `Shell` on the phone — and a test in each app fails the build on a
    screen that brings its own scroll region without them.

**Before this goes live, an operator must:** apply migrations 056 and 057
(**056 contains an `ALTER TYPE` that must run outside a transaction**), paste
an ExchangeRate-API key at `/admin/credentials`, and set
`FX_RATE_SYNC_INTERVAL_SECONDS` on exactly one instance — a day is the natural
value, because the feed itself refreshes daily.
