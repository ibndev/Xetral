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
| NGN wallet — fund, transfer, bills, airtime | VTpass | planned |
| Virtual USD cards | Bitnob | planned |
| Crypto / USDT / stablecoin | Bitnob | planned |
| Multi-currency + FX / remittance | Bitnob | planned |
| eSIM | Airalo | planned |
| Virtual numbers | Twilio | planned |
| Gift card trading | — | **feature-flagged off at launch** |

Gift card trading ships disabled. Buying cards *from* users is the highest fraud
surface of the six and needs a review queue and hold periods before it is safe.

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
  ledger/     double-entry core: schema, invariants, posting service
  identity/   users, devices, sessions, refresh rotation, PINs, envelopes
apps/
  api/        NestJS
  mobile/     Expo (iOS + Android)
  web/        Next.js (marketing + authenticated dashboard)
```

## Phases

See [`docs/PHASES.md`](docs/PHASES.md). Each phase lands independently.

## Running the tests

```bash
npm install
npm test --workspace @xetral/shared        # 29 money tests
npm test --workspace @xetral/identity      # 65 auth tests

# SQL invariants — needs a live PostgreSQL 16. Migrations apply in order, and
# the test files are not idempotent, so run them against a fresh database.
createdb xetral
psql -d xetral -v ON_ERROR_STOP=1 -f packages/ledger/sql/001_ledger.sql
psql -d xetral -v ON_ERROR_STOP=1 -f packages/identity/sql/002_identity.sql
psql -d xetral -v ON_ERROR_STOP=1 -f packages/ledger/sql/001_ledger.test.sql
psql -d xetral -v ON_ERROR_STOP=1 -f packages/identity/sql/002_identity.test.sql
```

All 12 ledger tests and all 20 identity blocks print `PASS`. Any `TEST FAILED`
means an invariant is not wired up — do not deploy past it.

The root `npm test` script calls `turbo`, which is not yet a dependency; use the
per-workspace commands above until that is resolved.
