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

### The ledger service

`LedgerService.post()` is the only code that writes postings. Everything else
builds a `LedgerIntent` — a request naming accounts by **role** — and hands it
over.

- **A replay is a success, not an error.** `post()` returns the existing entry
  with `replayed: true` when the idempotency key has already been used. A
  handler that treats the second delivery as a failure keeps failing, and the
  provider keeps retrying, for ever.
- **Never pre-check a balance.** Between the check and the write another request
  can spend the same money. Build the entry, let the overdraft guard decide, and
  translate the error. A pre-check is a second, weaker copy of the rule plus a
  race.
- **`InsufficientFundsError` carries no figure.** Returning "you have ₦4,300" to
  a caller that asked to send ₦5,000 turns a transfer endpoint into a balance
  oracle for a stolen session.
- Account roles resolve to ids inside the service, creating the account if it is
  the first posting. The two partial unique indexes make that race-safe: the
  loser of a concurrent create re-reads the winner's row.
- History is **keyset paginated** on the posting id, and shows only the
  customer's own leg. `OFFSET` shifts under an active account, producing
  duplicates and gaps.

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

### Cards — non-obvious rules

Schema: `packages/ledger/sql/003_cards.sql`.

- **A card number is a PASS-THROUGH and is never stored.** `003_cards.sql` has
  no column that could hold one, which is what makes that structural. The
  reveal fetches from the provider, hands the value to a customer who proved a
  PIN, and drops it; `card_reveals` records THAT it happened, never what it
  showed. Every card issued since Phase 5 was unusable until this existed.
- **`CardSecrets` is a separate type from `VirtualCard`, deliberately.** As
  optional members of the card view a PAN would ride along in every listing and
  every log line that serialises a card — and nothing would fail on the day it
  did.
- **The reveal is rate limited by ROWS, not by memory**, per card and per
  customer. An attacker's loop outlives a pod restart; an in-process counter
  does not. The per-customer ceiling is what catches a stolen session walking
  through every card on an account, which a per-card limit never sees.
- **A frozen card can still be revealed; a terminated one cannot.** Freezing
  stops spending, not looking. A terminated card's number is dead at the
  provider, so revealing it hands a customer something that cannot work.
- **Bitnob's card response shape is NOT settled.** Their SDK reads
  `cardNumber`, `cvv2` and a single `expiry`; this adapter's schema required
  `last4`, `expiry_month` and `expiry_year`, and the SDK-shaped payload threw.
  The read accepts both, because being tolerant on a read costs nothing and
  being wrong costs every card.
- The card's balance shown to a customer comes from the **ledger**, not from
  asking Bitnob. A provider figure can lag a settlement by days; reconciliation
  compares the two deliberately.
- `last4` has a `^[0-9]{4}$` CHECK. "Just the last four" becomes "the whole
  number" the first time somebody is in a hurry, and then a database dump holds
  PANs.
- **Termination is final**, and a card's `(provider, provider_card_id)` and
  owner are immutable — every webhook already delivered points at that row.
- **Freezing takes no PIN; unfreezing does.** The protective action has to be
  frictionless for a customer watching fraudulent charges land.
- Registering a Bitnob customer is a **KYC step**, so `provider_customers` is
  never populated as a side effect of "get a card" — the card route refuses
  until it exists.
- An authorization the card cannot cover is **rethrown, not acknowledged**, so
  the provider retries: webhooks arrive out of order and a funding event landing
  a moment later makes the retry succeed. Acknowledging would drop a real spend
  from the books to save log noise.

### Purchases (bills, eSIM, numbers) — non-obvious rules

Schema: `packages/ledger/sql/004_purchases.sql`. One table for every "buy a thing
from a provider": the providers differ, the money question does not.

```
Reserve   wallet  -> pending          BEFORE the provider is asked for anything
Settle    pending -> provider_float   it happened
Reverse   pending -> wallet           it did not — a reversal naming the reserve
(neither)                             we do not know; the money stays held
```

- **The reference is derived from the customer's key, never generated.** The
  reserve entry is posted before the purchase row exists, so a crash in that gap
  leaves a retry with no row to find. A derived reference makes that retry reuse
  the same ledger idempotency key and the ledger answers `replayed: true`. A
  random one charges twice, only under a crash. `referenceFor()` is the one
  place it is built.
- **The customer's idempotency key is unique PER CUSTOMER.** Two customers will
  send the same key; a client counting from one is enough. `reference` is ours
  and globally unique, `(user_id, idempotency_key)` is theirs.
- **A timeout settles nothing and reverses nothing.** Reversing refunds a
  purchase that may have been delivered; retrying buys it twice. The row stays
  `reserved`, and `ReconciliationService` resolves it later by ASKING the
  provider. That worker never decides an outcome — a purchase the provider
  still calls `pending` stays held however old it is, and one held past
  `RECONCILE_STALE_SECONDS` is escalated to a human rather than auto-reversed.
  By then both remaining answers can be the wrong one.
- **Settling and reversing live in `purchase-outcome.ts`, used by both callers.**
  The request handler resolves what it learned synchronously; the worker
  resolves what nobody was left listening for. A second copy of those postings
  would be a second set of assumptions about the ledger, and the copy that
  drifts is the one that only runs at 4am against money nobody is watching.
- **Exactly one instance sets `RECONCILE_INTERVAL_SECONDS`.** Duplicate sweeps
  are safe — a session advisory lock serialises them and the ledger's
  idempotency key makes a repeat posting a replay — but asking a provider about
  the same purchase from four processes is rate-limited at best.
- **Delivery payloads are sealed with `envelope.ts`, never stored in the clear.**
  An electricity token is a bearer instrument. The `^v[0-9]+:` CHECK on
  `delivery_sealed` makes that structural.
- **An outcome is final**, by trigger, and identity and amount are immutable.
  Reopening a purchase would let a delivered token be re-delivered.
- **A catalogue price is a bigint and must be mapped at the HTTP boundary.**
  `JSON.stringify` throwing on one is correct behaviour, not a nuisance to patch
  with a global BigInt serialiser.
- **Verification is an optional capability**, not a port method — `verifyTarget`
  on the port would give Airalo and Twilio a method that throws. Use
  `supportsVerification()`.

### NGN funding — non-obvious rules

Schema: `packages/ledger/sql/006_funding.sql`. Bitnob dedicated Nigerian
virtual accounts. **The only inbound flow that creates money** rather than
moving money already ours.

```
Funding    provider_float -> customer_wallet    now owed to the customer
Suspense   provider_float -> suspense           it arrived; we cannot say whose
```

- **The deposit webhook is the most dangerous in the system.** Signature
  verification happens before a single byte is parsed, and the idempotency key
  is the provider's event id, so a redelivery is a replay the ledger refuses.
- **The NGN amount unit is a deployment value, guarded by a ceiling.**
  `BITNOB_NGN_AMOUNT_UNIT` (default `kobo`) and `DEPOSIT_CEILING_KOBO`. A
  factor-of-100 misread blows the ceiling, so the first wrong deposit is held
  in suspense rather than spent. All conversion lives in `ngn-amounts.ts`.
- **The ceiling is asymmetric on purpose.** It catches over-crediting, which is
  spent before anyone notices. Under-crediting surfaces as a customer complaint
  within the hour and is recoverable, and a floor would reject the small
  deposits that are most of the traffic.
- **An unattributable deposit posts to `suspense`, never nowhere.** The money
  arrived whatever we can work out about it.
- **A lost webhook is only found by asking.** `DepositReconciliationService`
  posts under the SAME key the webhook would have used, so a late delivery is a
  replay rather than a second credit.
- **A virtual account is permanent and immutable.** Customers save the number
  as a bank beneficiary; changing the owner or number redirects money silently.
  One live account per (user, currency), enforced by a partial UNIQUE INDEX —
  **not** an EXCLUDE constraint, because `ON CONFLICT` cannot target one.
- **Issuing requires `provider_customers` to exist.** KYC is a prerequisite,
  never a side effect of tapping "add money".
- **A forged webhook answers 401 and is dropped**, never 500 and never retried.

### FX and remittance — non-obvious rules

