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

### Card lifecycle and holds — non-obvious rules

Schema: `packages/ledger/sql/030_card_lifecycle.sql` and
`031_card_settlements.sql`.

- **A SETTLEMENT MAY EXCEED ITS AUTHORIZATION, and taking the whole amount from
  `customer_pending` made that impossible to post.** Only the hold is in
  pending, so the overdraft guard refused every over-settlement — Bitnob
  retried for ever and the spend never reached the books. The entry now
  releases the hold from pending and takes the excess from the card's own
  balance, which is what economically happened; if the card cannot cover it,
  the existing rethrow applies and a person looks.
- **A settlement naming an authorization we do not hold is REFUSED, not
  acknowledged.** Nothing is in pending to release, so acknowledging would drop
  a real spend permanently. Webhooks arrive out of order and the authorization
  landing a moment later makes the retry succeed — the same rule Phase 5
  records about an authorization the card cannot cover.
- **A lost settlement webhook is invisible to everything else.** The money sits
  in `customer_pending`, the ledger balances, `ledger_drift` reports nothing
  and every test stays green. `card_holds_stuck` is the only thing that sees
  it, and it COUNTS rather than resolves: settling invents a spend the provider
  never confirmed, expiring hands back money that may have been spent.
- **`card_hold_window_days` is 16, deliberately longer than fourteen.** Bitnob
  settles up to 7–14 BUSINESS days out, so a shorter window is a false alarm
  every fortnight — and an alert people learn to ignore is worse than none.
- **The stuck-hold check rides on the balance reconciliation sweep**, not its
  own. It asks the same question, and every worker interval is one more thing
  an operator can forget to set on exactly one instance.
- **`card_settlements` is a separate table, not columns on the
  authorization.** That row records what the duplicate guard saw at the moment
  of the charge; writing to it days later would also touch a row 010 counts,
  which is how a redelivered settlement becomes a second authorization for the
  purpose of freezing a card.
- **Every card status change is recorded by trigger, attributed by the
  service.** The trigger cannot know who, so it writes `system` and the service
  completes the row in the SAME transaction — apart, a process dying between
  them would leave a real change attributed to nobody.
- **A replacement links to what it replaced, and only for a TERMINATED card of
  the SAME customer.** Otherwise a customer holds two live cards where one is
  described as the successor of the other, leaving the leaked number spendable.
- **Reissue terminates FIRST.** Issuing first would leave a customer holding a
  live replacement AND a live compromised card if the termination then failed —
  the exact state they came to escape.
- **Staff can freeze a card and deliberately cannot terminate one.** Freezing
  stops spending and the customer can undo it; terminating moves their money
  and cannot be undone.

### Tax — non-obvious rules

Schema: `packages/ledger/sql/032_tax.sql`. Split in `apps/api/src/tax/tax.service.ts`,
report at `/admin/tax`.

- **Every naira of every fee used to go to `revenue_fees`.** Part of a fee
  charged by a Nigerian company for a service is VAT, which is not our money at
  all, and there was no account anywhere that could hold money collected and
  owed onward. A finance team filing a return had nothing to file FROM.
- **TAX IS A LIABILITY, NOT REVENUE.** `liability_tax_payable`, never
  `revenue_fees`. Booking it as revenue overstates what the business earned and
  understates what it owes — both errors pointing the flattering way.
- **VAT ships ON and the transfer levy ships OFF, and the difference in
  defaults is the point.** VAT-inclusive is a BOOKING correction: the customer
  pays what they always paid and we stop calling all of it revenue, so leaving
  it off means knowingly recording a wrong number. A levy CHANGES WHAT A
  CUSTOMER IS CHARGED, so the machinery ships complete and the decision does
  not ship at all.
- **The inclusive split is `gross × rate / (10000 + rate)`, not
  `gross × rate / 10000`.** The second is the exclusive formula and
  over-collects on every fee. `splitInclusiveTax()` in `@xetral/shared` is the
  one place it lives.
- **Tax rounds UP, in both modes**, so we can never under-remit. The fraction
  goes to the revenue authority rather than to us — the opposite direction from
  the FX spread, and stated at both call sites for the same reason.
- **VAT is charged on the FEE, never on the amount being transferred.** What is
  taxed is the service, not the money moving.
- **The levy is NAIRA ONLY**, threshold-gated, and flat. It is published in
  kobo and is a statement about naira; applying a kobo figure to dollars
  because both are integers is the same mistake as adding kobo to cents.
- **`tax_collections` is written on the ENTRY'S OWN transaction**, through
  `post()`'s `onEntry` hook, so a collection cannot exist without its posting
  and a posting cannot exist without its record. `ON CONFLICT DO NOTHING`,
  because a retried transfer is a replay at the ledger and must be one here.
- **Nothing collected is NO ROW.** A row saying zero is indistinguishable from
  one somebody forgot to write, and the ledger refuses a zero-amount posting
  for the same reason — which is also why the fee, the tax and the levy are
  three conditional legs rather than one.
- **`tax_remittance_drift` reports ONE direction.** Remitting reduces the
  balance without being a collection, so a balance below what was collected is
  a payment, not a discrepancy. More held than collected means a path posted
  the money and forgot the record.
- **Neither figure is tax advice.** The rate, the levy and its threshold are
  rows an operator reviews, the same as `risk_thresholds`.
- **`formatMinor` is what the admin surface uses, never `formatAmount`.** The
  two look identical at a call site and differ by a factor of a hundred:
  `formatAmount` takes MAJOR units and the views return `*_minor`. The
  compliance queue had been rendering ₦500,000,000 for a ₦5,000,000 transfer,
  which is exactly the error a reviewer deciding whether something is
  reportable cannot see.

### Consent — non-obvious rules

Schema: `packages/ledger/sql/033_consent.sql`, seeded by `033_consent.seed.sql`.
Service in `apps/api/src/consent/consent.service.ts`, screen at `/settings`,
queue at `/admin/consents`.

- **Consent was a SENTENCE ON A PAGE.** "By creating an account you agree to
  our terms and privacy notice" is the right thing to show a customer and it is
  not a record. Nothing said that a particular person agreed to a particular
  version at a particular moment, so the question the NDPA actually asks —
  demonstrate that this person consented — had no answer at all.
- **A WITHDRAWAL IS A NEW ROW, never an edit.** If granting could be erased,
  "had they consented on the day we mailed them?" becomes a claim about the
  present rather than about history. The current position is a VIEW
  (`customer_consents`), for the same reason `entry_status` is one.
