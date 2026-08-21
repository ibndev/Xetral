-- ===========================================================================
--  Xetral — Phase 1: The Ledger
--  packages/ledger/sql/001_ledger.sql
--
--  Double-entry, immutable, multi-currency. Every other module in the
--  platform posts through this and nothing writes to `postings` directly.
--
--  Two decisions here come from provider behaviour rather than accounting
--  theory, and both are load-bearing. They are documented at the point they
--  bite, in sections 4 and 5.
-- ===========================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. ACCOUNTS
--
-- An account is any bucket money can sit in. Customer wallets are accounts;
-- so are revenue accounts, float at each provider, and the suspense accounts
-- money passes through on its way somewhere. Everything. If money can be in
-- it, it is an account, because anything outside the account tree is money
-- the ledger cannot prove the location of.
-- ---------------------------------------------------------------------------

CREATE TYPE account_kind AS ENUM (
  -- Customer-facing
  'customer_wallet',        -- a user's spendable balance, one per currency
  'customer_card',          -- funds loaded onto a virtual card
  'customer_pending',       -- authorised but not settled (see section 4)

  -- Ours
  'revenue_fees',           -- transfer, bill and card fees
  'revenue_fx_spread',      -- the margin on an FX trade
  'expense_provider_cost',  -- what a provider bills us

  -- External
  'provider_float',         -- our balance held AT a provider (Bitnob, VTpass)
  'liability_customer_funds', -- total owed to customers; must equal partner bank
  'suspense'                -- money we have but cannot yet attribute
);

CREATE TYPE account_status AS ENUM ('active', 'frozen', 'closed');

CREATE TABLE accounts (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    uuid            UUID           NOT NULL DEFAULT gen_random_uuid(),
    kind            account_kind   NOT NULL,

    -- Owner is nullable because platform accounts (revenue, float) have none.
    owner_type      TEXT           NULL,
    owner_id        BIGINT         NULL,

    currency        TEXT           NOT NULL,

    -- Which direction INCREASES this account. Assets and expenses are debit-
    -- normal; liabilities, equity and revenue are credit-normal. Stored so
    -- reporting never has to special-case by kind, and so a new account kind
    -- cannot quietly inherit the wrong sign.
    normal_balance  TEXT           NOT NULL
                    CHECK (normal_balance IN ('debit', 'credit')),

    status          account_status NOT NULL DEFAULT 'active',
    created_at      TIMESTAMPTZ    NOT NULL DEFAULT now(),

    CONSTRAINT accounts_uuid_key UNIQUE (uuid)
);

-- A customer gets exactly one account per (kind, currency). The partial index
-- rather than a plain UNIQUE is because platform accounts have NULL owners,
-- and in SQL every NULL is distinct — a plain constraint would permit any
-- number of duplicate revenue accounts while appearing to prevent them.
CREATE UNIQUE INDEX accounts_owner_unique
    ON accounts (owner_type, owner_id, kind, currency)
    WHERE owner_id IS NOT NULL;

CREATE UNIQUE INDEX accounts_platform_unique
    ON accounts (kind, currency)
    WHERE owner_id IS NULL;

CREATE INDEX accounts_owner_lookup ON accounts (owner_type, owner_id);

-- ---------------------------------------------------------------------------
-- 2. JOURNAL ENTRIES
--
-- One entry per business event. Immutable: no UPDATE, no DELETE, ever. A
-- mistake is corrected by a REVERSING entry, which leaves an audit trail
-- instead of erasing one. Section 7 enforces this at the permission level so
-- it does not depend on everyone remembering.
-- ---------------------------------------------------------------------------

CREATE TYPE entry_kind AS ENUM (
  'wallet_funding',
  'wallet_transfer',
  'wallet_withdrawal',
  'card_creation',
  'card_funding',
  'card_authorization',   -- money held, not yet spent
  'card_settlement',      -- the hold becomes a real spend
  'card_auth_expiry',     -- the hold lapsed; money returns
  'card_refund',
  'fx_trade',
  'bill_payment',
  'esim_purchase',
  'number_purchase',
  'crypto_deposit',
  'crypto_withdrawal',
  'fee',
  'reversal',
  'adjustment'            -- manual, requires a reason and an approver
);