Schema: `packages/ledger/sql/008_fx.sql`. Added a **flow, not a migration** —
`fx_trade` and `revenue_fx_spread` have been in the schema since Phase 1.

```
NGN legs:  wallet -X,  provider_float +(X - spread),  revenue_fx_spread +spread
USD legs:  provider_float -Y,  wallet +Y
```

- **A rate is a RATIO of integers**, never a decimal and never minor-per-major.
  Per-major works for USD→NGN and collapses for NGN→USD, where one kobo is
  0.0006 cents. All rate arithmetic lives in `fx/rate-math.ts`.
- **This is the flow the per-currency balance invariant was written for.** An
  entry off by +1,000 kobo and −1,000 cents sums to zero whole-entry and would
  credit ten dollars from nowhere.
- **Helpers taking an amount must be generic** (`<B extends Currency>`). A bare
  `Money` parameter is `Money<Currency>` and rejects every real caller.
- **The spread comes off the base amount before conversion**, which makes it
  revenue in the base currency and keeps each currency balanced.
- **Both roundings are stated and favour opposite parties** — spread DOWN (the
  customer keeps the fraction), conversion DOWN (we do). Never net them.
- **A remittance is ONE entry.** Convert-then-transfer leaves a window where a
  crash strands the money in a wallet the sender never meant to hold.
- **Credit the FILL, not the quote.** A partial fill credited at quote pays the
  difference out of the float, silently.
- **A timed-out swap records nothing** — the one place doing nothing is safer
  than holding, because the derived reference makes the retry idempotent at the
  provider.
- **An unpublished pair is refused, never quoted from a default.**

### Crypto (USDT, BTC, on-chain) — non-obvious rules

Schema: `packages/ledger/sql/007_crypto.sql`. Needed **no new entry kinds** —
`crypto_deposit` and `crypto_withdrawal` have been in `001_ledger.sql` since
Phase 1.

```
Deposit seen        provider_float   -> customer_pending   visible, NOT spendable
Deposit confirmed   customer_pending -> customer_wallet    final
Withdrawal reserved customer_wallet  -> customer_pending   the guard decides
Withdrawal sent     customer_pending -> provider_float     unrecallable
Withdrawal failed   a reversal naming the reservation      it never left
```

- **A deposit is two events, like a card spend.** One confirmation can be
  reorganised away, so money sits in `customer_pending` until the threshold.
  The two phases carry DIFFERENT idempotency keys derived from one event —
  without the suffix the confirmation replays the seen entry.
- **The threshold is per chain and stored per deposit row.** A Bitcoin block is
  ten minutes and a Tron block is three seconds. Storing it on the row means
  raising it later cannot un-confirm money already spent.
- **Address validation is checksum validation.** Base58Check (Tron, legacy
  BTC), bech32 (SegWit), EIP-55 (ETH/BSC). Shape checks accept a transposed
  character; checksums do not, and a wrong address cannot be undone.
- **Never hand-roll a hash here.** Keccak-256 comes from `@noble/hashes`, and
  Node's `sha3-256` is a different function that would silently break EIP-55.
  Import `@noble/hashes/sha3.js` — the extensionless specifier is CommonJS-only
  and fails under native ESM.
- **A crypto deposit to an unknown address is NOT suspense.** An address we did
  not issue is not ours; the event throws and is retried.
- **`max_fee` is part of consent.** Fees move between quote and request.
- **An unrecognised provider status throws**, never defaults — one default
  reverses money that is on a chain, the other lies about money that never left.

### Gift cards — non-obvious rules

Schema: `packages/ledger/sql/005_giftcards.sql`. Ships behind
`GIFT_CARDS_ENABLED`, which defaults to **false**.

Buying cards FROM customers inverts every other flow: they hand us a bearer
instrument whose value we cannot verify at the moment we pay. Two controls
follow, and both are in the schema.

```
Submit      (nothing)                                an offer, not a transaction
Approve     giftcard_inventory -> customer_pending   paid, and NOT spendable
Release     customer_pending   -> customer_wallet    the hold matured
Claw back   a reversal naming the approval           only while still held
Reject      (nothing)                                no entry ever existed
```

- **Every payout is approved by a human.** There is no auto-approval path and
  no threshold below which one exists — "small" is what a fraudster sends first
  to find where the threshold is.
- **The hold is enforced by the database clock, in two places**: the
  `giftcard_holds_due` view and the state-machine trigger. A release worker
  with a skewed clock must not be able to shorten the only control still
  standing after approval.
- **A clawback works only while the money is held.** After release it may be
  spent, and clawing back would overdraw a customer who did nothing wrong.
- **Roles are read fresh per request, never carried in the access token.** A
  signed token cannot be revoked mid-life; a role baked into one outlives its
  own withdrawal by fifteen minutes.
- **The role is checked before the PIN**, so probing an admin path cannot spend
  a customer's PIN attempts.
- **`/v1/admin/` routes must be declared with `staff()`**, and
  `route-coverage.test.ts` fails the build otherwise. Using `authenticated()`
  by mistake leaves an approval endpoint open to every signed-in customer.
- **Card codes are sealed** (`^v[0-9]+:` CHECK) and never returned to a
  customer. A reviewer reveals ONE deliberately; the queue listing carries none.
- **Rate cards are append-only.** Editing one rewrites the price of every past
  trade. Retire and republish.
- **The rate IS the FX** — "N1,250.00 per USD of face value" — so this phase
  needs none of Phase 10's machinery.

### Operations, settings and limits — non-obvious rules

Schema: `packages/ledger/sql/009_admin.sql`, seeded by `009_admin.seed.sql`.

- **`platform_settings` is authoritative; the environment is a fallback** for
  the moments before the table can be read. That is what lets an operator
  change a fee without a deploy, and it fails silently in the other direction —
  somebody sets `TRANSFER_FEE_BASIS_POINTS`, restarts, and watches nothing
  happen. Bootstrap therefore logs a warning naming every environment value the
  database is overriding.
- **Bounds are CHECKs, not form validation.** A transfer fee is capped at 500
  basis points, so `1500` typed where basis points were meant is refused
  whether it arrives through the dashboard, a script, or psql at 3am.
- **Gift cards need BOTH switches** — the deployment's flag and the stored
  setting. Every other setting is decided by the database alone. It is the one
  flow that pays out against a bearer instrument nobody can verify at the
  moment of payment, so enabling it takes two deliberate acts; and either
  switch being off means off, so an incident can be stopped from the dashboard
  in seconds.
- **The daily limit is a `precondition` on the ledger's own transaction**, not
  a check around it. Its first shape held a pool connection and called the
  ledger from inside, which deadlocks the pool at `pool.max` concurrent
  transfers. `LedgerService.post(intent, { precondition })` runs it on the
  entry's connection, inside the entry's transaction, holding a per-customer
  advisory lock. A precondition must not write, must throw to refuse, and must
  not take a connection of its own.
- **A replay skips the limit.** Otherwise a customer near their ceiling whose
  request timed out is told they hit a limit for a transfer that succeeded.
- **The limits are published in kobo and apply to naira only.** Applying a
  kobo ceiling to USDT because both are integers is the same mistake as adding
  kobo to cents.
- **"Today" is a Lagos day.** A UTC boundary resets the limit at 1am local —
  surprising to the customer and an hour a fraudster would learn.
- **Approving KYC creates `provider_customers`, in the same transaction.** A
  submission marked approved with no mapping leaves the customer verified on
  our side and refused by every provider-backed route.
- **The audit log is append-only by trigger** and destructive actions require a
  reason by CHECK. A log a privileged user can edit tells you what the last
  person with access wanted you to believe.
- **Attributing a suspense deposit APPENDS a correcting entry.** The original
  posting was a true statement — money arrived and we could not say whose —
  and editing it would erase the fact that we ever did not know.
- **Freezing does not touch balances.** It revokes live sessions so it bites
  immediately, and the money stays owed to the customer. Conflating the two is
  how a support action becomes a seizure.

### Rate limiting and transfer velocity — non-obvious rules

Schema: `packages/ledger/sql/017_transfer_velocity.sql`. Limiter in
`apps/api/src/auth/request-rate-limit.service.ts`.