- **Consent is to a VERSION, and the row stores a HASH of the words.** A URL
  describes today's page; a hash describes what was agreed to.
  `consent-documents.test.ts` recomputes it from the published page and fails
  the build on a drift — so editing the terms without republishing is red,
  with one obvious fix that also asks every customer again.
- **Documents are append-only: retire and republish.** Editing one in place
  rewrites what every past customer is recorded as having agreed to — the gift
  card rate card lesson, applied to something a court would read. Retirement is
  final, and a partial unique index keeps exactly one live document per kind.
- **MARKETING CANNOT BE BUNDLED into signing up**, by CHECK: a record whose
  source is `registration` cannot be a marketing consent. One "I agree"
  covering the terms and a mailing list is not consent to the mailing list,
  whatever the button said — so the signup form has no checkbox and could not
  usefully grow one.
- **Only marketing can be WITHDRAWN**, also by CHECK. The asymmetry is a
  statement: withdrawing the terms is closing the account, which moves money
  and has its own path — recording it here would leave a customer holding a
  balance under terms they are recorded as refusing.
- **Withdrawing is the same call as granting, with NO PIN.** Consent that is
  harder to withdraw than to give is not freely given, and there is
  deliberately no separate `withdraw()` for a client to guard on one side only.
- **AND IT GATES SOMETHING.** The outbox refuses a `marketing`-class message
  to a customer with no live grant, BY TRIGGER — a consent nothing reads is a
  checkbox, the lesson Tier 1 records about `crypto_enabled`. Security and
  transactional mail is untouched: unsubscribing must never withhold a reset
  link.
- **Registration records on the registration's OWN transaction.** Apart, a
  crash in the gap leaves a customer whose consent cannot be shown — precisely
  the customer somebody will ask about.
- **`consent_outstanding` excludes marketing.** Not having opted in is the
  correct resting state, not a task; listing it would turn "declined" into a
  queue somebody works through.

### Data rights — non-obvious rules

Schema: `packages/ledger/sql/034_data_rights.sql`. Service in
`apps/api/src/datarights/data-rights.service.ts`, screen at `/settings`, queue
at `/admin/data-requests`.

- **The privacy notice promised both rights and NOTHING implemented either.** A
  notice describing rights that do not exist is worse than one promising less:
  it is a commitment already being broken, in writing, on the page a regulator
  reads first.
- **THE EXPORT NAMES EVERY COLUMN.** A generic exporter walking a table list is
  a data-exfiltration primitive — add a table holding a sealed BVN or a token
  hash and it ships in the next export with nothing failing. Every query is
  written out, and `data-rights.e2e.test.ts` scans a real export's SERIALISED
  body for the password hash, the PIN hash and the PIN. Over the whole body,
  because what is being guarded against is a field nobody thought to name.
- **The export takes the transaction PIN**, unlike every other read. It is
  every balance, every transaction and every place they have signed in from in
  one file — the read a stolen session most wants, and the one whose
  consequence outlives the fifteen minutes an access token lasts. It is a POST
  so it cannot be triggered by a link or land in a browser history.
- **ASKING costs no PIN**, for the reason raising a dispute costs none: the
  customer most likely to ask is one who has just found somebody else in their
  account. Nothing is destroyed by asking.
- **Erasure is a REQUEST, and a person decides.** AML requires five years of
  records after a relationship ends; the NDPA forbids keeping personal data
  longer than needed. Granting fully deletes the financial record; refusing
  fully treats a legal right as an inconvenience. So what can lawfully go,
  goes, and what must stay is NAMED with why.
- **`erasure_scope` is COMPUTED from `retention_decisions`** — the same table
  the deletion sweep reads — so the promise made to a customer and the job that
  keeps it cannot describe different systems. `derive` is NOT erasable: a
  derived table's fate is its parent's, and reading it as erasable promised
  that `account_balances` could be deleted.
- **The erasure function names the rows it touches.** A deletion driven by a
  table that view returns would be a deletion job whose behaviour is changed by
  an INSERT — the reason `apply_retention()` has no dynamic SQL either. It
  never touches the ledger.
- **It REFUSES on a balance or an open case, WITH THE SAME MESSAGE.** Erasing
  the person we owe money to loses the creditor rather than discharging the
  debt; and tipping off is an offence, so a distinguishable refusal would be a
  way to learn you are under review. The API collapses both to
  `erasure_blocked` for the same reason.
- **Sign-in history is NOT deleted by erasure.** 019's trigger refuses a DELETE
  inside the retention window, and is right to: an erasure request that emptied
  that table could be used by whoever committed a takeover to erase the
  evidence of it. It is `purge`, so it does age out — a "we must keep this
  until" rather than a refusal.
- **The email becomes a TOMBSTONE, not a null.** `users.email` is how a
  duplicate account is refused, and a null would let the same address open a
  second one while the first is still on record.
- **The deadline is the database's and cannot be moved**, and
  `data_request_response_days` is capped at 30 — the setting can only be used
  to answer FASTER. A deadline an operator can extend is not a deadline.
- **`data.erase` is in 009's destructive list.** It is the one action in the
  system that cannot be undone by appending, so it is the last one that should
  be exempt from having to say why — and the reason recorded is the outcome
  itself, which is the answer the customer receives.

### Publishing a price — non-obvious rules

Schema: `packages/ledger/sql/035_price_publication.sql`. Service in
`apps/api/src/pricing/pricing.service.ts`, screen at `/admin/prices`.

- **NOTHING IN THE APPLICATION EVER WROTE EITHER PRICE TABLE.**
  `fx_spread_policies` and `giftcard_rate_cards` are read on every quote and
  were only ever populated by hand. An unpublished FX pair is refused rather
  than quoted from a default — right, and it means a fresh deployment converts
  nothing; gift cards are worse, because the flag can be switched on and the
  first customer quote 404s. `psql` on production was the only way out.
- **Writing them from a FORM is a different threat model from a prompt.** At a
  prompt an operator composes the whole statement and can see the table; in a
  form they see one band and press a button, twice, on a Friday.
- **TWO LIVE GIFT CARD BANDS MAY NOT OVERLAP**, by EXCLUDE constraint.
  `#liveRate` selects on `BETWEEN` and then `ORDER BY effective_from DESC LIMIT
  1`, so an overlap is not an error — the newer band silently reprices the
  shared range. A `LIMIT 1` resolving an ambiguity is an ambiguity the schema
  should not have allowed. The range is `'[]'`, inclusive at both ends, because
  the query is.
