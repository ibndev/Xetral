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

---

## The second pass: what only running it could find

Findings 1–14 came from reading the code. These came from building the
bundles, serving them, and driving the app in a browser — and NOT ONE of them
was visible to the compiler, to a unit test, or to an e2e suite as it stood.
That is the finding behind the findings, and it is why CI now boots both apps
and probes them rather than trusting a green run.

| # | Finding | How it presented |
|---|---|---|
| 15 | **Three controllers were imported and never mounted.** Health, KYC and the entire admin surface were absent from `app.module.ts`'s `controllers` array. | Every one of their routes answered **404 in the built bundle**, while `route-coverage.test.ts` reported full coverage — because it walked its own hand-written list. The coverage test contained the exact failure it exists to prevent. It reads the list off the module now. |
| 16 | **Freezing an account raised every time.** `AdminService.setUserStatus` wrote `UPDATE sessions`; the table is `auth_sessions`. | A **500** on the most important action support has. And the right name alone would still have failed: `revocation_is_complete` requires a reason wherever `revoked_at` is set. A SQL string is invisible to TypeScript. |
| 17 | **Setting a transaction PIN returned 500 on the web.** The proxy answered every upstream `204` with `NextResponse.json(body, { status: 204 })` — a body on a status that forbids one. | Three endpoints answer 204 and one is "set your PIN". **No web customer could set a PIN, and without one they cannot move money at all.** |
| 18 | **The browser token store replayed its own refresh token.** `Session`'s single-flight latch is real, correct, and on the wrong function: on a fresh load every caller of `read()` went to `/api/auth/refresh` to exchange the cookie. | Two components loading on mount sent two refreshes with one cookie; the server correctly read the second as theft and revoked the device family. **The customer was signed out for opening a page** — the precise cost Phase 2 accepted and assigned to the client to fix. |
| 19 | **Registration had no route handler.** The page called `/api/auth/register`, which did not exist. | "Something went wrong" to somebody trying to open an account. |
| 20 | **A strict CSP shipped a dead application.** `script-src 'self'` blocks Next's own inline bootstrap. | The page rendered its HTML and **never hydrated**: every button inert, and a screenshot that looks perfect. |
| 21 | **The identity queue could list submissions and review none.** It returned `uuid` where every other view in that service returns `id`. | The reviewer's Approve button posted to `/kyc/undefined/review`. |
| 22 | **Two of three webhooks answered 500 to a forged signature.** Phase 8 recorded this finding and it had been applied to the card webhook only. | A 500 pages somebody over a stranger's probe, and a provider reading 500 retries for ever. |

Two more that were designed wrong rather than typed wrong:

| # | Finding |
|---|---|
| 23 | **The daily-limit guard deadlocked the pool.** Its first shape held a pool connection across a call that needed another one — so `pool.max` concurrent transfers wedge the API. Ten concurrent callers against a pool of eight found it; nothing else would have, until production. It is a `precondition` inside the ledger's own transaction now. |
| 24 | **A limit that ignored replays punished honest retries.** A customer near their ceiling whose request timed out would be told they hit a limit for a transfer that had in fact succeeded. |

## What changed as a result

- **CI boots both bundles and probes them.** The API must mount health, admin
  and KYC (404 fails the build), and answer 401 to three forged webhooks. The
  web app is served and its HTML read: every `<script>` must carry the CSP
  nonce from the header, because a page whose scripts the browser refuses is
  a page that does not run.
- **`route-coverage.test.ts` reads `AppModule`.** A controller the app does
  not mount is one the test does not see, and its policy then shows up as an
  orphan.
- **The client's error union is derived from one list**, and a test scans the
  API source in both directions. It named 18 of the 70 codes the API emits, so
  a weak password or a frozen card read as "Something went wrong."
- **Operational parameters are rows**, bounded by CHECKs and recorded in
  history — and the boot logs say so when an environment variable is being
  ignored, because that failure is otherwise silent and costs an afternoon.