- **The rate class is DERIVED from the route's policy, never declared.** A
  forgotten authorisation declaration gives a 403 somebody fixes that morning;
  a forgotten rate limit gives nothing at all until the day it is abused.
  Forgetting fails open, so it must be impossible rather than discouraged.
- **Authenticated requests are counted per CUSTOMER, not per address.**
  Nigerian carriers put whole subscriber pools behind a handful of addresses,
  so a per-address ceiling tight enough to stop a stolen session refuses a
  network. The tight limits on public routes are the per-identifier buckets in
  `login-rate-limit.guard.ts`, which NAT does not blur.
- **The limiter runs after the bearer check and BEFORE the PIN.** A PIN is
  verified with scrypt, deliberately slowly; a flood reaching it would spend
  that cost on every request and the limiter would be what brought the box down.
- **`/health` and `/ready` are unmetered.** What polls them hardest is the load
  balancer deciding whether this instance lives.
- **The web edge must forward `x-forwarded-for`, COPIED not appended.** Without
  it every web customer is one client to the limiter. Appending would make the
  header one hop longer than a mobile request's, and `TRUST_PROXY_HOPS` cannot
  be right for both.
- **Transfer velocity counts, it does not measure.** How many strangers a
  customer is paying today, and how many transfers in the last hour. A count
  carries no units, so both apply in EVERY currency — unlike the daily kobo
  ceiling, which is a statement about naira alone.
- **It refuses; it does not freeze.** A card authorization already happened
  when we hear about it, so only the next one can be protected. A transfer has
  not, so the correct action is to not do it.
- **Read from POSTINGS, never from an entry's metadata.** A control that
  depends on a key some flow remembered to set is a control that switches
  itself off silently.
- A recipient is **new today** when the FIRST time they were ever paid falls
  inside the current Lagos day — somebody paid monthly for a year is not a
  stranger because this month's rent went out this morning.

### What later happened to an entry — non-obvious rules

Schema: `packages/ledger/sql/023_entry_status.sql`.

- **`reverses_id` means "the entry this one acts upon", and the CHECK is
  per kind.** It used to be a BICONDITIONAL on `kind = 'reversal'`, which meant
  a refund COULD NOT NAME WHAT IT REFUNDS — so every `dispute_refund` and
  `card_refund` since Phase 1 was a floating credit, and nothing could derive
  that a charge had been refunded.
- **A reversal and a refund are different claims about the world.** A reversal
  says it did not happen; a refund says it did, correctly, and the money is
  going back. Collapsing them tells a customer the wrong one.
- **A reversal and a dispute refund MUST name their target; a card refund MAY.**
  The asymmetry is the decision: a merchant refund arrives weeks later through
  a payload whose shape is not ours to guarantee, and refusing it for a missing
  link turns worse reporting into money the customer is owed and does not get.
- **The status is a VIEW, never a column.** A stored `status` is a second copy
  of the ledger and drifts the first time a flow forgets to update it — the
  same reason balances are computed from postings and the velocity rules read
  postings rather than metadata.
- **`refunded` beats `disputed` in the CASE.** An upheld dispute is both, and
  the refund is the one that changed the balance; `disputed` is reserved for a
  claim still open, which is the state where somebody is waiting on us.
- Resolving Bitnob's `authorization_id` to one of our entry ids happens in
  `CardWebhookService`, **scoped to the card** — `provider_txn_id` is unique
  per card, not globally, so an unscoped match could attach one customer's
  refund to another customer's charge.

### Sign-in events — non-obvious rules

Schema: `packages/ledger/sql/024_sign_in_events.sql`. Service in
`apps/api/src/auth/sign-in-events.service.ts`.

- **The FAILURES are the half that was missing.** A password sprayed across
  four hundred accounts produced four hundred refusals and no rows at all, so
  the attack easiest to see from outside was the one nothing here could see.
- **A success is recorded on the login's OWN transaction; a failure is not.**
  `login()` throws on a refusal and its transaction rolls back, so a failure
  written on that client is a failure that is never written — and a
  'succeeded' row that commits while its session rolls back is a claim that
  somebody signed in when nobody did. Hence two methods, not one with a flag.
- **The country comes from Cloudflare's `CF-IPCountry`, not a geo-IP lookup.**
  The edge already computes it, so there is no provider to keep current and
  nothing extra to be down. It is trusted on exactly the terms
  `x-forwarded-for` is: it describes a sign-in and never authorises one.
- **The identifier is stored as a SHA-256 hash.** A failed attempt against an
  address that matched no account is somebody else's email, put there by
  whoever guessed it; in the clear this table is a list of addresses under
  attack.
- **Familiarity is read from SUCCESSES only, and asked before the current
  event is written.** Either mistake silences the alert permanently — counting
  failures makes one guess enough to make an address familiar; writing first
  makes every place familiar the moment it is used.
- **An unplaceable sign-in raises nothing.** A missing address must not
  manufacture an alert on every request from a client we cannot place.
- **`new_location` is sent only when the DEVICE is already known.** A takeover
  normally arrives on new hardware and `new_device` covers it; this is the case
  that message cannot see. Sending both would mail the customer twice about one
  event.
- **Credential stuffing is counted on DISTINCT identifiers, not attempts.** The
  login limiter already caps attempts per identifier, which is what makes an
  attacker spread across identifiers — so the spread is what is worth counting.
- **A shared address is a lead, not a verdict.** Nigerian carriers put whole
  subscriber pools behind a handful of addresses — the same fact that made the
  request limiter count per customer. A shared DEVICE is the much stronger
  claim.
- Append-only, with 019's one relaxation: an UPDATE is refused at any age, and
  a DELETE only for rows past `retention_sign_in_events_days` — the same
  setting `apply_retention()` reads, so the sweep and the trigger cannot
  disagree about which rows are still evidence.

### One person, one account — non-obvious rules

Schema: `packages/ledger/sql/025_bvn_uniqueness.sql`. Primitive in
`packages/identity/src/blind-index.ts`.

- **Every per-customer control assumes a person cannot become several
  customers.** The daily ceiling, the new-recipient count, the hourly
  velocity — all per customer, and all meaningless if one BVN can open twenty
  accounts. Nothing stopped that.
- **`bvn_sealed` cannot answer "is this BVN already here?"** The envelope's IV
  is random, so one BVN sealed twice is two different strings. `bvn_last4`
  collides one submission in ten thousand, so a rule built on it would refuse
  honest customers.
- **A blind index is an HMAC, and the key is what makes it safe.** A BVN is
  eleven digits: an unkeyed digest of one is a few hours of hashing away from
  being the BVN.
- **`KYC_BLIND_INDEX_KEY` is SEPARATE from the encryption keyring.** A blind
  index cannot have two live keys — matching requires exactly one — so
  rotating it means recomputing every fingerprint with
  `scripts/backfill-bvn-fingerprint.mjs`. Tying it to a keyring that rotates
  for unrelated reasons would break the control at whatever moment somebody
  rotated the other thing.
- **The column is NOT NULL, and 025 REFUSES to apply to a database that
  already holds submissions.** A nullable fingerprint is the silent-off
  failure: one submission written without one slips past the unique index and
  nothing fails. The BVNs are sealed, so only the application can backfill.
- **It refuses at APPROVAL, not at submission.** A form answering "that BVN is
  already registered" confirms, to anybody holding a stolen BVN, that its
  owner banks here. `kyc_bvn_collisions` shows the reviewer the collision
  first — and carries no BVN and no fingerprint.
- **The unique index is partial on `approved`.** Pending must be accepted so a
  reviewer can decide; rejected must not block a customer whose first
  photograph was unreadable.
- **`kyc_blind_index_versions` must report exactly one version**, and the
  invariant suite fails otherwise. While two are in use the index cannot see
  across the boundary and two accounts on one BVN are both approvable.

### Provider credentials — non-obvious rules

Schema: `packages/ledger/sql/026_provider_credentials.sql`, seeded by
`026_provider_credentials.seed.sql`. Screen at `/admin/credentials`.

- **A secret is NOT a `platform_settings` row**, and the reason is two features
  of that table. `platform_settings_history` records every value a row has ever
  held, and `POST /v1/admin/settings/:key` writes the new value into the
  append-only audit log. Both are exactly right for a fee; applied to an API
  key, rotating one would leave the compromised value in two tables that can
  never be scrubbed.