CREATE TABLE journal_entries (
    id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    uuid             UUID        NOT NULL DEFAULT gen_random_uuid(),

    -- THE replay guard. A UNIQUE constraint and not an application check,
    -- because only the database enforces uniqueness under concurrency: two
    -- webhook deliveries racing on separate connections both see "not
    -- processed yet" if the check is a SELECT.
    --
    -- Format: '<source>:<external_id>', e.g. 'bitnob:evt_01H...'. Composite
    -- so that two providers issuing the same opaque id cannot collide.
    idempotency_key  TEXT        NOT NULL,

    kind             entry_kind  NOT NULL,

    -- Set only on kind='reversal'. Self-referencing FK so a reversal can
    -- never point at an entry that does not exist.
    reverses_id      BIGINT      NULL REFERENCES journal_entries(id),

    description      TEXT        NOT NULL DEFAULT '',
    metadata         JSONB       NOT NULL DEFAULT '{}'::jsonb,

    -- Split deliberately. `occurred_at` is when it happened in the world —
    -- the provider's timestamp. `created_at` is when we recorded it. A
    -- webhook delayed six hours has a six-hour gap between them, and
    -- financial reporting needs the former while incident forensics needs
    -- the latter. Collapsing them into one column loses whichever you did
    -- not pick.
    occurred_at      TIMESTAMPTZ NOT NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT journal_entries_idem_key UNIQUE (idempotency_key),
    CONSTRAINT journal_entries_uuid_key UNIQUE (uuid),
    CONSTRAINT reversal_has_target CHECK (
        (kind = 'reversal') = (reverses_id IS NOT NULL)
    )
);

CREATE INDEX journal_entries_occurred ON journal_entries (occurred_at DESC);
CREATE INDEX journal_entries_kind     ON journal_entries (kind, occurred_at DESC);

-- ---------------------------------------------------------------------------
-- 3. POSTINGS
--
-- Signed amounts: positive is a debit, negative is a credit. Two or more per
-- entry, summing to zero PER CURRENCY (section 5).
--
-- amount_minor is BIGINT holding an integer count of the currency's smallest
-- unit. Never NUMERIC, never a float. The application side is `bigint` in
-- TypeScript, which maps here one-to-one with no lossy step between.
-- ---------------------------------------------------------------------------

CREATE TABLE postings (
    id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    journal_entry_id  BIGINT      NOT NULL REFERENCES journal_entries(id),
    account_id        BIGINT      NOT NULL REFERENCES accounts(id),

    amount_minor      BIGINT      NOT NULL,
    currency          TEXT        NOT NULL,

    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- A zero posting carries no information and would let an "entry" balance
    -- trivially with no money moving. If a business event legitimately moves
    -- nothing, it is not a journal entry.
    CONSTRAINT posting_nonzero CHECK (amount_minor <> 0)
);

CREATE INDEX postings_account_time ON postings (account_id, created_at DESC);
CREATE INDEX postings_entry        ON postings (journal_entry_id);
CREATE INDEX postings_currency     ON postings (currency, created_at DESC);

-- A posting's currency must match its account's currency. Without this, a
-- USD posting can land in an NGN wallet: each side balances, the trigger in
-- section 5 passes, and the wallet total is silently meaningless.
CREATE OR REPLACE FUNCTION assert_posting_currency() RETURNS TRIGGER AS $$
DECLARE
    account_currency TEXT;
BEGIN
    SELECT currency INTO account_currency FROM accounts WHERE id = NEW.account_id;
    IF account_currency IS DISTINCT FROM NEW.currency THEN
        RAISE EXCEPTION
            'posting currency % does not match account % currency %',
            NEW.currency, NEW.account_id, account_currency;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER postings_currency_check
    BEFORE INSERT ON postings
    FOR EACH ROW EXECUTE FUNCTION assert_posting_currency();

