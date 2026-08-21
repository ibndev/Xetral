---
paths:
  - "packages/ledger/**"
  - "**/*ledger*"
  - "**/*posting*"
  - "**/*.sql"
---

# Working on the ledger

Loaded only when touching ledger or SQL files.

## Before changing the schema

Run the invariant suite first and confirm all 12 print `PASS`. If something is
already failing, fix that before adding anything — a new constraint layered on a
broken one is untestable.

## Adding an account kind

1. Add to the `account_kind` enum.
2. Decide `normal_balance` deliberately. Positive `amount_minor` means value flows
   INTO the account.
3. Decide whether it is overdraft-exempt. Customer accounts are **not** —
   `customer_wallet`, `customer_card` and `customer_pending` are guarded.
   `provider_float` legitimately goes negative: it means we sent a provider more
   than we deposited, which is a real position, not an error.
4. Add a test proving the new kind cannot break the balance invariant.

## Adding an entry kind

Every entry kind needs a worked example in a test showing the exact postings and
that each currency leg sums to zero. Write the failing case too — an entry of that
kind that *should* be rejected.

## Using the service

`LedgerService.post()` is the only writer. Build a `LedgerIntent` and hand it
over; do not open your own transaction against `postings`.

- A replay returns the existing entry with `replayed: true`. That is a success.
- Do not pre-check a balance before posting. The overdraft guard is in the
  database because the race is in the service layer.
- Translate `InsufficientFundsError` at the HTTP boundary. The ledger package
  knows nothing about HTTP on purpose — jobs and webhook handlers use it too.

## Never

- `UPDATE` or `DELETE` on `journal_entries` or `postings`. Append a reversal.
- Compute a balance in application code and write it absolutely. The relative
  write (`balance + NEW.amount`) is what makes concurrent postings add up rather
  than overwrite each other.
- Convert `apply_posting_to_balance` back to `INSERT ... ON CONFLICT DO UPDATE`.
  See CLAUDE.md — the `BEFORE INSERT` trigger fires on the proposed row and breaks
  the overdraft guard.
- Assert on a deferred constraint without `SET CONSTRAINTS ALL IMMEDIATE`. The test
  will pass with the constraint deleted.

## Reconciliation

`ledger_drift` must return zero rows. If it does not, stop: the materialised
balance and the postings disagree and you do not yet know which is lying.