- **A credential goes IN and never comes back out over HTTP.** There is no
  endpoint that returns one — not sealed, not masked. `secretFor()` is for an
  adapter, in process; `status()` is what the dashboard sees. An e2e asserts
  the key appears in no admin response body.
- **The hint is FOUR characters, by CHECK.** "Just enough to recognise it"
  becomes "most of it" the first time somebody is debugging in a hurry, and
  then a dashboard screenshot carries a working credential — the same lesson
  `cards.last4` records.
- **The rotation log records WHO AND WHEN AND NEVER WHAT**, is written by
  trigger rather than by the endpoint (so a psql prompt cannot skip it), and is
  append-only.
- **The database is authoritative; the environment is the fallback** — the same
  order as settings, and the reason a key can be replaced during an incident
  without a deploy. It fails silently the other way, so bootstrap names every
  environment credential the database is overriding.
- **The cache is FIVE seconds, not thirty.** The reason to replace one of these
  is usually that it has leaked, and a key that keeps working for half a minute
  after an operator revoked it is not revoked. `set()` clears its own entry.
- **A slot must exist in the catalogue**, or the paste is refused. A credential
  nothing reads is one an operator believes is live.
- **`in_use = FALSE` marks a slot documented ahead of its adapter** — Dojah's
  are, today. The key is stored safely and read by nothing, and both the API
  and the dashboard say so, because a filled box on an operations screen reads
  as "this is running".

### Transaction monitoring — non-obvious rules

Schema: `packages/ledger/sql/027_risk_signals.sql`, seeded by
`027_risk_signals.seed.sql`. Worker in `apps/api/src/risk/monitoring.service.ts`,
queue at `/admin/risk`.

- **A signal is an OBSERVATION, never a verdict.** Nothing here refuses,
  freezes or holds — it runs after the fact by construction. The controls that
  ACT (the daily ceiling, the velocity rules, the card freezes) run before
  money moves and are tuned to almost never fire, because a false positive
  there refuses a customer their own money. Monitoring can afford to be far
  more suspicious because a false positive costs a reviewer a minute.
- **Every rule reads POSTINGS**, and `027_risk_signals.test.sql` fails the
  build if `detect_risk_signals()` mentions `metadata`. A control depending on
  a key some flow remembered to set switches itself off the first time a new
  flow forgets — and nothing fails when monitoring stops working.
- **Thresholds are per currency, in `risk_thresholds`, not in settings keys.**
  An amount carries units; a kobo figure applied to USDT because both are
  integers is the same mistake as adding kobo to cents. `risk_currency_coverage`
  reports a currency the ledger holds and this file does not watch, and the
  invariant suite fails on one — unmonitored has to be a visible state.
- **`large_value_minor` is a REGULATORY figure and the seed's is a starting
  point.** It must be set to what the NFIU currently requires; a programme
  running on a number somebody copied from a migration is a finding.
- **The daily transfer ceiling ships EQUAL to the NGN reporting threshold**, so
  out of the box no single transfer can reach it and `large_value` fires on
  transfers only if an operator moves one of the two. That is not a fault in
  either — the ceiling stops the transaction the threshold reports, and the
  rule still fires on deposits, card settlements and crypto.
- **`notable_minor` is the floor the proportional rules need.** Without it an
  account moving ₦2,000 in and out fires `rapid_passthrough` daily, and a rule
  people learn to ignore is worse than none — the lesson 015 records about
  alerting. Proved load-bearing by lowering it and watching a test go red.
- **Every insert is `ON CONFLICT (signal_key) DO NOTHING`**, so the sweep is
  idempotent and the advisory lock is an optimisation rather than a correctness
  requirement.
- **A signal is immutable except for its resolution, and a resolution is
  final** — with a person and a reason, both by CHECK. A queue cleared with
  one-word reasons is indistinguishable from one nobody worked, and the reason
  is the only part a regulator can inspect.
- **`RISK_MONITOR_INTERVAL_SECONDS` absent is the silent failure.** Nothing
  errors; the queue is simply empty, which looks exactly like a quiet week. It
  has a DEFAULT on the worker for that reason, unlike the retention sweep.

### Compliance cases — non-obvious rules

Schema: `packages/ledger/sql/028_risk_cases.sql`. Service in
`apps/api/src/risk/case.service.ts`, screen at `/admin/risk/cases`.

- **Closing a case resolves every signal attached to it, by trigger.** That is
  the point of a case rather than a convenience: a reviewer with five signals
  and one story who closes each separately produces a record claiming five
  unrelated reviews happened. The summary becomes each signal's resolution, so
  the trail says the same true thing about all of them.
- **TIPPING OFF IS AN OFFENCE, and it shapes the schema.** Nothing here has a
  customer-facing surface — no endpoint returns a case to its subject and no
  notification kind could mention one. `028_risk_cases.test.sql` fails the
  build if a template appears whose name could tell a customer they are under
  investigation.
- **Signals attach through a JOIN TABLE, not a `case_id` column.** 027 makes a
  signal immutable; adding a column would mean relaxing that trigger, and
  "immutable except for the fields we later needed" is how immutability stops
  being a property.
- **One open case per customer**, by partial unique index. Two reviewers
  investigating one person separately, each seeing half the signals, is exactly
  the failure a case file prevents.
- **A signal can only be attached to a case about the SAME customer**, by
  trigger — otherwise one mistyped id puts another customer's transaction into
  an investigation that then describes somebody never involved.
- **The deadline is the database's clock and cannot be supplied or moved**, the
  same rule 018 applies to a dispute. Here it is a regulator's reporting window
  rather than a courtesy.
- **A `reported` outcome REQUIRES its reference**, by CHECK. A report nobody
  can point at is one nobody can prove was filed.
- **A closed case takes no new notes and cannot reopen.** New information opens
  a new case — otherwise a file decided on one set of facts reads as though it
  was decided on another.
- **The sweep opens a case when a customer accrues
  `risk_case_auto_open_signals` open signals**, with `opened_by` NULL. Noticing
  a pattern otherwise means somebody sorting the queue by customer and
  counting, which is the work nobody does at four in the afternoon — and the
  queue says "opened by the sweep", because counting and judging are different
  starting points.
- **Opening and noting take NO PIN; closing does.** A reviewer writes several
  notes per case, and demanding the factor on each is how a shared
  authenticator ends up on a desk — the lesson 014 records.

### Verification tiers — non-obvious rules

**Every e2e fixture that stands in for KYC approval must set the tier too.**
Approval writes `provider_customers` AND `users.kyc_tier` in one transaction; a
fixture doing only the first describes a customer whom every provider accepts
and whose ceiling is an unverified account's — a state production cannot reach.
A suite whose subject is a different control (the flow ceilings, the monitoring
rules) needs a tier high enough not to confound it, because the limit in force
is the LOWER of the two.

**A suite must PIN what its assertions depend on.** The e2e files share one
database and run in file order with `fileParallelism: false`, and a suite that
narrows a limit does not put it back. `flow-velocity` pins the USDT ceiling to
10 USDT; `crypto` passed only while it happened to run first, and stopped the
day two unrelated files shifted the order. Never change a shared setting
mid-test: for the length of that test every other suite is subject to it.

### Verification tiers — non-obvious rules

Schema: `packages/ledger/sql/029_kyc_tiers.sql`, seeded by
`029_kyc_tiers.seed.sql`. Enforced in `wallet/spending-limits.service.ts`.

- **Every ceiling used to be ONE NUMBER for everybody.** A customer who had
  typed an email address that morning was allowed exactly what a customer whose
  documents a person had read was allowed — wrong in both directions.
- **Three tiers, because three have a REAL PATH to them.** 0 registered, 1
  granted by KYC approval, 2 granted by an administrator who established source
  of funds. The CBN's phone-verified tier is deliberately absent: nothing here
  verifies a phone, so it would be a tier no customer could be in.
- **The ceiling in force is the LOWER of the tier's and the flow's.** A tier
  does not replace `transfer_daily_limit_kobo`, it competes with it — so
  raising somebody's tier can never let them past a limit an operator tightened
  during an incident, and tightening one can never be undone by a tier.