-- ---------------------------------------------------------------------------
-- 4. WHY 'customer_pending' EXISTS
--
-- Bitnob card spending is TWO events, not one. An Authorization reserves the
-- money; a Settlement, up to 7-14 business days later, actually takes it. If
-- no settlement arrives, the authorization expires and the money returns.
-- Bitnob's own documentation warns that both events fire webhooks and that
-- treating them as one transaction produces an incorrect balance.
--
-- A single-balance ledger has nowhere to put an authorised-but-unsettled
-- amount, which leaves three bad options: debit on auth and double-debit on
-- settle; debit only on settle and let the customer overspend money already
-- committed; or track holds outside the ledger, where nothing reconciles.
--
-- Double-entry has a fourth option, and it is the correct one:
--
--   Authorization  wallet -> customer_pending   (spendable drops, total same)
--   Settlement     customer_pending -> provider_float
--   Expiry         customer_pending -> wallet   (a plain reversal)
--
-- The customer's SPENDABLE balance is wallet. Their TOTAL is wallet +
-- pending. Both are derived from postings, both are always provable, and an
-- expiry is an ordinary reversing entry rather than a special case.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 5. THE INVARIANT: postings sum to zero PER CURRENCY
--
-- SIGN CONVENTION: a positive amount_minor means value flows INTO the
-- account, negative means out. Money leaving one account and entering
-- another therefore nets to zero, which is what makes the check below work.
--
-- The naive rule is "postings in an entry sum to zero". That is right only
-- while the platform is single-currency, and the reason it fails is subtler
-- than it first looks. A CORRECT FX trade does still sum to zero overall:
--
--   Sell N1,650,000 for $1,000 at 1650, 1% spread
--     NGN:  customer wallet   -165000000
--           provider float    +165000000   -> 0
--     USD:  provider float      -100000
--           customer wallet      +99000
--           fx spread revenue     +1000    -> 0
--   whole-entry sum: 0
--
-- So a whole-entry check would not reject valid trades. The danger is the
-- opposite: it treats 1000 kobo as cancelling 1000 cents, because it adds
-- raw integers with no idea what unit they are in. Two INDEPENDENT errors in
-- different currencies then MASK EACH OTHER and the entry commits:
--
--     NGN leg over by  +1000  (kobo)
--     USD leg under by -1000  (cents)
--     whole-entry sum:      0  <- passes, and both legs are wrong
--
-- Naira and dollars are not commensurable. Summing them is a category error
-- that happens to produce a number. The invariant holds per currency, and
-- only per currency. Test 4a in the companion file demonstrates exactly this
-- masking case, and it is the test that justifies the design.
--
-- DEFERRABLE INITIALLY DEFERRED, checked at COMMIT rather than per row,
-- because the postings of one entry are inserted one at a time and the sum
-- is legitimately non-zero in between. A per-row check would reject every
-- valid entry ever written.
--
-- Consequence worth knowing: because the check is deferred, an imbalance
-- surfaces at COMMIT, not at the offending INSERT. Application code sees the
-- error at the end of the transaction, and a test that aborts before
-- committing will not see it at all unless it issues SET CONSTRAINTS ALL
-- IMMEDIATE.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION assert_entry_balances() RETURNS TRIGGER AS $$
DECLARE
    offending RECORD;