- **An EXCLUDE rather than a unique index**, because the thing refused is a
  range overlap. Phase 8's "`ON CONFLICT` cannot target an EXCLUDE" mattered
  there because issuing a virtual account races itself; nothing races here, and
  the right answer to a collision is to refuse and say what it overlaps.
- **There is no update endpoint.** Both tables are append-only by trigger:
  changing a price is retiring one and publishing another, which keeps every
  past quote reproducible.
- **`price.retire` is in 009's must-say-why list and `price.publish` is not.**
  Retiring looks like tidying and its effect is that the flow refuses every
  customer until a replacement exists. Requiring prose to set a number people
  set weekly is how a required field becomes the word "update".
- **Each FX DIRECTION is published separately.** A rate is a ratio, and "minor
  units per major unit" collapses in one direction — so NGN→USD and USD→NGN are
  two policies, and an operator who forgets the reverse learns it from
  `published_prices` rather than from a customer.
- **`prices_without_an_author` finds prices written at a prompt.** `created_by`
  stays nullable — rows already exist, and a migration refusing to apply over
  them would be worse than an unattributed price — so the gap is made visible
  instead.

### What needs attention — non-obvious rules

Schema: `packages/ledger/sql/036_attention.sql`.

- **`admin_work_queue` named FIVE sources and was written in Phase 12** —
  before disputes, monitoring, cases, stuck card holds, consent, data requests
  and three drift views existed. Every one of those shipped with its own view
  and none reached the overview, so an operator saw five empty queues and
  reasonably concluded there was nothing to do. An incomplete list that looks
  complete is trusted; that is worse than no overview.
- **The fix is not a longer list, it is that a short one fails the build.**
  `attention_sources` classifies EVERY view — `queue`, `watch` or `internal` —
  and `attention_coverage` reports an UNDECIDED one and an ORPHANED one, both
  directions, the same shape as `retention_coverage` and for the same reason:
  the queue nobody thought of is the one that silently fills.
- **The queue is WRITTEN OUT, one arm per source, with no dynamic SQL.** An
  overview assembled by looping over `attention_sources` would be an overview
  whose behaviour changes with an INSERT — the rule `apply_retention()` and
  `erase_customer_personal_data()` follow.
- **Every arm is an unconditional aggregate, so an empty queue still emits a
  row.** "consent: 0 waiting" says the queue was checked; an absent row says
  nothing at all, and the two look identical on a dashboard. It is also what
  makes the coverage comparison exact in both directions.
- **A `queue` must carry a name and a `watch` must not**, by CHECK, so the
  classification and the overview cannot drift apart.
- **A rationale is at least twenty characters.** `internal` is the cheap
  answer, and a one-word reason is how a view that does need working gets filed
  under it.

### Going live — non-obvious rules

The list is `apps/api/src/golive/go-live-checklist.ts`; the prose is
`deploy/GO-LIVE.md`; the same list asked of a running deployment is
`GET /v1/admin/readiness`.

- **Every phase ended with its own "an operator must" paragraph** — six in
  `PHASES.md` alone, more here, more in migration headers. Each correct, and
  together not a checklist, because nothing listed them and nothing noticed a
  seventh being written.
- **THE LIST IS DATA AND THE BUILD CHECKS IT**, in both directions:
  `go-live.test.ts` fails on a variable `config.ts` reads that the checklist
  does not name, AND on an entry for something that no longer exists — the
  second matters as much, because an operator told to set a variable that does
  nothing will stop trusting the rest.
- **`platform_settings` is seeded by FOURTEEN migrations**, 009 through 037,
  not by one seed file. The first reader here scanned `009_admin.seed.sql`,
  found nineteen keys of fifty-four, and looked plausible. That spread is why
  nobody had a complete list.
- **Category `silent` is the one that justifies the whole thing.**
  `NOTIFICATION_INTERVAL_SECONDS` unset means the outbox fills, the API keeps
  saying "check your email", and nothing is sent. Nothing errors, because
  writing the row succeeded.
- **`default-is-deliberate` is a decision RECORDED, not an omission.** Without
  a way to say "considered, nothing needed", the honest thing to do with a
  defensible default is leave it off the list — which is how a list stops being
  one. The same shape as `attention_sources` requiring a rationale for
  `internal`.
- **The readiness check REPORTS and never refuses.** One that could stop the
  API starting would be a new way to take the platform down at 3am, and what
  genuinely cannot be missing already refuses at boot in `config.ts`.
- **It answers for the PROCESS THAT SERVED IT, and says so.** Workers run in
  their own container, so every interval reads `unset-here` on the api and is
  correctly set on the worker. A check that claimed to speak for the whole
  deployment would report nine false findings on every production instance.
- **It carries no secret and no value**, only whether something is set. The
  e2e asserts the ROW SHAPE rather than scanning for something key-shaped —
  the scan version failed on `risk_dormant_days` containing `sk_`, which is
  the trouble with pattern-matching for secrets in either direction.

### Provider health — non-obvious rules

Schema: `packages/ledger/sql/037_provider_health.sql`. Recorder and port
wrapper in `apps/api/src/observability/provider-health.service.ts`, screen at
`/admin/providers`.

- **Every kill switch has to be flipped BY HAND, which means noticing first**
  — and nothing recorded whether a provider call succeeded, so the first
  reliable signal that a provider had stopped answering was a customer.
- **A REJECTION IS NOT ILL HEALTH.** `ProviderRejectedError` means they
  understood and refused: insufficient float, a frozen card, a declined
  authorization. It is counted and deliberately excluded from the failure rate
  — an alert that fires every time a card is declined is one people mute.
  Unavailable, timed out and contract are the health signals.
- **A CONTRACT ERROR IS THE ONE THAT PAGES.** They changed their API, the same
  request fails for ever, and no amount of waiting helps. `contract_broken` is
  its own column for that reason.
- **BUCKETS, not one row per call**, maintained by one `ON CONFLICT DO UPDATE`
  — the `record_error` shape, because a row per call is the log 015 exists to
  avoid.
- **Recording can never fail the call it records.** Every error out of the
  write is swallowed, and the write is fire-and-forget: awaiting it would put a
  database round trip in front of every provider response.
- **A minimum call count is what stops a quiet endpoint reading as an outage.**
  One failure out of one is a 100% failure rate and says nothing.
