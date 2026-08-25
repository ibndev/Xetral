-- ===========================================================================
--  Xetral — ledger immutability invariant tests
--  packages/ledger/sql/011_ledger_immutability.test.sql
--
--  NOT idempotent. Run against a freshly created database, in migration order.
--
--  These are the four statements the pre-deployment audit ran successfully
--  against the schema before this migration existed. Each one must now fail.
-- ===========================================================================

\set QUIET on
\pset format unaligned
\pset tuples_only on

-- A real entry to attack. Two legs, balanced, through the ordinary path.
INSERT INTO users (email, status) VALUES ('imm-customer@example.ng', 'active');

DO $$
DECLARE v_user BIGINT; v_wallet BIGINT; v_float BIGINT; v_entry BIGINT;
BEGIN
    SELECT id INTO v_user FROM users WHERE email = 'imm-customer@example.ng';

    INSERT INTO accounts (kind, owner_type, owner_id, currency, normal_balance)
    VALUES ('customer_wallet', 'user', v_user, 'NGN', 'credit') RETURNING id INTO v_wallet;

    -- Resolve-or-create: `provider_float` is a PLATFORM account with one row
    -- per currency for the whole database, so an earlier suite may own it.
    SELECT id INTO v_float FROM accounts WHERE kind = 'provider_float' AND currency = 'NGN';
    IF v_float IS NULL THEN
        INSERT INTO accounts (kind, owner_type, currency, normal_balance)
        VALUES ('provider_float', NULL, 'NGN', 'debit') RETURNING id INTO v_float;
    END IF;

    INSERT INTO journal_entries (kind, idempotency_key, description, occurred_at)
    VALUES ('wallet_funding', 'imm:seed-entry', 'seed', now()) RETURNING id INTO v_entry;

    INSERT INTO postings (journal_entry_id, account_id, amount_minor, currency) VALUES
      (v_entry, v_float,  -50000, 'NGN'),
      (v_entry, v_wallet,  50000, 'NGN');
END $$;

\echo '=== 1. A posting cannot be REWRITTEN ==='
-- The exact statement the audit used to move ₦5,000 into a customer's wallet
-- out of nowhere. The materialised balance does not follow an UPDATE, so this
-- silently put the books out of agreement with themselves.
DO $$
BEGIN
    UPDATE postings SET amount_minor = amount_minor + 500000
     WHERE journal_entry_id = (SELECT id FROM journal_entries WHERE idempotency_key = 'imm:seed-entry');
    RAISE EXCEPTION 'TEST FAILED: a posting amount was rewritten';
EXCEPTION
    WHEN restrict_violation THEN
        RAISE NOTICE 'PASS: a posting cannot be rewritten';
END $$;

\echo ''
\echo '=== 2. A posting cannot be DELETED ==='
DO $$
BEGIN
    DELETE FROM postings
     WHERE journal_entry_id = (SELECT id FROM journal_entries WHERE idempotency_key = 'imm:seed-entry');
    RAISE EXCEPTION 'TEST FAILED: a posting was deleted';
EXCEPTION
    WHEN restrict_violation THEN
        RAISE NOTICE 'PASS: a posting cannot be deleted';
END $$;

\echo ''
\echo '=== 3. A journal entry cannot be REWRITTEN ==='
-- Rewriting the description or the metadata is how an entry stops describing
-- what actually happened while still balancing perfectly.
DO $$
BEGIN
    UPDATE journal_entries SET description = 'something else'
     WHERE idempotency_key = 'imm:seed-entry';
    RAISE EXCEPTION 'TEST FAILED: a journal entry was rewritten';
EXCEPTION
    WHEN restrict_violation THEN
        RAISE NOTICE 'PASS: a journal entry cannot be rewritten';
END $$;

\echo ''
\echo '=== 4. A journal entry cannot be DELETED ==='
DO $$
BEGIN
    DELETE FROM journal_entries WHERE idempotency_key = 'imm:seed-entry';
    RAISE EXCEPTION 'TEST FAILED: a journal entry was deleted';
