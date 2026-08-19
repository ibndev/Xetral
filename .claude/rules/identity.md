---
paths:
  - "packages/identity/**"
  - "**/*auth*"
  - "**/*session*"
  - "**/*token*"
  - "**/*pin*"
---

# Working on identity & auth

Loaded only when touching auth, session or token files.

## Before changing the schema

Run the invariant suite against a **freshly created** database and confirm every
block prints `PASS`. The test file inserts its own fixtures and is not
idempotent — a second run against the same database fails on duplicate keys,
which is not a real failure but will waste your time if you do not expect it.

## Refresh tokens

- Rotation goes through `rotate_refresh_token()`. Nothing else writes
  `consumed_at`. This is the same rule as "only the Ledger writes postings", and
  it is under the same pressure: the shortcut looks like two lines of TypeScript.
- Reuse revokes the **entire family**, not the presented token. Revoking one
  token leaves the generation an attacker is holding alive, which is the failure
  the check exists to prevent.
- Never reorder the checks in that function. Consumption is tested before
  expiry, so a lapsed session is not reported as theft.
- Only hashes are stored. If you find yourself needing the raw token after
  issuance, the design is wrong — it is unrecoverable by construction.

## Adding an endpoint

1. Declare it on the `RoutePolicyRegistry`. An undeclared route is denied, so
   forgetting this produces a 403 in the first test run rather than an open
   endpoint in production.
2. Decide `pin` deliberately. There is no default, because "does this move
   money?" is the question the route's author must answer.
3. If it must be public, write a real justification. It is listed by
   `publicRouteAudit()` and read in review.

## Adding a stored secret

Every stored secret carries a version prefix (`v1:`), enforced by CHECK
constraints. Hash what must never be recovered (PINs, passwords); seal what must
be readable later (BVNs, provider references) with `envelope.ts`. Do not
encrypt a PIN — nothing should be able to recover a customer's PIN, us included.

## Never

- Widen the access-token TTL without treating it as a security decision. It is
  the exact window a stolen access token keeps working, because signed tokens
  cannot be revoked mid-life.
- Add an `alg` field, or anything else that lets a token state how it should be
  verified. The version prefix selects a **key**, never an algorithm.
- Parse a token payload before its signature has been verified.
- Log a token, even partially. A prefix is not a redaction — use
  `redactSecret()`, which takes no "visible characters" argument on purpose.
- Track PIN lockout in application memory. An attacker's retry loop outlives a
  pod restart; the counter lives in `transaction_pins`.
- Reject an existing PIN at verification time because policy has since
  tightened. That locks customers out of their own money — prompt them to change
  it after they are in.