- **THERE IS NO AUTOMATIC DISABLE, deliberately.** A flapping provider would
  switch off a flow nobody meant to stop; re-enabling needs a person anyway, so
  the automation only adds a surprise on the way in; and the switches exist to
  be used deliberately during an incident by somebody who understands it. What
  was missing was never the flipping — it was knowing.
- **Ports are wrapped at the INJECTION BOUNDARY, once, with a Proxy.** Seven
  hand-written wrappers would drift the way three hand-written contract suites
  do, and a method added to a port later would silently stop being watched. It
  leaves synchronous methods alone, because `supportsVerification()` is a type
  guard and not a provider call.
- **The fulfilment map is watched per provider**, not as one: VTpass being down
  is not Airalo being down, and one health row for all three would say neither.

### Getting in, and what the phone talks to — non-obvious rules

`apps/api/src/auth/admin-bootstrap.service.ts`, `apps/mobile/app.json`.

- **THE FIRST STAFF GRANT IS THE ONE THE DASHBOARD CANNOT MAKE.** Every role
  is granted through a staff route, so a fresh deployment has an operations
  dashboard nobody alive can open, and the documented way in was an INSERT
  typed at a production psql prompt. An install step that asks for a shell on
  the database holding customer money is an install step people do badly.
- **`ADMIN_BOOTSTRAP_EMAIL` FIRES ONLY INTO AN EMPTY ROOM**, and that is the
  whole safety argument. If any live `admin` grant exists it does nothing and
  says so, so the variable cannot add a second administrator, restore a
  revoked one, or reach past a revocation. The one moment it has power is the
  moment nobody has any. It is a deployment value with deliberately NO
  ENDPOINT — a request that could mint the first administrator is a request
  worth forging — and it cannot manufacture an account: the address must
  already belong to a registered, ACTIVE user, so a frozen account cannot be
  handed the dashboard by an environment variable.
- The grant is written to `admin_audit_log` attributed to the account itself.
  The first admin is unavoidably self-granted and the trail says so rather
  than pretending somebody else approved it.
- **The phone talks to `app.xetral.com/api/x`, not to an API hostname.** The
  first APK was baked against `api.xetral.com`, which nothing in the
  deployment publishes — the web app reaches the API over a private
  `XETRAL_API_URL`. So the web worked, the phone could not sign in at all, and
  neither symptom pointed at the other. The proxy forwards GET and POST
  verbatim, which is the whole surface `XetralClient` uses; a native client
  has no origin, so the browser rules that proxy exists to sidestep never
  applied to it. It also gives ONE hop count: the proxy COPIES
  `x-forwarded-for`, so a handset request and a tab request are the same shape
  by the time the limiter counts them.
- **A preview APK's address is compiled in**, so a wrong one is a rebuild, a
  release and a reinstall. `api-url.test.ts` asserts the `/api/x` path is
  still there — tidying off the "redundant" suffix would 404 every request
  into Next's page router — and that the host is not one only the phone would
  notice the loss of.

### The staff second factor, and why the dashboard was shut — non-obvious rules

`apps/api/src/auth/staff-totp.service.ts`, `apps/web/src/lib/elevation.tsx`.

- **THE ACTING SURFACE WAS UNREACHABLE, and every part of it looked correct.**
  Elevation is recorded on the SESSION, and only two things could ever set
  `totp_verified_at`: confirming an enrolment, which happens once per operator,
  and an acting request carrying a code. No client sent one — `totp_code`
  appeared in exactly one request in the whole product. So the dashboard
  worked for the ten minutes after somebody enrolled and refused every action
  for ever after.
- **THE REFUSAL POINTED AT THE WRONG SECRET, which is why it read as a bug in
  the code rather than a missing endpoint.** `totp_required` renders as "enter
  the six-digit code from your authenticator app", and the only field on the
  provider-key form is the transaction PIN — so the code went in there, the PIN
  check refused it, and an operator holding two correct secrets was told they
  were wrong.
- **`/v1/auth/totp/elevate` is declared `authenticated`, NOT `staff`.** Its
  whole purpose is to be reachable by a session that is not elevated, which is
  every caller by definition; a staff policy would refuse the one request that
  exists to fix that. The service refuses anybody without a confirmed factor,
  so it grants a customer nothing.
- **The prompt is at the CLIENT BOUNDARY, not on each form.** `AdminClient` has
  forty-seven methods; a Proxy wraps every one of them and any added later,
  which a hand-written list cannot promise — the same argument that wraps
  provider ports once at the injection boundary.
- **One code buys the WINDOW, not one action.** Codes are single-use and change
  every thirty seconds, so a per-action code refuses a reviewer on their second
  approval, and the end of that is a shared authenticator on a desk.

### Paying somebody — non-obvious rules

Schema: `packages/ledger/sql/039_profile_handles.sql`.

- **SENDING MONEY REQUIRED KNOWING AN EMAIL ADDRESS**, which is the identifier
  people are most careful with and least willing to post. So the ordinary case
  — a trader publishing a way to be paid, somebody splitting a bill — had no
  shape at all.
- **A HANDLE IS CLAIMED ONCE AND NEVER REISSUED**, by `handle_history` and its
  trigger rather than by the unique index. The index only sees LIVE handles, and
  the whole point is that a RELEASED one is still taken: if changing yours freed
  it, whoever took it next would receive payments from every link you had
  already shared, out of message threads nobody re-reads.
- **The shape refuses the CONFUSABLE cases, not just the invalid ones.**
  Lowercase only, because `@Olawale` and `@olawale` must not be two people; no
  leading or trailing underscore, because `_olawale` reads as the same handle
  at a glance and that is how one person is impersonated to another.
- **`payable_handles` carries a name and NOT an email.** A link resolver has to
  show who is about to be paid; if it could also show the address behind the
  handle, every published payment link would be an email harvester.
- **An unknown handle answers exactly as an unknown email does.** A link that
  refused differently from an address would say which handles exist.
- **The suffix on a generated handle comes from a CSPRNG.** A handle is public
  and permanent, so a predictable one lets somebody work out what the next
  customer with that name will be given and claim it first — a cheap way to
  intercept payments meant for a person who has not signed up yet. The local
  Semgrep rule refuses `Math.random` here and caught exactly that.
- **`has_pin` is on the session so the Send screen can ask FIRST.** Without it
  the only way to learn was to try to move money and read `pin_not_set` off the
  refusal — a customer filled in a recipient, an amount and a PIN box before
  being told the PIN box was never going to work.