BEGIN
    SELECT currency, SUM(amount_minor) AS total
      INTO offending
      FROM postings
     WHERE journal_entry_id = NEW.journal_entry_id
     GROUP BY currency
    HAVING SUM(amount_minor) <> 0
     LIMIT 1;

    IF FOUND THEN
        RAISE EXCEPTION
            'unbalanced journal entry %: % postings sum to %, must be 0',
            NEW.journal_entry_id, offending.currency, offending.total;
    END IF;

    -- An entry needs at least two postings. One posting can never balance
    -- (a zero amount is already rejected), so this only fires when postings
    -- were inserted for an entry and then the transaction tried to commit
    -- mid-write — but it makes the intent explicit rather than relying on
    -- the sum check to catch it as a side effect.
    IF (SELECT COUNT(*) FROM postings WHERE journal_entry_id = NEW.journal_entry_id) < 2 THEN
        RAISE EXCEPTION 'journal entry % has fewer than 2 postings', NEW.journal_entry_id;
    END IF;

    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER postings_balance_check
    AFTER INSERT ON postings
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION assert_entry_balances();

-- ---------------------------------------------------------------------------
-- 6. MATERIALISED BALANCES
--
-- Derived data. `postings` is the source of truth; this table exists only so
-- that "what is my balance" is an index lookup rather than a scan of the
-- customer's entire history.
--
-- It WILL drift — from a bug, a partial failure, a manual fix. Section 8
-- provides the query that detects it. Assume drift and detect it nightly;
-- do not assume correctness and discover it during an incident.
-- ---------------------------------------------------------------------------

