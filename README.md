# Xetral

Multi-currency fintech platform. NestJS + PostgreSQL + Expo, TypeScript end to end.

## Why this repo exists

Xetral previously ran as a WordPress plugin (~40k lines of PHP, 43 tables, 87 REST
routes). That codebase is **reference material only** — business rules, provider
quirks and Nigerian rails knowledge. None of it is ported. No WordPress, no `wp_`,
no PHP.

## Product scope

| Line | Provider | Status |
|---|---|---|
| NGN wallet — transfer, balances, history | — | **built** |
| NGN wallet — funding | Bitnob virtual accounts | **built** |
| Bills, airtime, data | VTpass | **built** |
| Virtual USD cards | Bitnob | **built** (Bitnob registration under review) |
| Crypto / USDT / stablecoin | Bitnob | **built** (needs Bitnob credentials) |
| Multi-currency + FX / remittance | Bitnob | planned |
| eSIM | Airalo | **built** |
| Virtual numbers | Twilio | **built** |
| Gift card trading | — | **built**, ships flagged off (`GIFT_CARDS_ENABLED`) |

Every adapter's endpoint table, auth scheme and signature is verified against
that provider's own SDK or published documentation, and each names its source
in a header comment. The one thing still unconfirmed is Bitnob's card **webhook
event names**, which resolve together with the card-issuing approval that gates
them — Bitnob registration is under review. An unrecognised event throws and is
retried rather than being dropped, so a wrong name there is loud rather than a
lost spend. It is marked `CONFIRM BEFORE GO-LIVE` in
`packages/providers/src/bitnob/events.ts`; that grep should return exactly one
hit until the approval lands.

Gift card trading ships **disabled**, and disabled is the feature. Buying cards
*from* users is the highest-fraud surface here: the goods are bearer
instruments and a redeemed card cannot be un-redeemed. The code is complete and
tested in both states — every route refuses with `gift_cards_disabled` until
`GIFT_CARDS_ENABLED=true`, so enabling it is a configuration change rather than
a deploy of code nobody has run. Every payout is approved by a human and lands
in a hold before it becomes spendable.

## Architecture rules

1. **Only the Ledger writes postings.** Every other module requests a journal entry
   and receives an id. This is what makes the system auditable, and it is the rule
   that will be under pressure from every deadline.
2. **Money is never a float.** Integer minor units, `bigint` in TypeScript,
   `BIGINT` in Postgres, with no lossy step between.
3. **Providers sit behind ports.** Swapping or adding one touches its adapter and
   nothing else.
4. **Invariants live in the database.** A rule enforced only in application code is
   a rule that holds until the first 3am manual fix.

## Layout

```
packages/
  shared/     types, money primitives, Zod schemas — imported by API and app
  ledger/     double-entry core: schema, invariants, the one posting service
  identity/   users, devices, sessions, refresh rotation, PINs, envelopes
  providers/  provider ports and their adapters (Bitnob, VTpass, Airalo, Twilio)
apps/
  api/        NestJS — deny-by-default guard, login/refresh/logout
  mobile/     Expo (iOS + Android)
  web/        Next.js (marketing + authenticated dashboard)
```

## Phases

Phases 0–9 are built. Two remain — see [`docs/PHASES.md`](docs/PHASES.md),
which opens with a status table and what each is blocked on. Each phase lands
independently.

Customers fund their wallets through a **dedicated Nigerian account number**
issued by Bitnob, in their own name and permanent, and can send and receive
USDT and BTC on-chain. The two remaining phases are FX/remittance and the
mobile and web clients.

## Running the tests

```bash
npm install
npm test                                   # every workspace, via turbo

# or one at a time
npm test --workspace @xetral/shared        # 29 money tests
npm test --workspace @xetral/identity      # 76 auth tests
npm test --workspace @xetral/api           # 31 guard, PIN, routing and rate-limit tests
npm test --workspace @xetral/providers     # 60 adapter, conversion and webhook tests
npm test --workspace @xetral/ledger        # 10 intent-validation tests

# SQL invariants — needs a live PostgreSQL 16. Migrations apply in order, and
# the test files are not idempotent, so run them against a fresh database.
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
```

All 12 ledger tests, 20 identity blocks, 10 card blocks and 11 purchase blocks print `PASS`. Any `TEST FAILED`
means an invariant is not wired up — do not deploy past it.

The API's end-to-end suite runs the real login, rotation and reuse-detection
flows against that database:

```bash
DATABASE_URL=postgres://... REDIS_URL=redis://localhost:6379 npm run test:e2e
```

That covers the API's auth flows, wallet transfers, cards, purchases and the
reconciliation sweep that resolves held money, plus the rate-limiter contract
and the Bitnob adapter's output against the real ledger schema — the only check
that its entry kinds and account roles exist as enum values rather than merely
as TypeScript literals.

It is a separate script rather than a skip-when-unavailable block in `npm test`,
because a suite that quietly skips is a suite that reports green on a machine
where it never ran.

## CI

`.github/workflows/ci.yml` runs the whole of the above on every push and pull
request, against Postgres 16 and Redis 7 service containers: SQL invariants on a
dedicated database, typecheck, unit tests, end-to-end tests, build, and finally a
smoke test that boots the built bundle and checks a guarded route answers 401.

The invariant step scans psql's output as well as its exit code. `ON_ERROR_STOP`
catches a raised `TEST FAILED`, but the drift check reports through a `SELECT`
and exits zero — a reconciliation check that cannot fail the build is not a
check.