### Countries, and why a currency is not one — non-obvious rules

Schema: `packages/ledger/sql/040_countries.sql`, seeded by `040_countries.seed.sql`.
Service in `apps/api/src/countries/`, screen at `/admin/countries`.

- **A COUNTRY IS DATA AND A CURRENCY IS NOT**, and the asymmetry is the whole
  design. `Currency` is `keyof typeof CURRENCIES` — a compile-time union, and
  that is what makes `add(ngn(100), usd(100))` fail to compile. A currency
  invented from an admin form at runtime would have no EXPONENT, so every
  amount in it is wrong by a power of ten; no row in `kyc_tier_limits`, so no
  daily ceiling at any tier; and no row in `risk_thresholds`, so nothing
  watching it. That is finding 72 exactly.
- **So a country NAMES a currency and cannot invent one.** The admin picker is
  built from the money registry, filtered to fiat — a country whose default is
  Bitcoin is not a country this system understands.
- **A COUNTRY CANNOT BE ENABLED FOR A CURRENCY NOTHING LIMITS OR WATCHES**, by
  trigger. It raises a message naming which is missing, and the service relays
  that message rather than replacing it: "GHS has a daily limit at 0 of 3
  tiers" is the whole of what an operator needs, and a generic refusal would
  send them to read the migration.
- **Adding is free, opening is a decision.** A row goes in CLOSED whatever it
  names, and `countries_awaiting_a_decision` is where it waits. Defaulting to
  enabled would make an INSERT into a reference table a licensing decision.
- **`countries_without_cover` watches the OTHER direction** — a ceiling removed
  after a country was opened, which the enable trigger cannot see.
- **`HOME_CURRENCY = 'NGN'` was read as a fact about the platform** rather than
  about Nigeria, so a customer in Accra got a naira balance at the top of their
  home screen, a naira-only activity rail and no cedi wallet at all. It is
  `FALLBACK_HOME_CURRENCY` now and applies only to accounts opened before this
  migration, where `users.country` is null.
- **The naira wallet is still offered to everybody**, and that is the funding
  rail rather than a Nigeria default left behind: `wallet_funding` deposits
  arrive in naira, so a Ghanaian paid by a Nigerian holds naira and hiding that
  wallet would hide their money.
- **`TRANSFER_CURRENCIES` is what the API ACCEPTS; `sendableFor()` is what a
  customer is OFFERED.** Showing every country's local currency to everybody
  gives a Nigerian two options that answer `insufficient_funds` with nothing on
  screen saying which. The dollar and the stablecoins are offered to all —
  they belong to no country.
- **`activityFiltersFor()` never returns empty**, and its return type is a
  non-empty tuple so no caller has to write `?? FILTERS[0]`. An empty rail is a
  screen with no history at all.
- **`users.full_name` is NOT the verified name.** It is what somebody typed
  about themselves, used to greet them; `kyc_submissions.full_name` is what a
  reviewer read off a document, and it is the only one any money decision may
  read. Keeping them apart is what lets the greeting be personal on day one.
- **The dialling code is not a field.** It is read from the country already
  chosen and drawn in front of the input, so there is one place a country is
  stated — a second picker lets somebody select Ghana and +234.
- **The phone is normalised to E.164 SERVER-SIDE**, from the country's own dial
  code and the national digits, with the trunk zero stripped.
  `users_phone_unique` is a plain unique index on text and cannot see that
  `+2348031234567`, `2348031234567` and `08031234567` are one person — three
  accounts on one number, and every per-customer control assumes that cannot
  happen.
- **`country_not_supported` is one answer to two questions** — no such country,
  and not open there. A signup form that distinguished them would publish the
  roadmap to anybody with a dropdown.

### Surfaces, weights and the tap circle — non-obvious rules

- **THE GROUND IS OFF-WHITE AND EVERY CONTAINER ON IT IS PAPER WHITE**, which
  reverses what `globals.css` used to argue. One white everywhere makes a card
  only a border, so a screen of stacked cards reads as one sheet with lines
  ruled across it. The contrast cost is now paid by the ground, where there is
  no text, instead of by the card, where all of it is.
- **REACT NATIVE DOES NOT SYNTHESIZE FONT WEIGHT.** On Android a custom
  `fontFamily` is matched by name and `fontWeight` is IGNORED, so the single
  Regular face meant every label, button and currency code rendered at 400
  while the stylesheet said 600 — "the mobile text is too thin", and invisible
  to every test because the NUMBERS already matched the web's exactly. There is
  a face per weight now, instanced from the same variable woff2 the web serves,
  and `fonts.test.ts` fails on a `fontWeight` beside a custom family.
- **THE CIRCLE APPEARED ON TAP, NOT AT REST, and that is a different set of
  mechanisms.** The resting and hover states were already transparent. A tap
  focuses a button, and the product's focus ring is an `outline`, which follows
  the element's own 999px radius — so a tap left a blue circle around the icon.
  `:focus-visible` keeps the ring for keyboard users and removes it for thumbs;
  Android's `Pressable` ripple is refused with `android_ripple={null}` on every
  icon button, and kept on the tab bar, where a full-width target lighting up
  is the platform convention rather than a disc behind a glyph.
- **NOT EMOJI FLAGS.** Windows ships no flag glyphs, so `🇳🇬` renders there as
  the letters "NG" in a box — on the currency selector, on the screen every
  customer opens. The marks are data in `@xetral/client` and drawn as SVG by
  each app, so both platforms draw the same shape.
- **A flag only where a flag is the recognisable thing.** Naira, cedi and
  shilling are each one country's money. A dollar is not, and a US flag beside
  USD would be actively wrong next to USDT and USDC, which are dollars
  belonging to no country.
- **The currency selector replaced a BADGE and a RAIL** — a label that named the
  currency and could not change it, plus a row of chips that could and repeated
  every figure the balance was already showing. Two controls for one decision,
  and the card's height varied with how many currencies the platform offered.

### Currencies, filters and pickers — non-obvious rules

- **THREE COPIES OF THE ASSET LIST, bound by one test.** `crypto/dto.ts`'s zod
  enum validates a withdrawal, `@xetral/client`'s catalogue is what both apps
  offer, and `wallet.service.ts` decides what the home screen shows a zero
  balance for. `crypto-networks.test.ts` reads all three as text and fails the
  build on a disagreement in any direction, because an asset listed in one and
  refused by another is either a tile that cannot be used or an asset nobody
  can find — and neither compiles differently.