- **`kyc_tier` DEFAULTS TO 0.** A path that forgets to set one produces the
  least trusted account, not the most. A default of 1 would mean a registration
  endpoint that skipped verification handed out verified limits and nothing
  failed.
- **The tier is read on EVERY check, not cached.** The reason to lower one is
  usually that something is wrong with the account, and a ceiling that keeps
  its old value for thirty seconds has not been lowered.
- **A missing limits row returns undefined, never zero.** Zero is a real limit
  — it is how "no crypto without an identity" is expressed — so collapsing the
  two would turn a coverage gap into a customer who cannot move their own
  money, indistinguishably.
- **`kyc_tier_coverage` must be complete**, and the invariant suite fails on a
  gap. There is deliberately no fallback, so a gap would not be a smaller limit
  but none at all.
- **Each tier rests on the one below it, by trigger.** 0 → 2 is refused: giving
  enhanced due diligence to somebody whose identity was never checked makes the
  higher ceiling rest on nothing. Going DOWN is unrestricted — finding out we
  were wrong must never be harder than the mistake.
- **KYC approval sets the tier in the SAME transaction**, and only `WHERE
  kyc_tier < 1` — a routine re-review must not silently demote an enhanced
  customer.
- **The customer can see their own ceiling** at `GET /v1/kyc/limits`. Being
  refused with no way to learn what would change is what turns a control into a
  support ticket.
- **A tier does NOT cap a balance**, and that absence is a decision. Capping one
  means refusing money that has already arrived, and the only honest answers —
  hold it in suspense, or send it back — are products with support paths and
  customer messages. Inventing one inside a limits migration is the wrong place
  to decide it.

### Disputes — non-obvious rules

Schema: `packages/ledger/sql/018_disputes.sql`.

```
Raise     (nothing)                            a claim, not a transaction
Accept    expense_dispute_loss -> wallet       we bear it; APPENDED
Reject    (nothing)                            no entry ever existed
Withdraw  (nothing)                            the customer changed their mind
```

- **Raising posts nothing.** A claim is an assertion about a fact, not a fact.
  Crediting on one makes "dispute everything" a free withdrawal, and reversing
  that credit later takes money from a customer who has spent it.
- **There is NO clawback from the recipient**, and its absence is a decision. A
  bank can reach into the other side because both sides sit inside one
  regulated system; we cannot, and debiting our own customer on our own say-so
  would overdraw somebody who may have done nothing wrong. An upheld dispute is
  our loss, posted to its own expense account rather than netted against
  revenue — so somebody has to look at the number.
- **A customer cannot dispute an entry they have no leg in**, enforced by
  trigger and read from postings. The API answers the SAME 404 for "not yours"
  and "does not exist": distinguishing them turns the complaints form into a
  way to enumerate other people's transactions.
- **The deadline is the database's clock**, cannot be supplied and cannot be
  moved. A process that can push its own deadline out has no deadline.
- **An outcome is final.** Reopening an accepted dispute pays the refund twice;
  reopening a rejected one erases that it was refused. New evidence raises a
  NEW dispute — which the partial unique index deliberately permits.
- **Raising and withdrawing take NO transaction PIN.** The customer most likely
  to raise one has just discovered somebody else is in their account, and
  demanding the factor that person may already have is worst exactly then.
- `/v1/admin/disputes` uses its **own** `dispute_reviewer` role, not the gift
  card reviewer's.

### Data retention — non-obvious rules

Schema: `packages/ledger/sql/019_retention.sql`. Worker in
`apps/api/src/retention/retention.service.ts`.

- **Two laws pull opposite ways.** AML requires records of a relationship for
  five years after it ends; the NDPA forbids keeping personal data longer than
  needed. A policy implementing one is the one that gets a licence looked at.
- **This is the only scheduled job whose purpose is to destroy data**, so the
  ledger is protected structurally: `apply_retention()` does not NAME a ledger
  table, and there is no dynamic SQL, because a deletion job whose behaviour is
  changed by an INSERT is changed by an INSERT.
- **`retention_coverage` lists every table against its decision**, and the
  invariant suite fails on an UNDECIDED row in both directions. A deletion job
  is a list of what somebody thought of; the tables nobody thought of are the
  ones that accumulate customer data for years.
- **Never delete a PENDING notification or a LIVE token.** The first drops a
  password reset somebody is waiting on; the second signs a customer out for
  housekeeping. Both have tests.
- **`card_reveals` is kept, deliberately.** A trail a scheduled job can delete
  from is one an intruder can prune. The way to hold less there is to store
  less, which it already does.
- **`staff_totp_used_steps` is the one relaxation of an append-only rule**, and
  only for rows older than the window in which a code could still be presented.
  An UPDATE stays refused outright at any age.
- **The privacy notice is rendered from this schema.** `retention-table.test.ts`
  fails the build if a period the page quotes disagrees with the setting the
  sweep reads. A notice nothing checks describes what somebody intended.

### Notifications — non-obvious rules

Schema: `packages/identity/sql/012_notifications.sql`. The outbox, the port
(`ports/notification.ts`) and the Resend adapter.

- **Nothing sends inline.** A message is a ROW written in the SAME transaction
  as the event that owed it. Sending inside the transaction mails receipts for
  money that then rolls back; sending after it loses messages when the process
  dies in the gap; either way a slow provider becomes a slow login.
- **The body is SEALED** (`^v[0-9]+:` CHECK) and a delivered message has its
  body ERASED. A rendered password reset email contains a live bearer token, so
  an unsealed outbox is a list of account-takeover links; the safest place for a
  spent secret is nowhere.
- **A notification timeout IS retryable** — the only place in this codebase
  where that is true. For money, not knowing whether the provider acted means
  do nothing and reconcile. Here, not sending is worse than sending twice, and
  the provider's idempotency key makes asking again safe. Written down twice
  because the rest of the codebase trains the opposite instinct.
- **`enqueueBestEffort` uses a SAVEPOINT**, and that is what makes it
  best-effort. Any error inside a Postgres transaction poisons it, so a
  try/catch around the insert takes the customer's transfer down with the
  receipt reporting it.
- **`available` is not `deliverable`.** The first asks whether a message can be
  enqueued (a keyring); the second whether anything will send it (a provider). A
  flow whose whole purpose is the message must ask the second — password reset
  asked the first and told locked-out customers to check an inbox nothing would
  reach.
- **Every template escapes every interpolated value.** A device platform string
  or a withdrawal address is outside-controlled, and unescaped it is a script
  tag in a message the customer has every reason to trust.
- **Money is grouped by `groupDigits`, never `Intl.NumberFormat`** — the
  client's rule, in the other place a customer reads an amount.
- **`coverage.test.ts` fails the build on a template nothing enqueues.** A
  `new_device` template nobody calls is an account-takeover alert that will
  never fire.

### Password reset — non-obvious rules

Schema: `packages/identity/sql/013_password_reset.sql`.

- **Consumption is a database function**, for the same reason rotation is:
  SELECT-then-UPDATE lets two requests carrying one stolen token both reset the
  password, and the second locks the customer out of the account they just
  recovered.
- **Only the hash is stored**, `^[0-9a-f]{64}$`, same as refresh tokens.
- **Using a token revokes EVERY live session.** Finishing a reset while an
  intruder is still signed in is theatre.
- **`/forgot` answers 204 for every valid identifier**, real or not, and mints
  and hashes a token either way so the two paths do not differ in timing. An
  endpoint that answers differently turns any address list into a customer list.
- **`/reset` issues NO tokens.** A leaked link grants a password that can be
  used, not a live session.
- **Rate limited on its OWN bucket**, far tighter than login: each accepted
  request mails somebody who did not ask for it, and a shared counter would stop
  a customer who mistyped their password from asking for a reset.
- **The reset link's origin is configuration, never a request header.** A `Host`
  an attacker controls turns our own email into a credential harvester.

### The staff second factor — non-obvious rules

Schema: `packages/identity/sql/014_staff_totp.sql`. TOTP in
`packages/identity/src/totp.ts`, verified against RFC 6238's own vectors.

