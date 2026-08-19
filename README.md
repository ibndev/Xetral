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
  api/        NestJS — deny-by-default guard, login/refresh/logout
  mobile/     Expo (iOS + Android)
  web/        Next.js (marketing + authenticated dashboard)
```

## Phases

See [`docs/PHASES.md`](docs/PHASES.md). Each phase lands independently.

## Running the tests

```bash
npm install
npm test                                   # every workspace, via turbo

# or one at a time
npm test --workspace @xetral/shared        # 29 money tests
npm test --workspace @xetral/identity      # 76 auth tests
npm test --workspace @xetral/api           # 26 guard, routing and rate-limit tests

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

The API's end-to-end suite runs the real login, rotation and reuse-detection
flows against that database:

```bash
DATABASE_URL=postgres://... REDIS_URL=redis://localhost:6379 \
  npm run test:e2e --workspace @xetral/api
```

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