- **`historyQuerySchema` accepted only NGN and USD**, so a customer holding
  USDT could read the balance on the home screen and got `400 invalid_request`
  for every transaction behind it. Nothing caught it because the only client
  offered exactly the two the schema accepted: the two halves were wrong
  together, the same shape as the `TRON` casing bug.
- **The history list is WIDER than the transfer list, deliberately.** Money can
  arrive in a currency a customer cannot send from, and it must still be
  readable.
- **The transfer picker offers what may be SENT, not what is HELD.** Deriving
  it from balances gave a customer holding only naira a picker with one entry,
  which looks broken, and made anything that appeared as a balance a transfer
  option nothing had decided to offer.
- **"Gift" IS NOT A CURRENCY.** Gift cards settle in naira, so the fifth
  activity filter is the naira history narrowed to two entry kinds.
  `ACTIVITY_FILTERS` carries objects rather than codes so both apps express
  that the same way; collapsing it to `currency=GIFT` would mean either a
  currency the money primitives do not know or a special case inside the
  ledger's history query.
- **USDC needed a MIGRATION, not just a registry line.** `kyc_tier_coverage`
  and `risk_currency_coverage` are driven by `SELECT DISTINCT currency FROM
  accounts`, so the first USDC account would have turned two green suites red
  — and in the window before anyone noticed, USDC would have been the one
  asset with no daily ceiling and no monitoring. 038 puts the rows in first,
  which is the only ordering where the gap never exists.
- **A NATIVE `<select>` CANNOT BE THEMED WHERE IT MATTERS.** The closed control
  takes CSS and the open list does not: Android draws a full-screen dialog in
  the system font, iOS a wheel, and neither knows the app has a dark theme. A
  customer in dark mode got a white sheet in a stranger's typeface.
  `ui/select.tsx` replaces every one and `select-coverage.test.ts` fails the
  build on a new one — the shortcut is invisible on a laptop where the OS list
  and the page happen to both be light.
- **The activity rail scrolls INSIDE itself.** Five tabs do not fit across a
  320px handset, and an inline-flex that does not fit makes the BODY scroll
  sideways. Wrapping is the other obvious answer and it moves the tabs under
  the thumb as the selection changes width.

### Toggles and chrome — non-obvious rules

- **OMITTING A PROPERTY IS NOT THE SAME AS NEUTRALISING ONE**, and this cost a
  round. "No disc behind the icon" was first written by deleting `background`
  from `.icon-btn:hover` and changing only the colour — which does not
  override a background the rule never mentions, so
  `button:hover:where(:not(:disabled))` applied instead and painted
  `--brand-700` on a 44px circle with the icon in near-black on top. Measured
  in a browser as `rgb(22, 41, 90)`. Every `.icon-btn` state says
  `background: transparent` out loud, and `button-specificity.test.ts` fails
  on one that does not.
- **There is no filled disc in any state, and the feedback is the ICON.** A
  44px circle behind a 20px glyph reads as a shape rather than as a state.
  `@media (hover: hover)` was right and was not enough — Android Chrome
  reports `hover: hover` whenever anything pointer-like is attached.
- **`theme-color` MUST follow `data-theme`, not `prefers-color-scheme`.** It
  was two media-keyed values reading the OS preference while the page follows
  the customer's own toggle, so somebody on a light-OS phone who chose dark
  got a black page framed by two white bars. A media query cannot express
  "whatever the customer last chose", so the tag is written by the pre-paint
  bootstrap and by the toggle — the only two places the theme changes.
- **On the phone it is the WINDOW background, and `expo-navigation-bar` is
  deliberately not used.** Under the edge-to-edge Android 15 enforces, its
  colour setter is a no-op: the platform draws transparent bars and expects
  the app to draw behind them. So `expo-system-ui` sets the window colour and
  each screen extends its own background under the insets — a native module
  would have added build risk to change nothing.

### Adding money — non-obvious rules

- **THE SCREEN WAS A WALL AND THE POLICY IT IMPLIED WAS FALSE.** Unverified,
  the account lookup answered `kyc_required` and that refusal was the entire
  page — on the screen somebody opens in order to put money in. It read as
  "you may not deposit until you verify".
- **An unverified account may move ₦50,000 a day.** That is tier 0 in
  `029_kyc_tiers.seed.sql`, it has been the policy since that migration
  landed, and nothing showed it to anybody. It is now the first thing on the
  page, read from `/v1/kyc/limits` so it is the customer's real ceiling rather
  than a number typed into a screen.
- **What IS gated is the account NUMBER, and that is a fact about the rail.** A
  dedicated Nigerian account number is a bank account opened in a person's
  name; the provider will not create one without a registered customer and
  regulation does not permit an unidentified one. So the screen names the one
  thing that needs verifying and why, rather than refusing the whole page.
- **The deposit history is shown either way.** A customer whose transfer has
  not arrived needs it more than a verified one does.

### Metrics — non-obvious rules

`apps/api/src/observability/metrics.{service,controller}.ts`, at `GET /metrics`.

- **`/health` says the process is alive and `/ready` says the database
  answers.** Neither says whether the ledger is moving, a worker has stopped or
  a queue has been growing for six hours — and the worker failures here are
  silent by construction: `NOTIFICATION_INTERVAL_SECONDS` unset means rows
  accumulate, the API keeps saying "check your email", and nothing is sent.
- **PUBLIC IN THE POLICY, GUARDED BY ITS OWN TOKEN** — the webhook shape,
  because a scraper has no session to present. It is not public in effect: it
  carries queue depths, provider health and what is owed to customers, and a
  non-zero drift figure published openly tells somebody the books are
  inconsistent before we have noticed.
- **No `METRICS_TOKEN` means 404, not 401.** An unconfigured endpoint that
  answered 401 confirms to a prober that it exists; with no token there is
  nothing to authorise against. Defaulting to open was never an option — an
  endpoint that works is one nobody checks the guard on.
- **It is NOT unmetered.** `/health` and `/ready` are, because what polls them
  hardest is the load balancer deciding whether the instance lives. A scrape
  runs aggregate queries and its credential is checked inside the handler, so
  unmetered would be a way to make the database work with no credential at all.
- **Measured from the views that already exist, never from counters this
  service keeps.** A counter is a second copy of the truth — and it means a
  queue added to `admin_work_queue` is scraped automatically, which is 036's
  guarantee extended to monitoring.
