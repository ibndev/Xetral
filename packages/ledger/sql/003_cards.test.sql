-- ===========================================================================
--  Xetral — Phase 5 card invariant tests
--  packages/ledger/sql/003_cards.test.sql
--
--  Same contract as the other suites: each block asserts a specific bad write
--  is REJECTED. Run with -v ON_ERROR_STOP=1 against a freshly created database.
-- ===========================================================================

\set QUIET on
\pset format unaligned
\pset tuples_only on

-- Resolve-or-create, because a PLATFORM account (provider_float USD) has one
-- row per currency for the whole database and the other invariant suites in
-- this file's company create it first. Inserting unconditionally aborts the
-- run with a unique violation that looks like a card bug and is not.
CREATE OR REPLACE FUNCTION test_account(
    p_kind account_kind, p_owner BIGINT, p_currency TEXT, p_normal TEXT
) RETURNS BIGINT AS $fn$
DECLARE v_id BIGINT;
BEGIN
    SELECT id INTO v_id FROM accounts
     WHERE kind = p_kind AND currency = p_currency
       AND owner_id IS NOT DISTINCT FROM p_owner;
    IF v_id IS NOT NULL THEN RETURN v_id; END IF;

    INSERT INTO accounts (kind, owner_type, owner_id, currency, normal_balance)
    VALUES (p_kind,
            CASE WHEN p_owner IS NULL THEN NULL ELSE 'user' END,
            p_owner, p_currency, p_normal)
    RETURNING id INTO v_id;
    RETURN v_id;
END;
$fn$ LANGUAGE plpgsql;

INSERT INTO users (email, status) VALUES
  ('card-owner@example.ng', 'active'),
  ('card-other@example.ng', 'active');

INSERT INTO provider_customers (user_id, provider, provider_customer_id)
SELECT id, 'bitnob', 'cus_' || id FROM users WHERE email LIKE 'card-%';

\echo '=== 1. A card can be issued and activated ==='
DO $$
DECLARE v_user BIGINT; v_card BIGINT; v_status card_status;
BEGIN
    SELECT id INTO v_user FROM users WHERE email = 'card-owner@example.ng';

    INSERT INTO cards (user_id, provider_card_id, last4, expiry_month, expiry_year)
    VALUES (v_user, 'card_aaa', '4242', 11, 2030) RETURNING id INTO v_card;

    SELECT status INTO v_status FROM cards WHERE id = v_card;
    IF v_status <> 'pending' THEN
        RAISE EXCEPTION 'TEST FAILED: a new card should start pending, got %', v_status;
    END IF;

    UPDATE cards SET status = 'active' WHERE id = v_card;
    RAISE NOTICE 'PASS: card % issued pending and activated', v_card;
END $$;

\echo ''
\echo '=== 2. One provider card id maps to exactly one card ==='
-- The webhook lookup key. Two rows for one provider card would make an inbound
-- event ambiguous about whose money moved.
DO $$
DECLARE v_user BIGINT;
BEGIN
    SELECT id INTO v_user FROM users WHERE email = 'card-other@example.ng';
    INSERT INTO cards (user_id, provider_card_id) VALUES (v_user, 'card_aaa');
    RAISE EXCEPTION 'TEST FAILED: a provider card id was reused across users';
EXCEPTION
    WHEN unique_violation THEN
        RAISE NOTICE 'PASS: duplicate provider_card_id rejected';
END $$;

\echo ''
\echo '=== 3. One provider customer belongs to one user ==='
DO $$
DECLARE v_user BIGINT;
BEGIN
    SELECT id INTO v_user FROM users WHERE email = 'card-other@example.ng';
    INSERT INTO provider_customers (user_id, provider, provider_customer_id)
    VALUES (v_user, 'bitnob', (SELECT provider_customer_id FROM provider_customers LIMIT 1));
    RAISE EXCEPTION 'TEST FAILED: a provider customer was shared between users';
EXCEPTION
    WHEN unique_violation THEN
        RAISE NOTICE 'PASS: duplicate provider_customer_id rejected';
END $$;

\echo ''
\echo '=== 4. Termination is FINAL ==='
DO $$
DECLARE v_card BIGINT;
BEGIN
    SELECT id INTO v_card FROM cards WHERE provider_card_id = 'card_aaa';
    UPDATE cards SET status = 'terminated', terminated_at = now() WHERE id = v_card;

    UPDATE cards SET status = 'active', terminated_at = NULL WHERE id = v_card;
    RAISE EXCEPTION 'TEST FAILED: a terminated card was reactivated';
EXCEPTION
    WHEN check_violation THEN
        RAISE NOTICE 'PASS: rejected -> %', SQLERRM;
END $$;

