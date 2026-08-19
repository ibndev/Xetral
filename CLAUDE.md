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

---

## Providers

Live set: **Bitnob** (crypto, USDT, stablecoin, virtual USD cards, FX),
**VTpass** (airtime, data, bills), **Airalo** (eSIM), **Twilio** (virtual numbers).

Do **not** reintroduce Reloadly, Maplerad, Anchor, Paystack or ALAT. They appear in
the reference plugin and are out of scope.

### Bitnob specifics — verified from their docs

- **Card spend is two events, not one.** Authorization, then Settlement up to 7–14
  business days later, each with its own webhook. If no settlement arrives the hold
  expires and funds return. Bitnob's own docs warn that treating them as one
  transaction produces an incorrect balance. This is why the `customer_pending`
  account exists: auth moves wallet → pending, settlement moves pending → float,
  expiry is an ordinary reversal.
- **Webhook amounts are micro-units: 1 USD = 1,000,000.** Six decimals where the
  ledger uses two. The sibling `display_amount` is a **float** and must never touch
  ledger maths — it is for display only. Conversion happens at exactly one audited
  boundary inside the adapter, with its own tests.
- Webhook `event_id` is the natural source for `idempotency_key`. Format the key as
  `bitnob:<event_id>` so two providers cannot collide.
- Event names use the `.completed` suffix (not `.complete`); JSON keys are
  snake_case.
- Card issuing **requires approval** from Bitnob before use.

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
npm test --workspace @xetral/shared     # money primitives (vitest)
npm test --workspace @xetral/identity   # tokens, PIN, envelopes, policy (vitest)

# SQL invariants — needs live PostgreSQL 16. Apply migrations in order; the
# test files are NOT idempotent, so run them against a freshly created database.
createdb xetral
psql -d xetral -v ON_ERROR_STOP=1 -f packages/ledger/sql/001_ledger.sql
psql -d xetral -v ON_ERROR_STOP=1 -f packages/identity/sql/002_identity.sql
psql -d xetral -v ON_ERROR_STOP=1 -f packages/ledger/sql/001_ledger.test.sql
psql -d xetral -v ON_ERROR_STOP=1 -f packages/identity/sql/002_identity.test.sql
```

Note: the root `npm test` script calls `turbo`, which is not yet a dependency.
Use the per-workspace commands above until that is resolved.

## Deployment

Coolify (self-hosted) on Hetzner, Cloudflare free tier in front, GitHub Actions CI,
EAS for mobile builds. A single box is fine now and is **not** an acceptable
production topology for a licensed fintech — split app and database onto separate
nodes with streaming replication before taking real deposit volume.