CREATE TABLE account_balances (
    account_id     BIGINT      PRIMARY KEY REFERENCES accounts(id),
    balance_minor  BIGINT      NOT NULL DEFAULT 0,

    -- Bumped on every write. Lets a caller detect that a balance changed
    -- under it without comparing amounts, which is ambiguous when two
    -- opposite postings net to the same figure.
    version        BIGINT      NOT NULL DEFAULT 0,
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Every account gets a zero balance row the moment it is created. This is
-- not just tidiness -- it is what lets the function below be a plain UPDATE.
--
-- The obvious implementation is INSERT ... ON CONFLICT DO UPDATE, and it is
-- SUBTLY WRONG when combined with the overdraft guard in 6b. Postgres fires
-- BEFORE INSERT row triggers for an upsert using the PROPOSED row, BEFORE it
-- detects the conflict. The guard would therefore see the raw posting amount
-- (-505000) rather than the merged balance (199495000) and reject a
-- perfectly funded withdrawal. Seeding the row here removes the INSERT path
-- entirely, so the guard only ever sees a real post-merge balance.
--
-- It also means account_balances has a row for every account, so the drift
-- view in section 8 cannot miss an account that has never been posted to.
CREATE OR REPLACE FUNCTION seed_account_balance() RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO account_balances (account_id, balance_minor, version)
    VALUES (NEW.id, 0, 0);
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER accounts_seed_balance
    AFTER INSERT ON accounts
    FOR EACH ROW EXECUTE FUNCTION seed_account_balance();

-- Maintained by trigger rather than by application code. Every path that
-- writes a posting updates the balance, including a manual INSERT during an
-- incident at 3am -- which is exactly when the application-code version gets
-- bypassed and the drift is introduced.
--
-- The relative write (balance + NEW.amount) rather than an absolute figure
-- computed in application code is what makes concurrent postings add up
-- instead of overwriting one another.
CREATE OR REPLACE FUNCTION apply_posting_to_balance() RETURNS TRIGGER AS $$
BEGIN
    UPDATE account_balances
       SET balance_minor = balance_minor + NEW.amount_minor,
           version       = version + 1,
           updated_at    = now()
     WHERE account_id = NEW.account_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'no balance row for account % -- seed trigger missing?',
            NEW.account_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER postings_maintain_balance
    AFTER INSERT ON postings
    FOR EACH ROW EXECUTE FUNCTION apply_posting_to_balance();

-- ---------------------------------------------------------------------------
-- 6b. NO OVERDRAFTS, ENFORCED BY THE DATABASE
--
-- A customer account must never go negative. Xetral is not a credit product;
-- a negative customer balance means somebody spent money that was not there,
-- and every such balance is an unsecured loan the business did not agree to
-- make.
--
-- This lives in the database, not in the service layer, because the service
-- layer is where the race is: two concurrent withdrawals both read a
-- sufficient balance, both pass their own check, and both commit. The
-- balance row is locked by the UPSERT in apply_posting_to_balance, so by the
-- time this trigger sees NEW.balance_minor the value is already serialised
-- against every competing write.
--
-- Platform accounts are exempt. provider_float goes negative routinely and
-- legitimately -- it means we have sent a provider more than we have
-- deposited, which is a real position, not an error.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION assert_no_overdraft() RETURNS TRIGGER AS $$
DECLARE
    k account_kind;
BEGIN
    SELECT kind INTO k FROM accounts WHERE id = NEW.account_id;

    IF k IN ('customer_wallet', 'customer_card', 'customer_pending')
       AND NEW.balance_minor < 0 THEN
        RAISE EXCEPTION
            'overdraft blocked: account % (%) would go to %',
            NEW.account_id, k, NEW.balance_minor
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- BEFORE UPDATE only. See the note above seed_account_balance: including
-- INSERT here would fire on the upsert's proposed row and reject valid
-- withdrawals. Balance rows are only ever created by the seed trigger, at
-- zero, so there is no INSERT path that needs guarding.
CREATE TRIGGER balances_no_overdraft
    BEFORE UPDATE ON account_balances
    FOR EACH ROW EXECUTE FUNCTION assert_no_overdraft();

-- ---------------------------------------------------------------------------
-- 7. APPEND-ONLY, ENFORCED
--
-- Immutability that depends on developers remembering is not immutability.
-- Revoking the grants means a bug in application code CANNOT rewrite
-- history; it can only append a reversal, which is the correct behaviour and
-- the one an auditor wants to see.
--
-- Run as the migration role. `xetral_app` is the role the API connects as.
-- ---------------------------------------------------------------------------

-- REVOKE UPDATE, DELETE ON journal_entries FROM xetral_app;
-- REVOKE UPDATE, DELETE ON postings        FROM xetral_app;
-- GRANT  SELECT, INSERT  ON journal_entries, postings TO xetral_app;
--
-- Commented out because the role does not exist until deploy. Section 9 of
-- the deployment runbook enables these; the migration must not fail on a
-- fresh database that has no app role yet.

-- ---------------------------------------------------------------------------
-- 8. RECONCILIATION
--
-- Nightly. Must return zero rows. If it does not, page someone: a mismatch
-- means the materialised balance and the postings disagree, and until it is
-- explained you do not know which one is lying.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE VIEW ledger_drift AS
SELECT b.account_id,
       a.kind,
       a.currency,
       b.balance_minor                  AS materialised,
       COALESCE(SUM(p.amount_minor), 0) AS derived,
       b.balance_minor - COALESCE(SUM(p.amount_minor), 0) AS difference
  FROM account_balances b
  JOIN accounts a  ON a.id = b.account_id
  LEFT JOIN postings p ON p.account_id = b.account_id
 GROUP BY b.account_id, a.kind, a.currency, b.balance_minor
HAVING b.balance_minor <> COALESCE(SUM(p.amount_minor), 0);

-- The second, external reconciliation: total owed to customers must equal
-- what is actually held at the partner. This is the number a regulator asks
-- for, and the one that catches a provider-side discrepancy the internal
-- check cannot see.
-- Positive = what Xetral owes customers, because customer balances are
-- already positive-when-funded under the sign convention in section 5. If
-- this ever returns a negative, an account is overdrawn and section 6b
-- failed -- investigate before trusting any other number on this page.
CREATE OR REPLACE VIEW customer_liability AS
SELECT a.currency,
       SUM(b.balance_minor) AS total_owed_minor
  FROM accounts a
  JOIN account_balances b ON b.account_id = a.id
 WHERE a.kind IN ('customer_wallet', 'customer_card', 'customer_pending')
 GROUP BY a.currency;

COMMIT;