- **Hand-written, and that is not a contradiction.** The rule about crypto is
  never write the PRIMITIVE and never trust an implementation no published
  vector has judged. This is a construction over Node's HMAC-SHA1 with six
  published vectors in the test file. SHA-1 is correct here and only here.
- **The replay table is the point.** A code is valid for 90 seconds — ample time
  to read six digits off somebody's screen. The counter value is recorded and a
  UNIQUE constraint refuses the second attempt.
- **A CONFIRMED secret cannot be swapped in place.** The quiet attack is a stolen
  session re-enrolling the factor onto the attacker's authenticator; nothing in
  the audit log looks odd, because changing phones is normal. Replacing one is an
  administrator's action.
- **A verified code ELEVATES THE SESSION for ten minutes.** Demanding a fresh
  code per action is unusable — codes are single-use and change every thirty
  seconds, so a reviewer working a queue is refused on their second approval, and
  the outcome is a shared authenticator on a desk. The PIN is still required on
  every acting request inside the window.
- **Enrolment is required on EVERY staff route, reads included.** Gating only the
  acting half leaves the customer database behind one password.
- **`claims.sub` is a UUID, not the numeric id.** Every query here resolves it.

### Error capture — non-obvious rules

Schema: `packages/ledger/sql/015_error_events.sql`.

- **The fingerprint is the design.** Errors name what they failed on, so without
  normalising identifiers out, one bug is a thousand rows and the table is a log.
  Too coarse and two bugs share a row; neither failure is visible from a green
  test run.
- **A 4xx is not an error.** A wrong PIN is the system working, and recording it
  buries the row that matters.
- **Recording can never fail the request.** `record_error` is one
  `ON CONFLICT DO UPDATE`, and the service swallows everything and holds a
  re-entry guard so a broken database cannot recurse through its own reporter.
- **The route PATTERN is stored, never the resolved path** — otherwise every
  customer gets their own fingerprint and their id lands in a table read by
  everyone on call.
- **Alerting speaks twice only**: an unseen fingerprint, or one an order of
  magnitude worse than when we last spoke. "It happened again" is true of every
  open bug, and a rule people mute is worse than none.

### apps/api

- `AuthGuard` is registered with `APP_GUARD`, so it runs for **every** route. A
  route with no entry in `auth/routes.ts` is refused, and
  `route-coverage.test.ts` fails the build if a controller declares one the
  policy does not (and vice versa, so the audit cannot describe a route that no
  longer exists).
- **`route-coverage.test.ts` reads the controller list off `AppModule`.** It
  was a hand-written array with a comment saying it and `app.module.ts` must
  stay in step; they did not, and three controllers — health, KYC and the whole
  admin surface — were imported into the module and left out of its
  `controllers` list. Every one of their routes answered 404 in the built
  bundle while this test reported full coverage. Do not reintroduce a literal
  list here.
- **A route that answers 204 must not be given a body.** The web proxy did
  exactly that and turned "set your transaction PIN" into a 500.
- A route declaring `pin: true` has its transaction PIN verified by `AuthGuard`
  before the handler runs. The PIN is read from the request body, and the check
  happens **after** the bearer token — verifying a PIN for a caller whose
  session is forged would spend one of that customer's five attempts on a
  request they never made, which is a way to lock anyone out of their own money.
- Nest's route metadata keys are hardcoded in `route-key.ts`, not imported from
  `@nestjs/common/constants`: that module is unresolvable under native ESM and
  the failure only appears once the bundle starts. A canary test asserts the
  literals still match.
- DI uses explicit `@Inject` tokens throughout. esbuild — what vitest
  transpiles with — does not emit `design:paramtypes`, so type-inferred
  injection compiles and then fails at runtime.
- Rate limiting has two backends behind `RateLimitStore`, chosen by whether
  `REDIS_URL` is set. Both are held to **one shared contract suite**
  (`rate-limit.contract.ts`) — the point of Redis is that every instance gives
  the same answer, and two hand-written suites would drift into testing two
  behaviours while staying green. Without `REDIS_URL` the limiter is
  in-process and bootstrap logs a warning; that is correct for one box only.
- The Redis limiter is a **Lua script, not three commands**. Prune-count-add
  over separate round trips is a read-modify-write, and under the concurrency
  that justifies running Redis at all, several instances each read "room
  available" and each write. JavaScript's single thread gave the in-memory
  store that atomicity for free; Redis has to be told.

---

## Providers

Live set: **Bitnob** (NGN virtual accounts, crypto, USDT, stablecoin, virtual
USD cards, FX),
**VTpass** (airtime, data, bills), **Airalo** (eSIM), **Twilio** (virtual
numbers), **Resend** (email).

Do **not** reintroduce Reloadly, Maplerad, Anchor, Paystack or ALAT. They appear in
the reference plugin and are out of scope.

### Bitnob specifics — verified from their docs

- **Card spend is two events, not one.** Authorization, then Settlement up to 7–14
  business days later, each with its own webhook. If no settlement arrives the hold
  expires and funds return. Bitnob's own docs warn that treating them as one
  transaction produces an incorrect balance. This is why the `customer_pending`
  account exists: auth moves card → pending, settlement moves pending → float,
  expiry is an ordinary reversal.
- **A card spends its OWN balance, not the wallet.** A Bitnob virtual card is
  topped up from the wallet and holds its own funds. Authorising against the
  wallet would let a card funded with $10 spend whatever the wallet held. The
  overdraft guard already covers `customer_card`, so naming the right account
  *is* the protection.
- **Webhook amounts are micro-units: 1 USD = 1,000,000.** Six decimals where the
  ledger uses two. The sibling `display_amount` is a **float** and must never touch
  ledger maths — it is for display only. Conversion happens at exactly one audited
  boundary inside the adapter, with its own tests.
- Webhook `event_id` is the natural source for `idempotency_key`. Format the key as
  `bitnob:<event_id>` so two providers cannot collide.
- JSON keys in webhook payloads are snake_case. Request bodies to their REST
  API are **camelCase** (`customerEmail`, `cardId`) — the two do not match, and
  both are verified against their official Node SDK.
- The webhook signature is **HMAC-SHA512**, hex, in `x-bitnob-signature`. It was
  SHA-256 here on the strength of "everyone uses SHA-256", which would have
  rejected every webhook in production and looked like a bad secret.
- Card endpoints have **no per-card sub-resources**. Every operation is a flat
  POST to a verb path (`/virtualcards/freeze`) with `cardId` in the body, under
  a base URL that includes `/api/v1`.
- Card issuing **requires approval** from Bitnob before use. The card webhook
  EVENT NAMES are the one thing still unconfirmed, and they resolve as part of
  that approval — an unrecognised event throws and is retried, so a wrong name
  is loud rather than a dropped spend.

### The fulfilment port

VTpass, Airalo and Twilio implement **one** port (`ports/fulfilment.ts`) and are
held to **one** contract suite (`ports/fulfilment.contract.ts`). Three
hand-written suites drift into testing three behaviours while all staying green,
and the whole point of a port is that a caller cannot tell which implementation
answered. Add an adapter, add it to the contract.

Per-provider quirks are absorbed inside the adapter and stop there: VTpass codes
(`000` success, `099` pending) and naira-as-text amounts, Airalo's OAuth2 token
cache, Twilio's form-encoded bodies. None of that shape reaches a caller.

Twilio is priced by **us**, not by Twilio: `priceCents` is what the customer pays,
and an instance that has not set it cannot sell a number.

**VTpass's `request_id` is derived, never generated.** It must start with a
`YYYYMMDDHHMM` stamp in Africa/Lagos, so `PurchaseRequest` carries `initiatedAt`
— the purchase row's `created_at` — and `vtpassRequestId()` builds the same
string every time from it. Reading the clock instead would give a retry a new
id (a second purchase, to VTpass) and leave reconciliation requerying an id that
never existed.

**Airalo signs every body it sends**: `airalo-signature`, HMAC-SHA512 of the
payload's JSON, keyed by the client secret. The token exchange is the awkward
one — form-encoded on the wire, signed as JSON. The adapter serialises once and
signs the exact string it sends, so the two cannot drift.

### Working in `packages/providers`

