# Pre-deployment audit

Conducted against the full codebase before first deployment. Findings are
ordered by what they cost, not by where they live.

## Blocking — the platform could not operate

| # | Finding | Why it blocks |
|---|---|---|
| 1 | **No registration endpoint.** No route creates a user. | Nobody could open an account. Every test seeds users with direct `INSERT`s, which hid it. |
| 2 | **Nothing writes `provider_customers`.** | That table gates cards, NGN funding *and* crypto addresses. Every customer would be permanently refused with `kyc_required`, so the platform could not take a single deposit. |
| 3 | **Nothing sets `users.status`.** | `frozen` and `closed` are checked on every money path and were unreachable. No way to freeze a compromised or fraudulent account. |
| 4 | **Suspense had no exit.** | An unattributable deposit posts to `suspense` and logs "a person must resolve it" — with no endpoint for a person to resolve it with. Money could enter and never leave. |
| 5 | **No health or readiness endpoint.** | Load balancers and Coolify need one; without it a half-started instance keeps receiving traffic. |

## Serious — operations would require a developer

| # | Finding |
|---|---|
| 6 | **Every operational parameter was an env var**: fees, deposit ceiling, hold days, confirmation thresholds. Changing a fee meant a deploy. |
| 7 | **No admin surface beyond gift cards.** No user management, no transaction monitoring, no reconciliation visibility, no way to see suspense or stuck purchases. |
| 8 | **No audit trail for staff actions.** Gift card approvals recorded a reviewer; nothing else recorded anything. |
| 9 | **`staff_role` had two values** (`giftcard_reviewer`, `admin`), so every privileged action was all-or-nothing. |

## Web and mobile

| # | Finding |
|---|---|
| 10 | **Web covered 4 of 8 customer flows** — no purchases, crypto, FX or cards screens. |
| 11 | **No 404 or error boundary.** An unhandled error showed a stack trace in development and a blank page in production. |
| 12 | **No responsive breakpoints.** Fixed padding and a fixed max width; unusable below ~380px. |
| 13 | **No security headers.** No CSP, HSTS, `X-Frame-Options` or `Referrer-Policy`. |
| 14 | **No `<html lang>` consistency check, no focus-visible styles, no reduced-motion handling.** |

## What was already right

Recorded because an audit that only lists faults is not an audit.

- Every money path posts through `LedgerService`; no service writes `postings`.
- The balance invariant is per currency and deferred to COMMIT, with a test
  proving two cross-currency errors cannot cancel.
- Deny-by-default routing, with a build-failing coverage test in both
  directions and a structural check that `/v1/admin/` implies `staff()`.
- Refresh rotation with reuse detection in a database function, not service code.
- Money is `bigint` minor units end to end; the client formats strings without
  ever producing a float.
- Every provider adapter converts amounts at exactly one audited boundary.