- **Cached for ten seconds, because it is not free.** The queue view aggregates
  twenty-three sources and one scans postings; a fifteen-second scraper would
  run that all day, which is a way of taking a system down while watching it.
- **Amounts are MINOR UNITS and say so in the name.** Prometheus samples are
  floats, so a naira balance in major units would be a float holding money.
- **Queue AGE as well as depth.** A queue of three that has been three since
  Tuesday is a queue nobody is working; a queue of forty turning over hourly is
  a busy morning. Alerting on depth alone gets both wrong.

### The mobile app — non-obvious rules

Review in `apps/mobile/SECURITY.md`, cover in `src/screen-privacy.tsx`.

- **The app switcher was writing balances to disk.** Both platforms photograph
  the screen when the app leaves the foreground, and the picture goes to a
  cache directory a backup or whoever picks the phone up can read without
  unlocking the app.
- **The two platforms need different answers.** Android takes `FLAG_SECURE` via
  `preventScreenCaptureAsync()` and that covers screenshots, recording and the
  switcher. **iOS cannot block a screenshot at all**, by Apple's design — so
  the UI is covered on `inactive`, which is the state the switcher raises
  BEFORE `background`. Listening for `background` covers the screen after the
  picture has been taken.
- **An opaque cover, not a blur.** A blurred balance is still a picture of the
  shape of one, and the digit count is what a glance reads.
- **Certificate pinning and root detection are declined, with reasons written
  down** rather than not thought about. Pinning against a Cloudflare
  certificate breaks the app on a rotation nobody here controls, and on a
  device compromised enough for either to matter the attacker can read the
  screen anyway. The effort goes into assuming the device may be compromised:
  the PIN behind the OS gate, tokens `THIS_DEVICE_ONLY`, and a server that
  never accepts "passed Face ID" in place of a PIN.
- **It has still never been run on hardware**, and the document says so. The
  `AppState` ordering the cover depends on is a claim only a device settles.
- **BUT CI NOW BUNDLES IT**, which is the part that does not need hardware and
  had never been done. The SDK 52 → 54 upgrade turned up two failures that
  neither the compiler nor a unit test can see: `app.json` listed
  `expo-screen-capture` under `plugins` and that package has never shipped a
  config plugin, so `expo config` — and therefore `expo prebuild` — died; and
  `metro.config.js` set `disableHierarchicalLookup`, so the first dependency
  npm left NESTED rather than hoisted could not be resolved, reported as
  `Unable to resolve module webidl-conversions` from a file this app does not
  import.
- **`nodeModulesPaths` and the module walk are not a pair.** The first is what
  lets a workspace reach the hoisted root; the second is what lets a hoisted
  package reach its own nested duplicate. The Expo monorepo recipe that
  disables the walk is for isolated installs, and applying it to an npm
  workspace breaks the bundle on the first version conflict anywhere in the
  tree.
- **Expo Go ships ONE SDK version**, so "it will not open on my phone" is
  usually a version mismatch and the only direction that fixes it is forward.
  One React across both apps now: SDK 54 wants 19.1.0 and the web app was
  pinned to 19.0.0, which is what made `npm install` refuse.
- **AND EXPO GO IS NO LONGER THE TARGET AT ALL.** It carries only the native
  modules Expo chose, so it could never run this app's own — and the SDK
  mismatch above is a recurring tax for a thing that was always a stand-in.
  `expo-dev-client` makes the development build this app's OWN binary, pointed
  at Metro the same way. `npm start` is `expo start --dev-client`; `start:go`
  keeps the old behaviour for a quick look at a screen with no native
  dependency.
- **THE TWO ANDROID VARIANTS DIFFER IN WHERE THE JAVASCRIPT COMES FROM**, and
  that is why they take different inputs. A `preview` APK is bundled in CI, so
  `EXPO_PUBLIC_API_URL` is baked in and the phone cannot be told later. A
  `development` build is bundled by Metro on the developer's machine every
  time they press save, so the address comes from the shell Metro was started
  in — and the workflow REFUSES an `api_url` for it rather than ignoring one,
  because a build somebody believes is pointed at an address it knows nothing
  about fails as a sign-in against the wrong host.
- **The APK is published as a RELEASE ASSET, not an Actions artifact.** An
  artifact is a zip behind a login: on a phone that is a GitHub sign-in, an
  archive, an unpacker, then an install. A release asset is the `.apk` itself,
  one tap. It is a PRERELEASE so a test build never becomes the latest release
  of a platform that has not shipped.
- **THE APK ASKED FOR THREE PERMISSIONS NOTHING USES**, and had since the
  first build. `SYSTEM_ALERT_WINDOW`, `READ_EXTERNAL_STORAGE` and
  `WRITE_EXTERNAL_STORAGE` come from Expo's android TEMPLATE, not from any
  package here — so no diff ever showed them. "Display over other apps" on a
  banking app is a permission a customer can see and reasonably refuse to
  install over. `android.blockedPermissions` removes them, and the workflow
  ASSERTS the generated manifest in both directions, because a typo in that
  list would take out biometrics and present as "Face ID does not work on
  Android".
- **NO WORKFLOW INPUT REACHES A SHELL THROUGH `${{ }}`.** An expression in a
  `run:` block is pasted in as TEXT before bash sees it, so a value carrying a
  quote and a semicolon is a command — and the APK job holds a token with
  `contents: write`. CodeQL flagged it high, correctly: `workflow_dispatch`
  narrows WHO can supply a value, it does not make the value safe. Through
  `env:` it is data. The URL character check next to it is not that defence;
  it is the step doing its own job, refusing an address that cannot work.
- **THE APK WORKFLOW HAD NEVER ONCE BEEN RUN**, and the first run failed at
  `mergeDebugResources` after three and a half minutes: `with-lan-cleartext.js`
  wrote `expo prebuild --clean` into an XML COMMENT, and **two consecutive
  hyphens are illegal there**. The file is generated into gitignored
  `android/`, so it appeared in no diff; the only reader was aapt2, on a
  runner, in a step nobody associates with a config plugin. The plugin now
  REFUSES such a comment at prebuild — seconds, and it names the line.
- **`userInterfaceStyle` was declared and ignored.** `expo prebuild` said so on
  every run — `Install expo-system-ui to enable this feature` — and nobody was
  reading prebuild output because nobody ran prebuild locally. Theming worked
  anyway because `theme.ts` reads `useColorScheme`, so the only real cost was a
  white flash before the dark palette painted.
