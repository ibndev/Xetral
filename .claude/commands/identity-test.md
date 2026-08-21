---
description: Rebuild the schema from scratch and run the identity & auth invariant tests
---

Drop and recreate the local `xetral` database, apply
`packages/ledger/sql/001_ledger.sql` then `packages/identity/sql/002_identity.sql`
in that order, and run `packages/identity/sql/002_identity.test.sql`.

The test file is not idempotent — it inserts its own fixtures — so it must run
against a freshly created database. A duplicate-key error on a second run is a
dirty database, not a broken invariant.

Report each block's PASS/FAIL line. If any block fails, stop and diagnose before
making other changes — do not work around a failing invariant.

Then run the TypeScript suite: `npm test --workspace @xetral/identity`.
