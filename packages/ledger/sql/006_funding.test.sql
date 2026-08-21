-- ===========================================================================
--  Xetral — Phase 8 funding invariant tests
--  packages/ledger/sql/006_funding.test.sql
--
--  This is the first inbound money in the platform. Every block below is a way
--  a customer's deposit goes to the wrong place, arrives twice, or vanishes.
-- ===========================================================================

\set QUIET on
\pset format unaligned
\pset tuples_only on

CREATE OR REPLACE FUNCTION fund_account(
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

CREATE OR REPLACE FUNCTION fund_entry(p_key TEXT, p_user BIGINT, p_minor BIGINT)
RETURNS BIGINT AS $fn$
DECLARE v_entry BIGINT;
BEGIN
    INSERT INTO journal_entries (idempotency_key, kind, description, occurred_at)
    VALUES (p_key, 'wallet_funding', 'test funding', now())
    RETURNING id INTO v_entry;

    INSERT INTO postings (journal_entry_id, account_id, amount_minor, currency)
    VALUES (v_entry, fund_account('customer_wallet', p_user, 'NGN', 'credit'), p_minor, 'NGN'),
           (v_entry, fund_account('provider_float', NULL, 'NGN', 'debit'), -p_minor, 'NGN');
    RETURN v_entry;
END;
$fn$ LANGUAGE plpgsql;

INSERT INTO users (email, status) VALUES
  ('fund-a@example.ng', 'active'),
  ('fund-b@example.ng', 'active');

\echo '=== 1. A customer gets one live NGN account ==='
DO $$
DECLARE v_user BIGINT; v_id BIGINT; v_status virtual_account_status;
BEGIN
    SELECT id INTO v_user FROM users WHERE email = 'fund-a@example.ng';

    INSERT INTO virtual_accounts
      (user_id, provider_account_id, account_number, bank_name, account_name)
    VALUES (v_user, 'bva_1', '0123456789', 'Providus Bank', 'XETRAL/ADEBAYO O.')
    RETURNING id INTO v_id;

    SELECT status INTO v_status FROM virtual_accounts WHERE id = v_id;
    IF v_status <> 'pending' THEN
        RAISE EXCEPTION 'TEST FAILED: a new virtual account was not pending';
    END IF;
    RAISE NOTICE 'PASS: virtual account % issued, awaiting activation', v_id;
END $$;

\echo ''
\echo '=== 2. A customer cannot hold TWO live NGN accounts ==='
-- Two live accounts means two numbers in circulation, and a customer paying
-- into the one we stopped watching.
DO $$
DECLARE v_user BIGINT;
BEGIN
    SELECT id INTO v_user FROM users WHERE email = 'fund-a@example.ng';
    INSERT INTO virtual_accounts
      (user_id, provider_account_id, account_number, bank_name, account_name)
    VALUES (v_user, 'bva_dup', '0123456780', 'Providus Bank', 'XETRAL/ADEBAYO O.');
    RAISE EXCEPTION 'TEST FAILED: a second live NGN account was issued';
EXCEPTION
    WHEN unique_violation THEN
        RAISE NOTICE 'PASS: one live account per customer per currency';
END $$;

\echo ''
\echo '=== 3. An account NUMBER belongs to exactly one row ==='
-- The number is what a customer types. Two rows sharing one is a deposit
-- credited to whichever was read first.
DO $$
DECLARE v_other BIGINT;
BEGIN
    SELECT id INTO v_other FROM users WHERE email = 'fund-b@example.ng';
    INSERT INTO virtual_accounts
      (user_id, provider_account_id, account_number, bank_name, account_name)
    VALUES (v_other, 'bva_2', '0123456789', 'Providus Bank', 'XETRAL/CHIDI N.');
    RAISE EXCEPTION 'TEST FAILED: two customers share an account number';
EXCEPTION
    WHEN unique_violation THEN
        RAISE NOTICE 'PASS: a NUBAN identifies one customer';
END $$;

\echo ''
\echo '=== 3a. A malformed NUBAN cannot be stored ==='
-- A Nigerian account number is exactly ten digits. Anything else is a typo or
-- a truncation, and either way it is a number a customer would pay into.
DO $$
DECLARE v_other BIGINT;
BEGIN
    SELECT id INTO v_other FROM users WHERE email = 'fund-b@example.ng';
    INSERT INTO virtual_accounts
      (user_id, provider_account_id, account_number, bank_name, account_name)
    VALUES (v_other, 'bva_bad', '12345', 'Providus Bank', 'XETRAL/CHIDI N.');
    RAISE EXCEPTION 'TEST FAILED: a malformed account number was stored';
EXCEPTION
    WHEN check_violation THEN
        RAISE NOTICE 'PASS: an account number is ten digits or it is not stored';
END $$;

\echo ''
\echo '=== 4. An issued account cannot change owner ==='
-- Deposits already made point at this row, including ones in flight during
-- the UPDATE.
DO $$
DECLARE v_id BIGINT; v_other BIGINT;
BEGIN
    SELECT id INTO v_id FROM virtual_accounts WHERE provider_account_id = 'bva_1';
    SELECT id INTO v_other FROM users WHERE email = 'fund-b@example.ng';
    UPDATE virtual_accounts SET user_id = v_other WHERE id = v_id;
    RAISE EXCEPTION 'TEST FAILED: a virtual account was reassigned';
EXCEPTION
    WHEN check_violation THEN
        RAISE NOTICE 'PASS: an issued account keeps its owner and its number';
END $$;

\echo ''
\echo '=== 5. A deposit is credited ONCE per provider reference ==='
-- The webhook replay guard, at the deposit level. The journal has its own; the
-- two would have to fail together to double-credit a customer.
DO $$
DECLARE v_user BIGINT; v_acct BIGINT; v_entry BIGINT; v_second BIGINT;
BEGIN
    SELECT id INTO v_user FROM users WHERE email = 'fund-a@example.ng';
    SELECT id INTO v_acct FROM virtual_accounts WHERE provider_account_id = 'bva_1';

    v_entry := fund_entry('bitnob:dep_1', v_user, 5000000);
    INSERT INTO deposits
      (provider_reference, user_id, virtual_account_id, amount_minor, currency,
       status, entry_id)
    VALUES ('dep_1', v_user, v_acct, 5000000, 'NGN', 'credited', v_entry);

    -- The retry goes in a NESTED block so its rollback does not undo the first
    -- credit. Without that, this block's own exception handler would discard
    -- the row it just wrote and the next block would have nothing to replay
    -- against -- a test that passes because the setup vanished.
    BEGIN
        v_second := fund_entry('bitnob:dep_1_again', v_user, 5000000);
        INSERT INTO deposits
          (provider_reference, user_id, virtual_account_id, amount_minor, currency,
           status, entry_id)
        VALUES ('dep_1', v_user, v_acct, 5000000, 'NGN', 'credited', v_second);
        RAISE EXCEPTION 'TEST FAILED: one bank credit was recorded twice';
    EXCEPTION
        WHEN unique_violation THEN
            RAISE NOTICE 'PASS: a redelivered deposit webhook cannot credit twice';
    END;
END $$;

\echo ''
\echo '=== 5a. And the JOURNAL refuses the replay independently ==='
-- Belt and braces, on the single most dangerous webhook in the system: this
-- one creates a customer balance out of a provider''s say-so.
DO $$
DECLARE v_user BIGINT;
BEGIN
    SELECT id INTO v_user FROM users WHERE email = 'fund-a@example.ng';
    PERFORM fund_entry('bitnob:dep_1', v_user, 5000000);
    RAISE EXCEPTION 'TEST FAILED: the ledger accepted a replayed funding key';
EXCEPTION
    WHEN unique_violation THEN
        RAISE NOTICE 'PASS: the ledger refuses the replay on its own';
END $$;

\echo ''
\echo '=== 6. A CREDITED deposit must belong to somebody ==='
DO $$
DECLARE v_user BIGINT; v_entry BIGINT;
BEGIN
    SELECT id INTO v_user FROM users WHERE email = 'fund-a@example.ng';
    v_entry := fund_entry('bitnob:dep_orphan', v_user, 100000);
    INSERT INTO deposits
      (provider_reference, amount_minor, currency, status, entry_id)
    VALUES ('dep_orphan', 100000, 'NGN', 'credited', v_entry);
    RAISE EXCEPTION 'TEST FAILED: a credited deposit had no owner';
EXCEPTION
    WHEN check_violation THEN
        RAISE NOTICE 'PASS: credited money always names the customer it credited';
END $$;

\echo ''
\echo '=== 7. An UNATTRIBUTABLE deposit is recorded, not discarded ==='
-- The money arrived whatever we can work out about it. Dropping the event
-- because it did not match a customer is how a real transfer disappears.
DO $$
DECLARE v_user BIGINT; v_entry BIGINT; v_id BIGINT; v_seen BIGINT;
BEGIN
    SELECT id INTO v_user FROM users WHERE email = 'fund-a@example.ng';
    v_entry := fund_entry('bitnob:dep_susp', v_user, 250000);

    INSERT INTO deposits
      (provider_reference, amount_minor, currency, status, entry_id,
       suspense_reason, sender_name)
    VALUES ('dep_susp', 250000, 'NGN', 'suspense', v_entry,
            'no virtual account matches 9999999999', 'UNKNOWN SENDER')
    RETURNING id INTO v_id;

    SELECT COUNT(*) INTO v_seen FROM unattributed_deposits WHERE deposit_id = v_id;
    IF v_seen <> 1 THEN
        RAISE EXCEPTION 'TEST FAILED: money in suspense is invisible';
    END IF;
    RAISE NOTICE 'PASS: unattributable money is held and visible, never dropped';
END $$;

\echo ''
\echo '=== 7a. Suspense must say WHY ==='
DO $$
DECLARE v_user BIGINT; v_entry BIGINT;
BEGIN
    SELECT id INTO v_user FROM users WHERE email = 'fund-a@example.ng';
    v_entry := fund_entry('bitnob:dep_noreason', v_user, 100000);
    INSERT INTO deposits
      (provider_reference, amount_minor, currency, status, entry_id)
    VALUES ('dep_noreason', 100000, 'NGN', 'suspense', v_entry);
    RAISE EXCEPTION 'TEST FAILED: money went to suspense with no explanation';
EXCEPTION
    WHEN check_violation THEN
        RAISE NOTICE 'PASS: suspense always records why it could not be attributed';
END $$;

\echo ''
\echo '=== 8. A deposit records what was POSTED, immutably ==='
-- If the amount could drift from the entry, the two would disagree and the
-- ledger is the one that is right.
DO $$
DECLARE v_id BIGINT;
BEGIN
    SELECT id INTO v_id FROM deposits WHERE provider_reference = 'dep_1';
    UPDATE deposits SET amount_minor = 999999999 WHERE id = v_id;
    RAISE EXCEPTION 'TEST FAILED: a credited amount was rewritten';
EXCEPTION
    WHEN check_violation THEN
        RAISE NOTICE 'PASS: a deposit is a record of what was posted';
END $$;

\echo ''
\echo '=== 9. A credited deposit cannot be re-opened ==='
DO $$
DECLARE v_id BIGINT;
BEGIN
    SELECT id INTO v_id FROM deposits WHERE provider_reference = 'dep_1';
    UPDATE deposits SET status = 'suspense', suspense_reason = 'second thoughts'
     WHERE id = v_id;
    RAISE EXCEPTION 'TEST FAILED: a credited deposit was re-opened';
EXCEPTION
    WHEN check_violation THEN
        RAISE NOTICE 'PASS: only suspense can still be resolved';
END $$;

\echo ''
\echo '=== 10. Suspense CAN be resolved, because a human fixes it ==='
DO $$
DECLARE v_id BIGINT; v_status deposit_status; v_left BIGINT;
BEGIN
    SELECT id INTO v_id FROM deposits WHERE provider_reference = 'dep_susp';
    UPDATE deposits SET status = 'returned' WHERE id = v_id;

    SELECT status INTO v_status FROM deposits WHERE id = v_id;
    IF v_status <> 'returned' THEN
        RAISE EXCEPTION 'TEST FAILED: suspense could not be resolved';
    END IF;

    SELECT COUNT(*) INTO v_left FROM unattributed_deposits WHERE deposit_id = v_id;
    IF v_left <> 0 THEN
        RAISE EXCEPTION 'TEST FAILED: a resolved deposit is still queued';
    END IF;
    RAISE NOTICE 'PASS: suspense is resolvable, and leaves the queue when it is';
END $$;

\echo ''
\echo '=== 11. A zero or negative deposit is REJECTED ==='
-- A credit of zero carries no money and a negative one is a withdrawal
-- wearing a deposit''s clothes.
DO $$
DECLARE v_user BIGINT; v_entry BIGINT;
BEGIN
    SELECT id INTO v_user FROM users WHERE email = 'fund-a@example.ng';
    v_entry := fund_entry('bitnob:dep_zero', v_user, 100000);
    INSERT INTO deposits
      (provider_reference, user_id, amount_minor, currency, status, entry_id)
    VALUES ('dep_zero', v_user, 0, 'NGN', 'credited', v_entry);
    RAISE EXCEPTION 'TEST FAILED: a zero deposit was recorded';
EXCEPTION
    WHEN check_violation THEN
        RAISE NOTICE 'PASS: a deposit moves money or it is not a deposit';
END $$;

\echo ''
\echo '=== 12. The funding entry really credits the customer ==='
-- The happy path, asserted: a schema that rejected everything would pass every
-- block above.
DO $$
DECLARE v_user BIGINT; v_wallet BIGINT; v_balance BIGINT;
BEGIN
    SELECT id INTO v_user FROM users WHERE email = 'fund-b@example.ng';
    PERFORM fund_entry('bitnob:dep_real', v_user, 7500000);

    v_wallet := fund_account('customer_wallet', v_user, 'NGN', 'credit');
    SELECT balance_minor INTO v_balance FROM account_balances WHERE account_id = v_wallet;

    IF v_balance <> 7500000 THEN
        RAISE EXCEPTION 'TEST FAILED: funding credited % rather than 7500000', v_balance;
    END IF;
    RAISE NOTICE 'PASS: a deposit of N75,000.00 lands in the customer wallet';
END $$;