- **Both variants share one application id and one debug key**, so installing
  either replaces the other. That is Expo's template rather than a decision
  here, and it is written down because the symptom — a development build
  vanishing when a preview is installed — otherwise reads as a broken build.

### Scanning the running app — non-obvious rules

`ci.yml`'s boot probes, and the `dynamic` job in `scan.yml`.

- **The specific assertions BLOCK; the scanner REPORTS.** Each `check` in
  ci.yml names a failure this application has actually had — a controller
  imported and never mounted, a CSP that stops the page hydrating, a webhook
  answering 500 instead of 401. A baseline scan finds things true of every
  sign-in page, and failing on those teaches everybody to skip the step.
- **The API had NO HSTS and the web app always did**, which looked harmless
  because both sit behind the same edge. They do not have the same clients:
  `apps/mobile` talks to the API origin directly, so the protection the web app
  enjoyed never reached the clients holding a customer's PIN in a Keychain. A
  header that exists only because of a setting in another system is a header
  nobody owns.
- **The two apps' `Referrer-Policy` differ deliberately.** The API sends
  `no-referrer` because it renders nothing; the web app sends
  `strict-origin-when-cross-origin`, because a browser app needs same-origin
  referrers to work and what it must never do is send a path carrying a card id
  to another site.
- **The dynamic scan runs against a schema-less database, passively.** An
  active scan sends requests designed to change state, and this API is wired to
  a real ledger in every environment where running one would be worth anything.

### Static analysis — non-obvious rules

Rules in `.semgrep/xetral.yml`, probe in `.semgrep/probe/`, workflow in
`.github/workflows/scan.yml`.

- **The generic rulesets cannot know this system's rules.** CodeQL and
  Semgrep's own packs find well-known bug classes and are worth running. They
  cannot find "only the ledger writes postings" or "money is never a float",
  and until now every one of those was enforced by a person reading a diff.
- **The five local rules BLOCK; the generic ones REPORT.** A generic ruleset
  over a repo this size finds things in fixtures and build tooling, and failing
  on those trains everybody to skip the step — the same argument the dependency
  audit makes. When a generic finding matters it gets written into
  `xetral.yml`, where it does block.
- **A rule that matches nothing looks exactly like a rule that finds nothing.**
  `.semgrep/probe/violations.ts.probe` is deliberately broken code, one
  violation per rule, and CI fails if fewer than all of them fire. That is not
  hypothetical: `no-secret-in-a-log-line` was written as a folded YAML scalar,
  which turns every newline into a SPACE — the regex matched nothing at all and
  read perfectly correctly in review.
- **A rule that fires on correct code is worse than no rule**, because the fix
  is an ignore comment and the next real finding gets the same treatment. Every
  pattern was run against the whole tree and tightened until it reported only
  what it should: `spread`, `fee` and `price` are NOT in the float rule's name
  list, because those are usually basis points or a catalogue label.
- **The four `nosemgrep` comments each say why at the site.** Two are dynamic
  WHERE clauses where every value goes through `params`; two are the demo
  seeder, which skips the service but not the database's own guards.
- **Prefer AST patterns to regexes** — the first float rule reported its own
  explanatory comment as a violation.
- **Three of the five caught something real the day they were written**:
  `format()` rendered a naira balance past 2^53 as ₦90,071,992,547,409,940.00,
  and `displayRate` rendered USD-per-naira as **"0.00"** — Phase 10 finding 1's
  collapse, in the display layer, in two copies of one calculation.

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
psql -d xetral -v ON_ERROR_STOP=1 -f packages/ledger/sql/030_card_lifecycle.sql
psql -d xetral -v ON_ERROR_STOP=1 -f packages/ledger/sql/031_card_settlements.sql
psql -d xetral -v ON_ERROR_STOP=1 -f packages/ledger/sql/032_tax.sql
psql -d xetral -v ON_ERROR_STOP=1 -f packages/ledger/sql/033_consent.sql
psql -d xetral -v ON_ERROR_STOP=1 -f packages/ledger/sql/033_consent.seed.sql
psql -d xetral -v ON_ERROR_STOP=1 -f packages/ledger/sql/034_data_rights.sql
psql -d xetral -v ON_ERROR_STOP=1 -f packages/ledger/sql/035_price_publication.sql
psql -d xetral -v ON_ERROR_STOP=1 -f packages/ledger/sql/036_attention.sql
psql -d xetral -v ON_ERROR_STOP=1 -f packages/ledger/sql/037_provider_health.sql
psql -d xetral -v ON_ERROR_STOP=1 -f packages/ledger/sql/038_usdc.sql
psql -d xetral -v ON_ERROR_STOP=1 -f packages/ledger/sql/039_profile_handles.sql
psql -d xetral -v ON_ERROR_STOP=1 -f packages/ledger/sql/040_countries.sql
psql -d xetral -v ON_ERROR_STOP=1 -f packages/ledger/sql/040_countries.seed.sql
psql -d xetral -v ON_ERROR_STOP=1 -f packages/ledger/sql/041_card_issuance.sql
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
psql -d xetral -v ON_ERROR_STOP=1 -f packages/ledger/sql/030_card_lifecycle.test.sql
psql -d xetral -v ON_ERROR_STOP=1 -f packages/ledger/sql/031_card_settlements.test.sql
psql -d xetral -v ON_ERROR_STOP=1 -f packages/ledger/sql/032_tax.test.sql
psql -d xetral -v ON_ERROR_STOP=1 -f packages/ledger/sql/033_consent.test.sql
psql -d xetral -v ON_ERROR_STOP=1 -f packages/ledger/sql/034_data_rights.test.sql
psql -d xetral -v ON_ERROR_STOP=1 -f packages/ledger/sql/035_price_publication.test.sql
psql -d xetral -v ON_ERROR_STOP=1 -f packages/ledger/sql/036_attention.test.sql
psql -d xetral -v ON_ERROR_STOP=1 -f packages/ledger/sql/037_provider_health.test.sql
psql -d xetral -v ON_ERROR_STOP=1 -f packages/ledger/sql/038_usdc.test.sql
psql -d xetral -v ON_ERROR_STOP=1 -f packages/ledger/sql/039_profile_handles.test.sql
psql -d xetral -v ON_ERROR_STOP=1 -f packages/ledger/sql/040_countries.test.sql
psql -d xetral -v ON_ERROR_STOP=1 -f packages/ledger/sql/041_card_issuance.test.sql
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