\echo ''
\echo '=== 4a. A terminated card must carry the moment it happened ==='
DO $$
DECLARE v_user BIGINT; v_card BIGINT;
BEGIN
    SELECT id INTO v_user FROM users WHERE email = 'card-other@example.ng';
    INSERT INTO cards (user_id, provider_card_id) VALUES (v_user, 'card_bbb')
    RETURNING id INTO v_card;

    -- Status says terminated, timestamp says otherwise. An investigation
    -- cannot proceed from a row that contradicts itself.
    UPDATE cards SET status = 'terminated' WHERE id = v_card;
    RAISE EXCEPTION 'TEST FAILED: terminated with no terminated_at';
EXCEPTION
    WHEN check_violation THEN
        RAISE NOTICE 'PASS: rejected -> %', SQLERRM;
END $$;

\echo ''
\echo '=== 5. A card cannot be moved to another user ==='
-- Every webhook already delivered points at this row. Reassigning it would
-- retroactively route somebody else's spending to a different customer.
DO $$
DECLARE v_card BIGINT; v_owner BIGINT; v_other BIGINT; v_updated INT;
BEGIN
    SELECT id INTO v_owner FROM users WHERE email = 'card-owner@example.ng';
    SELECT id INTO v_other FROM users WHERE email = 'card-other@example.ng';

    -- Created here rather than reused from an earlier block. Test 4a ends in a
    -- rollback, so a row it inserted is gone by now -- and an UPDATE matching
    -- zero rows fires no trigger and raises nothing, which would make this test
    -- pass while proving nothing.
    INSERT INTO cards (user_id, provider_card_id) VALUES (v_other, 'card_move')
    RETURNING id INTO v_card;

    UPDATE cards SET user_id = v_owner WHERE id = v_card;
    GET DIAGNOSTICS v_updated = ROW_COUNT;

    IF v_updated = 0 THEN
        RAISE EXCEPTION 'TEST FAILED: the update matched no rows, so nothing was tested';
    END IF;
    RAISE EXCEPTION 'TEST FAILED: a card was reassigned to another user';
EXCEPTION
    WHEN check_violation THEN
        RAISE NOTICE 'PASS: rejected -> %', SQLERRM;
END $$;

\echo ''
\echo '=== 6. Only four digits of a card number can be stored ==='
-- A CHECK rather than a convention: "just the last four" becomes "the whole
-- number" the first time somebody is in a hurry, and a database dump then
-- contains PANs.
DO $$
DECLARE v_user BIGINT;
BEGIN
    SELECT id INTO v_user FROM users WHERE email = 'card-owner@example.ng';
    INSERT INTO cards (user_id, provider_card_id, last4)
    VALUES (v_user, 'card_ccc', '5399831234567890');
    RAISE EXCEPTION 'TEST FAILED: a full PAN was stored in last4';
EXCEPTION
    WHEN check_violation THEN
        RAISE NOTICE 'PASS: full PAN rejected by the last4 constraint';
END $$;

\echo ''
\echo '=== 7. A card spends its OWN balance, not the wallet ==='
-- The correction this phase makes to Phase 3. A card funded with $10 must not
-- be able to authorise $500 because the wallet happens to hold it.
DO $$
DECLARE
    v_user BIGINT; v_entry BIGINT;
    v_wallet BIGINT; v_card_acct BIGINT; v_pending BIGINT; v_float BIGINT;
BEGIN
    SELECT id INTO v_user FROM users WHERE email = 'card-owner@example.ng';

    v_wallet    := test_account('customer_wallet',  v_user, 'USD', 'credit');
    v_card_acct := test_account('customer_card',     v_user, 'USD', 'credit');
    v_pending   := test_account('customer_pending',  v_user, 'USD', 'credit');
    v_float     := test_account('provider_float',    NULL,   'USD', 'debit');

    -- Wallet holds $500; the card is funded with $10.
    INSERT INTO journal_entries (idempotency_key, kind, occurred_at)
    VALUES ('cards:fund-wallet-' || v_user, 'wallet_funding', now()) RETURNING id INTO v_entry;
    INSERT INTO postings (journal_entry_id, account_id, amount_minor, currency) VALUES
      (v_entry, v_wallet, 50000, 'USD'), (v_entry, v_float, -50000, 'USD');

    INSERT INTO journal_entries (idempotency_key, kind, occurred_at)
    VALUES ('cards:fund-card-' || v_user, 'card_funding', now()) RETURNING id INTO v_entry;
    INSERT INTO postings (journal_entry_id, account_id, amount_minor, currency) VALUES
      (v_entry, v_wallet, -1000, 'USD'), (v_entry, v_card_acct, 1000, 'USD');

    -- $500 authorised against a $10 card. Balanced, and still impossible.
    INSERT INTO journal_entries (idempotency_key, kind, occurred_at)
    VALUES ('cards:over-auth-' || v_user, 'card_authorization', now()) RETURNING id INTO v_entry;
    INSERT INTO postings (journal_entry_id, account_id, amount_minor, currency) VALUES
      (v_entry, v_card_acct, -50000, 'USD'), (v_entry, v_pending, 50000, 'USD');

    RAISE EXCEPTION 'TEST FAILED: a card authorised more than its own balance';