- An adapter never writes postings. It produces a `LedgerIntent` — a *request*
  for a journal entry naming accounts by ROLE — and hands it over. Resolving a
  role to an account id is the ledger's job.
- `LedgerIntent` postings carry `amountMinor` + `currency` rather than `Money`,
  because `Money` is invariant: a bare `Money` field means `Money<Currency>` and
  would reject every real caller. Build legs with `posting()`, which is generic
  and cannot mix an amount up with the wrong code.
- All micro-unit conversion lives in `bitnob/amounts.ts` and nowhere else. A
  second conversion inline at a call site is how a settlement ends up off by a
  factor of 10,000.
- `parseMicro` **rejects** a JSON number beyond `MAX_SAFE_INTEGER` rather than
  coercing it. By then `JSON.parse` has already rounded it and the lost unit is
  unrecoverable; the fix is to ask the provider for a string.
- A sub-cent remainder is **recorded, never posted**. A cent is the smallest
  unit the ledger can hold, so posting a whole one would invent the rest.
- `ProviderTimeoutError` is deliberately **not** retryable. A timeout means we
  do not know whether the provider acted, and the naive retry is how one card
  funding becomes two. Reconcile instead.
- Every provider's endpoint table, auth scheme and signature is **verified
  against that provider's own SDK or published docs**, and each says which in a
  header comment. When one of these was a guess it was wrong — every Bitnob
  card path, and the webhook hash — so treat an unsourced constant here as a
  bug rather than a detail.

---

## The clients (`apps/web`, `apps/mobile`, `packages/client`)

Both apps go through **one** client package. Adding a screen should not mean
writing another fetch wrapper.

- **Single-flight refresh is the client's job**, assigned to it by Phase 2. One
  in-flight rotation; every other caller awaits the same promise. Without it, a
  screen firing several requests on mount replays a refresh token and the
  server correctly revokes the device family. The `Session` must therefore be a
  **singleton** — the latch lives on the instance.
- **THE WEB NEEDS A SECOND LATCH, on the token store.** `Session.refresh()` is
  not the only path that rotates: on a fresh page load nothing is in memory, so
  every caller of `TokenStore.read()` goes to `/api/auth/refresh` to exchange
  the cookie — and `read()` is what every request calls first. Two components
  loading on mount sent two refreshes carrying the same cookie and signed the
  customer out for opening a page. The latch that existed was real, correct,
  and on the wrong function.
- **Money is a string on the client and stays one.** `formatAmount` groups
  digits without producing a number, and there is no `toNumber`. `Intl.NumberFormat`
  takes a number and is wrong here.
- **Where the refresh token lives is per-platform and is a `TokenStore`**: an
  httpOnly `SameSite=strict` cookie on web (set by the app's own route
  handlers), the Keychain/Keystore on mobile. Never `localStorage`, never
  `AsyncStorage`.
- **Biometrics unlock the PIN; they do not replace it.** Mobile stores the real
  PIN in the Keychain behind `requireAuthentication: true` and sends it to the
  server exactly as if typed. No endpoint accepts "passed Face ID" in place of
  a PIN, and `002_identity.sql` refuses enrolment for a user with no PIN.
  Enrolment confirms the PIN via `POST /v1/auth/pin/verify` first, so a wrong
  one is never stored to be discovered on a real transfer. Sign-out forgets it.
- **The web app proxies the API same-origin** through `/api/x/*`, so there is
  no CORS policy and the API's address is never published to the page.
- **An idempotency key belongs to the attempt**, generated when a form mounts
  and reused across retries — never inside the submit handler.
- **An unrecognised error code becomes `unknown`**, never passed through: a
  proxy must not be able to inject a code a caller's `switch` handles.
- Both bundlers need telling that `.js` specifiers mean `.ts` sources — Next
  via `resolve.extensionAlias`, Metro via `resolveRequest`.
- **The web's Content-Security-Policy lives in `middleware.ts`, not
  `next.config.mjs`**, because it carries a per-request nonce and a build-time
  config cannot make one. A static `script-src 'self'` blocks Next's own inline
  bootstrap, and the page then renders its HTML and never hydrates — every
  button inert, and a screenshot that looks perfect. Reading the nonce in the
  root layout is what forces per-request rendering so Next can stamp it.
- **Every customer-facing screen is behind the shared hooks in `lib/hooks.ts`.**
  `useIdempotencyKey` belongs to the ATTEMPT — generated when the form mounts,
  reused across retries, replaced only after a success.

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
npm test                                # all workspaces, via turbo
npm test --workspace @xetral/shared     # money primitives (vitest)
npm test --workspace @xetral/identity   # tokens, PIN, envelopes, policy (vitest)
npm test --workspace @xetral/api        # guard, route coverage, rate limiting
npm test --workspace @xetral/providers  # conversion, webhooks, card and fulfilment adapters
npm test --workspace @xetral/ledger     # intent validation (service is e2e-only)
npm test --workspace @xetral/client     # money formatting, single-flight, error codes