EXCEPTION
    WHEN restrict_violation THEN
        RAISE NOTICE 'PASS: a journal entry cannot be deleted';
END $$;

\echo ''
\echo '=== 5. A bulk DELETE is refused before it touches a single row ==='
-- The statement-level trigger is what makes this true. A row-level one would
-- refuse too, but only after locking its way to the first row.
DO $$
BEGIN
    DELETE FROM postings;
    RAISE EXCEPTION 'TEST FAILED: the whole postings table was deleted';
EXCEPTION
    WHEN restrict_violation THEN
        RAISE NOTICE 'PASS: DELETE FROM postings is refused outright';
END $$;

\echo ''
\echo '=== 6. The ledger can still be WRITTEN to ==='
-- The rule that matters most after the four refusals: a trigger that made the
-- ledger read-only would pass every test above and break the entire product.
DO $$
DECLARE v_user BIGINT; v_wallet BIGINT; v_float BIGINT; v_entry BIGINT; v_balance BIGINT;
BEGIN
    SELECT id INTO v_user FROM users WHERE email = 'imm-customer@example.ng';
    SELECT id INTO v_wallet FROM accounts
     WHERE kind = 'customer_wallet' AND owner_id = v_user AND currency = 'NGN';
    SELECT id INTO v_float FROM accounts WHERE kind = 'provider_float' AND currency = 'NGN';

    INSERT INTO journal_entries (kind, idempotency_key, description, occurred_at)
    VALUES ('wallet_funding', 'imm:second-entry', 'still writable', now())
    RETURNING id INTO v_entry;

    INSERT INTO postings (journal_entry_id, account_id, amount_minor, currency) VALUES
      (v_entry, v_float,  -25000, 'NGN'),
      (v_entry, v_wallet,  25000, 'NGN');

    -- And the balance trigger still fired, which is the part an over-broad
    -- trigger would have broken: `account_balances` must stay updatable.
    SELECT balance_minor INTO v_balance FROM account_balances WHERE account_id = v_wallet;
    IF v_balance <> 75000 THEN
        RAISE EXCEPTION 'TEST FAILED: expected a balance of 75000, got %', v_balance;
    END IF;
    RAISE NOTICE 'PASS: entries still post and balances still follow';
END $$;

\echo ''
\echo '=== 7. A correction is still possible, as a REVERSAL ==='
-- The supported way to undo a mistake, and the reason refusing UPDATE costs
-- nothing: history gains a row rather than losing one.
DO $$
DECLARE v_user BIGINT; v_wallet BIGINT; v_float BIGINT;
        v_original BIGINT; v_reversal BIGINT; v_balance BIGINT;
BEGIN
    SELECT id INTO v_user FROM users WHERE email = 'imm-customer@example.ng';
    SELECT id INTO v_wallet FROM accounts
     WHERE kind = 'customer_wallet' AND owner_id = v_user AND currency = 'NGN';
    SELECT id INTO v_float FROM accounts WHERE kind = 'provider_float' AND currency = 'NGN';
    SELECT id INTO v_original FROM journal_entries WHERE idempotency_key = 'imm:second-entry';

    INSERT INTO journal_entries (kind, idempotency_key, description, occurred_at, reverses_id)
    VALUES ('reversal', 'imm:reversal', 'undoing the second entry', now(), v_original)
    RETURNING id INTO v_reversal;

    INSERT INTO postings (journal_entry_id, account_id, amount_minor, currency) VALUES
      (v_reversal, v_wallet, -25000, 'NGN'),
      (v_reversal, v_float,   25000, 'NGN');

    SELECT balance_minor INTO v_balance FROM account_balances WHERE account_id = v_wallet;
    IF v_balance <> 50000 THEN
        RAISE EXCEPTION 'TEST FAILED: expected 50000 after reversal, got %', v_balance;
    END IF;
    RAISE NOTICE 'PASS: a mistake is corrected by appending, not by editing';
END $$;

\echo ''
\echo 'ledger immutability: all blocks passed'