EXCEPTION
    WHEN check_violation THEN
        RAISE NOTICE 'PASS: rejected -> %', SQLERRM;
END $$;

\echo ''
\echo '=== 8. The full card lifecycle balances ==='
DO $$
DECLARE
    v_user BIGINT; v_entry BIGINT;
    v_wallet BIGINT; v_card_acct BIGINT; v_pending BIGINT; v_float BIGINT;
    v_card_balance BIGINT; v_pending_balance BIGINT; v_wallet_balance BIGINT;
BEGIN
    -- Creates its own accounts. Test 7 ends by catching an exception, which in
    -- plpgsql rolls the whole block back to its savepoint -- so the accounts it
    -- set up are gone, and reusing them here would look up NULLs.
    SELECT id INTO v_user FROM users WHERE email = 'card-other@example.ng';

    v_wallet    := test_account('customer_wallet',  v_user, 'USD', 'credit');
    v_card_acct := test_account('customer_card',     v_user, 'USD', 'credit');
    v_pending   := test_account('customer_pending',  v_user, 'USD', 'credit');
    v_float     := test_account('provider_float',    NULL,   'USD', 'debit');

    -- Wallet holds $500.
    INSERT INTO journal_entries (idempotency_key, kind, occurred_at)
    VALUES ('cards:life-fund-wallet-' || v_user, 'wallet_funding', now()) RETURNING id INTO v_entry;
    INSERT INTO postings (journal_entry_id, account_id, amount_minor, currency) VALUES
      (v_entry, v_wallet, 50000, 'USD'), (v_entry, v_float, -50000, 'USD');

    -- Load $10 onto the card.
    INSERT INTO journal_entries (idempotency_key, kind, occurred_at)
    VALUES ('cards:life-fund-card-' || v_user, 'card_funding', now()) RETURNING id INTO v_entry;
    INSERT INTO postings (journal_entry_id, account_id, amount_minor, currency) VALUES
      (v_entry, v_wallet, -1000, 'USD'), (v_entry, v_card_acct, 1000, 'USD');

    -- Authorise $2.50 against the card.
    INSERT INTO journal_entries (idempotency_key, kind, occurred_at)
    VALUES ('cards:life-auth-' || v_user, 'card_authorization', now()) RETURNING id INTO v_entry;
    INSERT INTO postings (journal_entry_id, account_id, amount_minor, currency) VALUES
      (v_entry, v_card_acct, -250, 'USD'), (v_entry, v_pending, 250, 'USD');

    -- Settle it: the hold becomes a real spend at the provider.
    INSERT INTO journal_entries (idempotency_key, kind, occurred_at)
    VALUES ('cards:life-settle-' || v_user, 'card_settlement', now()) RETURNING id INTO v_entry;
    INSERT INTO postings (journal_entry_id, account_id, amount_minor, currency) VALUES
      (v_entry, v_pending, -250, 'USD'), (v_entry, v_float, 250, 'USD');

    -- Terminate: the $7.50 left on the card comes back to the wallet.
    INSERT INTO journal_entries (idempotency_key, kind, occurred_at)
    VALUES ('cards:life-terminate-' || v_user, 'card_termination', now()) RETURNING id INTO v_entry;
    INSERT INTO postings (journal_entry_id, account_id, amount_minor, currency) VALUES
      (v_entry, v_card_acct, -750, 'USD'), (v_entry, v_wallet, 750, 'USD');

    SELECT balance_minor INTO v_card_balance FROM account_balances WHERE account_id = v_card_acct;
    SELECT balance_minor INTO v_pending_balance FROM account_balances WHERE account_id = v_pending;
    SELECT balance_minor INTO v_wallet_balance FROM account_balances WHERE account_id = v_wallet;

    IF v_card_balance <> 0 OR v_pending_balance <> 0 THEN
        RAISE EXCEPTION 'TEST FAILED: card=% pending=% after a full lifecycle, both should be 0',
            v_card_balance, v_pending_balance;
    END IF;

    -- $500 in, $2.50 genuinely spent. The customer is left with $497.50 and
    -- nothing is stranded on a card that no longer exists.
    IF v_wallet_balance <> 49750 THEN
        RAISE EXCEPTION 'TEST FAILED: wallet is % after spending $2.50 of $500, expected 49750',
            v_wallet_balance;
    END IF;

    RAISE NOTICE 'PASS: fund, authorise, settle, terminate leaves card and pending at 0, wallet at %',
        v_wallet_balance;
END $$;

\echo ''
\echo '=== 9. Active cards are reportable ==='
SELECT 'active cards: ' || COUNT(*)::text || ' (pending and terminated excluded)'
  FROM active_cards;

\echo ''
\echo '=== 10. No drift after the card lifecycle ==='
SELECT CASE WHEN COUNT(*) = 0
            THEN 'PASS: zero drift across all accounts'
            ELSE 'FAIL: ' || COUNT(*)::text || ' account(s) drifted' END
  FROM ledger_drift;
