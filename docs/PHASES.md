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
| `apps/api/src/auth/rate-limit.ts` | sliding-window limiter behind a port |
| `apps/api/src/config.ts` | env parsing that refuses to boot without secrets |

Twenty-six unit tests plus twelve end-to-end tests against PostgreSQL 16.

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

**Known limitations, both deliberate and both stated in code:**

- Rate limiting is **in-memory, so it counts per process**. Two instances behind
  a load balancer means double the effective limit. It sits behind
  `RateLimitStore`; moving to Redis touches one file, and must happen before
  the app scales horizontally.
- Transaction-PIN enforcement is unbuilt, so no route can declare `pin: true`
  and serve traffic. It lands with the first money-moving endpoint in Phase 4.

---

## Phase 3 — Provider ports + Bitnob adapter

Port interfaces first, then the Bitnob adapter behind one.

Two Bitnob facts already designed for:

1. **Card spend is two events.** Authorization then Settlement, up to 7–14 business
   days apart, each with its own webhook. Bitnob's own documentation warns that
   treating them as one produces an incorrect balance. Handled by the
   `customer_pending` account added in Phase 1.
2. **Webhook amounts are micro-units — 1 USD = 1,000,000** — with a sibling
   `display_amount` float. Six decimal places where the ledger uses two, and a
   float that must never touch ledger maths. The conversion is a single audited
   boundary inside the adapter, with its own tests.

Also: webhook `event_id` is the natural `idempotency_key` source, and event names
use the `.completed` suffix (not `.complete`) with snake_case keys.

**Operational:** Bitnob card issuing requires approval before use. That lead time
blocks Phase 5 — request it now.

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
