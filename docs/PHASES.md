# Build phases

Each phase is independently landable. A later phase adds files and migrations; it
does not require rewriting an earlier one. Where a phase changes something already
shipped, that is called out explicitly.

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
6. **`pin: true` fails closed with a 500, deliberately.** Transaction-PIN
   enforcement is not built. A money-moving route must not serve traffic while
   its author believes that flag is protecting it, so such a route cannot
   respond at all until the check exists.
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

**Known limitation, deliberate:** transaction-PIN enforcement is unbuilt, so no
route can declare `pin: true` and serve traffic. It lands with the first
money-moving endpoint in Phase 4.

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

**CONFIRM BEFORE GO-LIVE.** Two things could not be verified from the
repository and are each collected in one place so that confirming them is a
small diff: the webhook signature header and encoding (`bitnob/webhooks.ts`),
and the endpoint paths (`BITNOB_ENDPOINTS` in `bitnob/client.ts`).

**Still operational:** Bitnob card issuing requires approval before use. That
lead time blocks Phase 5 — request it now if it has not been requested.

---

## Phase 4 — NGN wallet

Funding, transfers, balances, history. First real money flow end to end.

## Phase 5 — Virtual USD cards (Bitnob)

Issue, fund, freeze, terminate. Auth/settlement webhooks into the ledger.

## Phase 6 — Bills, eSIM, numbers

VTpass (airtime, data, utilities), Airalo (eSIM), Twilio (virtual numbers). Three
adapters against the same port; each lands separately.

## Phase 7 — Gift cards *(flagged off)*

Ships disabled. Needs a review queue, hold periods and rate cards before enabling.

---

## Deployment

Coolify (self-hosted, Apache-2.0) on Hetzner, Cloudflare free tier in front, GitHub
Actions for CI, EAS for mobile builds.

A single box is fine to start and is **not** an acceptable production topology for
a licensed fintech. Split app and database onto separate nodes with streaming
replication before taking real deposit volume.
