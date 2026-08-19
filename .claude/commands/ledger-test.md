---
description: Rebuild the ledger schema from scratch and run all invariant tests
---

Drop and recreate the local `xetral` database, apply
`packages/ledger/sql/001_ledger.sql`, then run
`packages/ledger/sql/001_ledger.test.sql`.

Report each test's PASS/FAIL line. If any test fails, stop and diagnose before
making other changes — do not work around a failing invariant.