# SQL invariants — needs live PostgreSQL 16. Apply migrations in order; the
# test files are NOT idempotent, so run them against a freshly created database.
createdb xetral
psql -d xetral -v ON_ERROR_STOP=1 -f packages/ledger/sql/001_ledger.sql
psql -d xetral -v ON_ERROR_STOP=1 -f packages/identity/sql/002_identity.sql
psql -d xetral -v ON_ERROR_STOP=1 -f packages/ledger/sql/003_cards.sql
psql -d xetral -v ON_ERROR_STOP=1 -f packages/ledger/sql/004_purchases.sql
psql -d xetral -v ON_ERROR_STOP=1 -f packages/ledger/sql/005_giftcards.sql
psql -d xetral -v ON_ERROR_STOP=1 -f packages/ledger/sql/006_funding.sql
psql -d xetral -v ON_ERROR_STOP=1 -f packages/ledger/sql/007_crypto.sql
psql -d xetral -v ON_ERROR_STOP=1 -f packages/ledger/sql/008_fx.sql
psql -d xetral -v ON_ERROR_STOP=1 -f packages/ledger/sql/009_admin.sql
psql -d xetral -v ON_ERROR_STOP=1 -f packages/ledger/sql/009_admin.seed.sql
psql -d xetral -v ON_ERROR_STOP=1 -f packages/ledger/sql/010_card_protection.sql
psql -d xetral -v ON_ERROR_STOP=1 -f packages/ledger/sql/011_ledger_immutability.sql
psql -d xetral -v ON_ERROR_STOP=1 -f packages/identity/sql/012_notifications.sql
psql -d xetral -v ON_ERROR_STOP=1 -f packages/identity/sql/013_password_reset.sql
psql -d xetral -v ON_ERROR_STOP=1 -f packages/identity/sql/014_staff_totp.sql
psql -d xetral -v ON_ERROR_STOP=1 -f packages/ledger/sql/015_error_events.sql
psql -d xetral -v ON_ERROR_STOP=1 -f packages/ledger/sql/016_card_reveals.sql
psql -d xetral -v ON_ERROR_STOP=1 -f packages/ledger/sql/017_transfer_velocity.sql
psql -d xetral -v ON_ERROR_STOP=1 -f packages/ledger/sql/018_disputes.sql
psql -d xetral -v ON_ERROR_STOP=1 -f packages/ledger/sql/019_retention.sql
psql -d xetral -v ON_ERROR_STOP=1 -f packages/ledger/sql/020_balance_reconciliation.sql
psql -d xetral -v ON_ERROR_STOP=1 -f packages/ledger/sql/021_flow_velocity.sql
psql -d xetral -v ON_ERROR_STOP=1 -f packages/ledger/sql/023_entry_status.sql
psql -d xetral -v ON_ERROR_STOP=1 -f packages/ledger/sql/024_sign_in_events.sql
psql -d xetral -v ON_ERROR_STOP=1 -f packages/ledger/sql/025_bvn_uniqueness.sql
psql -d xetral -v ON_ERROR_STOP=1 -f packages/ledger/sql/026_provider_credentials.sql
psql -d xetral -v ON_ERROR_STOP=1 -f packages/ledger/sql/026_provider_credentials.seed.sql
psql -d xetral -v ON_ERROR_STOP=1 -f packages/ledger/sql/027_risk_signals.sql
psql -d xetral -v ON_ERROR_STOP=1 -f packages/ledger/sql/027_risk_signals.seed.sql
psql -d xetral -v ON_ERROR_STOP=1 -f packages/ledger/sql/028_risk_cases.sql
psql -d xetral -v ON_ERROR_STOP=1 -f packages/ledger/sql/029_kyc_tiers.sql
psql -d xetral -v ON_ERROR_STOP=1 -f packages/ledger/sql/029_kyc_tiers.seed.sql
psql -d xetral -v ON_ERROR_STOP=1 -f packages/ledger/sql/099_least_privilege.sql
psql -d xetral -v ON_ERROR_STOP=1 -f packages/ledger/sql/001_ledger.test.sql
psql -d xetral -v ON_ERROR_STOP=1 -f packages/identity/sql/002_identity.test.sql
psql -d xetral -v ON_ERROR_STOP=1 -f packages/ledger/sql/003_cards.test.sql
psql -d xetral -v ON_ERROR_STOP=1 -f packages/ledger/sql/004_purchases.test.sql
psql -d xetral -v ON_ERROR_STOP=1 -f packages/ledger/sql/005_giftcards.test.sql
psql -d xetral -v ON_ERROR_STOP=1 -f packages/ledger/sql/006_funding.test.sql
psql -d xetral -v ON_ERROR_STOP=1 -f packages/ledger/sql/007_crypto.test.sql
psql -d xetral -v ON_ERROR_STOP=1 -f packages/ledger/sql/008_fx.test.sql
psql -d xetral -v ON_ERROR_STOP=1 -f packages/ledger/sql/009_admin.test.sql
psql -d xetral -v ON_ERROR_STOP=1 -f packages/ledger/sql/010_card_protection.test.sql
psql -d xetral -v ON_ERROR_STOP=1 -f packages/ledger/sql/011_ledger_immutability.test.sql
psql -d xetral -v ON_ERROR_STOP=1 -f packages/identity/sql/012_notifications.test.sql
psql -d xetral -v ON_ERROR_STOP=1 -f packages/identity/sql/013_password_reset.test.sql
psql -d xetral -v ON_ERROR_STOP=1 -f packages/identity/sql/014_staff_totp.test.sql
psql -d xetral -v ON_ERROR_STOP=1 -f packages/ledger/sql/015_error_events.test.sql
psql -d xetral -v ON_ERROR_STOP=1 -f packages/ledger/sql/016_card_reveals.test.sql
psql -d xetral -v ON_ERROR_STOP=1 -f packages/ledger/sql/017_transfer_velocity.test.sql
psql -d xetral -v ON_ERROR_STOP=1 -f packages/ledger/sql/018_disputes.test.sql
psql -d xetral -v ON_ERROR_STOP=1 -f packages/ledger/sql/019_retention.test.sql
psql -d xetral -v ON_ERROR_STOP=1 -f packages/ledger/sql/020_balance_reconciliation.test.sql
psql -d xetral -v ON_ERROR_STOP=1 -f packages/ledger/sql/023_entry_status.test.sql
psql -d xetral -v ON_ERROR_STOP=1 -f packages/ledger/sql/024_sign_in_events.test.sql
psql -d xetral -v ON_ERROR_STOP=1 -f packages/ledger/sql/025_bvn_uniqueness.test.sql
psql -d xetral -v ON_ERROR_STOP=1 -f packages/ledger/sql/026_provider_credentials.test.sql
psql -d xetral -v ON_ERROR_STOP=1 -f packages/ledger/sql/027_risk_signals.test.sql
psql -d xetral -v ON_ERROR_STOP=1 -f packages/ledger/sql/028_risk_cases.test.sql
psql -d xetral -v ON_ERROR_STOP=1 -f packages/ledger/sql/029_kyc_tiers.test.sql
psql -d xetral -v ON_ERROR_STOP=1 -f packages/ledger/sql/099_least_privilege.test.sql

# API flows end to end. Needs both services: Postgres for the auth flows,
# Redis for the rate-limiter contract.
DATABASE_URL=postgres://... REDIS_URL=redis://localhost:6379 npm run test:e2e
```

CI (`.github/workflows/ci.yml`) runs all of the above against Postgres 16 and
Redis 7, then **boots both built bundles and probes them**. The API must mount
health, admin and KYC — a 404 there fails the build, because three controllers
were once imported and never added to the module — answer 401 on a guarded
route, and answer 401 rather than 500 to three forged webhooks. The web app is
served and its HTML is read: every `<script>` must carry the CSP nonce from the
response header, because a page whose scripts the browser refuses is a page
that renders perfectly and does nothing.

That step is not ceremony. **Eight** failures in this app have now been
invisible to both the compiler and the tests and appeared only when something
was actually started. See `docs/AUDIT.md`.

## Deployment

Configuration is in `deploy/`. Coolify on Hetzner, Cloudflare in front, GitHub
Actions CI, EAS for mobile builds.

**Three nodes**: `app` (API, web, Redis — the only public address),
`db-primary`, `db-standby`, on a private network with streaming replication.
Never collapse these onto one box: a single disk failure would end the records
of a business holding customer deposits, and the database would be one firewall
mistake from the internet.

- **Promotion refuses to run** until an operator confirms the old primary is
  stopped. Two databases both accepting writes give two divergent sets of
  postings and no way to say which is real.
- **Replication is not backup.** A mistaken `DELETE` replicates faithfully in
  under a second; `deploy/standby/backup.sh` is what survives it.
- **The single-instance workers** (`RECONCILE_INTERVAL_SECONDS`,
  `DEPOSIT_RECONCILE_INTERVAL_SECONDS`, `CRYPTO_RECONCILE_INTERVAL_SECONDS`,
  `CRYPTO_DEPOSIT_RECONCILE_INTERVAL_SECONDS`,
  `GIFTCARD_RELEASE_INTERVAL_SECONDS`, `NOTIFICATION_INTERVAL_SECONDS`,
  `ERROR_ALERT_INTERVAL_SECONDS`, `BALANCE_RECONCILE_INTERVAL_SECONDS`,
  `RISK_MONITOR_INTERVAL_SECONDS`) go on exactly one instance —
  `docker-compose.app.yml` does this by blanking them on `api` and setting them
  on `worker`. `NOTIFICATION_INTERVAL_SECONDS` is the one whose absence is
  silent in the worst way: rows accumulate, the API answers "check your email",
  and nothing is ever sent.
- **Backups are encrypted to a PUBLIC key** the database host cannot decrypt,
  shipped off the box, and **restored by `standby/restore-drill.sh`** on a
  schedule. The drill does not stop at "Postgres started" — a truncated copy
  starts perfectly and is missing a week — it runs `verify-restore.sql`, which
  asks whether every entry still sums to zero per currency and whether the
  materialised balances still agree with the postings. An untested backup is a
  hope with a cron entry.

### Staging — non-obvious rules

Config: `deploy/docker-compose.staging.yml`, `deploy/.env.staging.example`.

- **`XETRAL_ENVIRONMENT` is required and has no default.** Neither default is
  safe enough to be worth having: a staging box falling back to `production`
  would merely be strict, while a production box falling back to `staging`
  would relax the guards protecting real customers.
- **Staging REFUSES TO BOOT pointed at a live provider**, naming every
  offending variable at once. Not a warning — the process exits. A staging box
  that can reach live Bitnob issues real cards and spends real money, and the
  person who makes that mistake will be copying a production `.env` to get
  something working quickly. Failing at startup costs a deploy; failing on the
  first card issue costs a customer.
- **The notification worker will not email an address outside
  `NOTIFICATION_ALLOWLIST`, and empty means NOBODY.** A staging database is
  usually restored from a production backup — the only way to test against
  realistic data — and the moment it is, the worker holds every real customer's
  address and a queue of messages about transfers that never happened. Such a
  message is **abandoned, not retried**: the address will not become allowed by
  waiting, and leaving it pending buries the messages that could go out.
- **What staging deliberately does not copy from production is stated in the
  compose file**: one node, no standby, no backups, workers in-process. What it
  must copy is the bundle, the migrations, the guard, the CSP and the ledger —
  a staging environment differing in those proves nothing.
