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

## Phase 2 — Identity & auth

Short-lived access tokens, rotating refresh tokens with reuse detection, device
binding, transaction PIN separate from login credentials, biometric gate.

Authorisation is **deny by default**: an endpoint must explicitly opt out. The
reference plugin had 45 routes declaring `permission_callback => '__return_true'`
with the real check inside each callback — safe only for as long as nobody forgets.

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
