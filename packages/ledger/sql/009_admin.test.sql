-- ===========================================================================
--  Xetral — operations invariant tests
--  packages/ledger/sql/009_admin.test.sql
-- ===========================================================================

\set QUIET on
\pset format unaligned
\pset tuples_only on

INSERT INTO users (email, status) VALUES
  ('op-customer@example.ng', 'active'),
  ('op-admin@example.ng', 'active');

\echo '=== 1. A fee outside its bounds is REFUSED ==='
-- The one mistake that takes money from every customer at once: 1500 meant as
-- 1.5%, entered where the unit is basis points.
DO $$
DECLARE v_admin BIGINT;
BEGIN
    SELECT id INTO v_admin FROM users WHERE email = 'op-admin@example.ng';
    UPDATE platform_settings SET value = '1500', updated_by = v_admin
     WHERE key = 'transfer_fee_basis_points';
    RAISE EXCEPTION 'TEST FAILED: a 15%% transfer fee was accepted';
EXCEPTION
    WHEN check_violation THEN
        RAISE NOTICE 'PASS: a fee above the cap is refused before it reaches a customer';
END $$;

\echo ''
\echo '=== 2. A setting must be the type it claims ==='
DO $$
BEGIN
    UPDATE platform_settings SET value = 'yes' WHERE key = 'gift_cards_enabled';
    RAISE EXCEPTION 'TEST FAILED: ''yes'' was accepted as a boolean';
EXCEPTION
    WHEN check_violation THEN
        RAISE NOTICE 'PASS: booleans are exactly true or false, never ''yes'' or ''1''';
END $$;

\echo ''
\echo '=== 3. A legal change is recorded in history ==='
DO $$
DECLARE v_admin BIGINT; v_rows BIGINT; v_value TEXT;
BEGIN
    SELECT id INTO v_admin FROM users WHERE email = 'op-admin@example.ng';
    UPDATE platform_settings SET value = '150', updated_by = v_admin
     WHERE key = 'transfer_fee_basis_points';

    SELECT value INTO v_value FROM platform_settings WHERE key = 'transfer_fee_basis_points';
    IF v_value <> '150' THEN
        RAISE EXCEPTION 'TEST FAILED: the setting did not change';
    END IF;

    SELECT COUNT(*) INTO v_rows FROM platform_settings_history
     WHERE key = 'transfer_fee_basis_points' AND new_value = '150';
    IF v_rows <> 1 THEN
        RAISE EXCEPTION 'TEST FAILED: the change was not recorded';
    END IF;
    RAISE NOTICE 'PASS: "who set the fee, and when" has an answer';
END $$;

\echo ''
\echo '=== 4. A setting''s key and type are fixed ==='
DO $$
BEGIN
    UPDATE platform_settings SET value_type = 'text' WHERE key = 'transfer_fee_basis_points';
    RAISE EXCEPTION 'TEST FAILED: a setting changed type under its readers';
EXCEPTION
    WHEN check_violation THEN
        RAISE NOTICE 'PASS: a setting cannot change type beneath the code reading it';
END $$;

\echo ''
\echo '=== 5. The audit log is APPEND-ONLY, and survives the attempts ==='
-- A log a privileged user can edit tells you what the last person with access
-- wanted you to believe.
DO $$
DECLARE v_admin BIGINT; v_id BIGINT; v_left BIGINT;
BEGIN
    SELECT id INTO v_admin FROM users WHERE email = 'op-admin@example.ng';
    INSERT INTO admin_audit_log (actor_id, action, subject_type, subject_id, reason)
    VALUES (v_admin, 'user.freeze', 'user', '1', 'suspected fraud')
    RETURNING id INTO v_id;

    -- Both attempts go in NESTED blocks so their rollbacks do not discard the
    -- row above. Without that, this block's own handler would undo the insert
    -- and the DELETE would match nothing -- a test that passes because its
    -- setup vanished, which is the same trap the purchase suite hit.
    BEGIN
        UPDATE admin_audit_log SET action = 'user.unfreeze' WHERE id = v_id;
        RAISE EXCEPTION 'TEST FAILED: an audit entry was rewritten';
    EXCEPTION
        WHEN check_violation THEN
            RAISE NOTICE 'PASS: the audit log cannot be edited by the people it audits';
    END;

    BEGIN
        DELETE FROM admin_audit_log WHERE id = v_id;
        RAISE EXCEPTION 'TEST FAILED: an audit entry was deleted';
    EXCEPTION
        WHEN check_violation THEN
            RAISE NOTICE 'PASS: audit entries cannot be deleted either';
    END;

    -- And prove the row is still there, rather than trusting two handlers.
    SELECT COUNT(*) INTO v_left FROM admin_audit_log WHERE id = v_id;
    IF v_left <> 1 THEN
        RAISE EXCEPTION 'TEST FAILED: the audit entry did not survive';
    END IF;
END $$;

\echo ''
\echo '=== 6. Taking something away must say WHY ==='
DO $$
DECLARE v_admin BIGINT;
BEGIN
    SELECT id INTO v_admin FROM users WHERE email = 'op-admin@example.ng';
    INSERT INTO admin_audit_log (actor_id, action, subject_type, subject_id)
    VALUES (v_admin, 'user.freeze', 'user', '1');
    RAISE EXCEPTION 'TEST FAILED: an account was frozen with no recorded reason';
EXCEPTION
    WHEN check_violation THEN
        RAISE NOTICE 'PASS: a frozen account always records why, so it can be safely unfrozen';
END $$;

\echo ''
\echo '=== 7. A BVN cannot be stored in the clear ==='
DO $$
DECLARE v_user BIGINT;
BEGIN
    SELECT id INTO v_user FROM users WHERE email = 'op-customer@example.ng';
    INSERT INTO kyc_submissions
      (user_id, full_name, date_of_birth, phone, bvn_sealed, bvn_last4, address)
    VALUES (v_user, 'Adebayo Oluwaseun', '1990-01-01', '+2348030000000',
            '22212345678', '5678', '12 Awolowo Road, Lagos');
    RAISE EXCEPTION 'TEST FAILED: a plaintext BVN reached a row';
EXCEPTION
    WHEN check_violation THEN
        RAISE NOTICE 'PASS: a BVN is sealed or it is not stored';
END $$;

\echo ''
\echo '=== 8. One open KYC submission per customer ==='
DO $$
DECLARE v_user BIGINT;
BEGIN
    SELECT id INTO v_user FROM users WHERE email = 'op-customer@example.ng';
    INSERT INTO kyc_submissions
      (user_id, full_name, date_of_birth, phone, bvn_sealed, bvn_last4, address)
    VALUES (v_user, 'Adebayo Oluwaseun', '1990-01-01', '+2348030000000',
            'v1:sealed', '5678', '12 Awolowo Road, Lagos');

    BEGIN
        INSERT INTO kyc_submissions
          (user_id, full_name, date_of_birth, phone, bvn_sealed, bvn_last4, address)
        VALUES (v_user, 'Adebayo O.', '1990-01-01', '+2348030000000',
                'v1:sealed2', '5678', '12 Awolowo Road, Lagos');
        RAISE EXCEPTION 'TEST FAILED: a customer had two open submissions';
    EXCEPTION
        WHEN unique_violation THEN
            RAISE NOTICE 'PASS: one open submission, so nobody approves the flattering copy';
    END;
END $$;

\echo ''
\echo '=== 9. Nobody approves their OWN identity documents ==='
DO $$
DECLARE v_user BIGINT; v_id BIGINT;
BEGIN
    SELECT id INTO v_user FROM users WHERE email = 'op-customer@example.ng';
    SELECT id INTO v_id FROM kyc_submissions WHERE user_id = v_user;

    UPDATE kyc_submissions
       SET status = 'approved', reviewed_by = v_user, reviewed_at = now()
     WHERE id = v_id;
    RAISE EXCEPTION 'TEST FAILED: a customer approved their own KYC';
EXCEPTION
    WHEN check_violation THEN
        RAISE NOTICE 'PASS: identity documents are reviewed by somebody else';
END $$;

\echo ''
\echo '=== 10. A rejected submission must say why ==='
DO $$
DECLARE v_user BIGINT; v_admin BIGINT; v_id BIGINT;
BEGIN
    SELECT id INTO v_user  FROM users WHERE email = 'op-customer@example.ng';
    SELECT id INTO v_admin FROM users WHERE email = 'op-admin@example.ng';
    SELECT id INTO v_id FROM kyc_submissions WHERE user_id = v_user;

    UPDATE kyc_submissions
       SET status = 'rejected', reviewed_by = v_admin, reviewed_at = now()
     WHERE id = v_id;
    RAISE EXCEPTION 'TEST FAILED: KYC was rejected with no reason';
EXCEPTION
    WHEN check_violation THEN
        RAISE NOTICE 'PASS: a customer is always told why';
END $$;

\echo ''
\echo '=== 11. KYC documents are immutable once submitted ==='
DO $$
DECLARE v_user BIGINT; v_id BIGINT;
BEGIN
    SELECT id INTO v_user FROM users WHERE email = 'op-customer@example.ng';
    SELECT id INTO v_id FROM kyc_submissions WHERE user_id = v_user;
    UPDATE kyc_submissions SET full_name = 'Somebody Else' WHERE id = v_id;
    RAISE EXCEPTION 'TEST FAILED: reviewed documents were edited';
EXCEPTION
    WHEN check_violation THEN
        RAISE NOTICE 'PASS: the record shows what was actually reviewed';
END $$;

\echo ''
\echo '=== 12. A status change must carry a reason ==='
DO $$
DECLARE v_user BIGINT; v_admin BIGINT;
BEGIN
    SELECT id INTO v_user  FROM users WHERE email = 'op-customer@example.ng';
    SELECT id INTO v_admin FROM users WHERE email = 'op-admin@example.ng';
    INSERT INTO user_status_changes (user_id, from_status, to_status, changed_by, reason)
    VALUES (v_user, 'active', 'frozen', v_admin, '');
    RAISE EXCEPTION 'TEST FAILED: an account was frozen with an empty reason';
EXCEPTION
    WHEN check_violation THEN
        RAISE NOTICE 'PASS: freezing an account records a real reason';
END $$;

\echo ''
\echo '=== 13. The work queue answers "is anything stuck?" in one query ==='
DO $$
DECLARE v_queues BIGINT;
BEGIN
    SELECT COUNT(*) INTO v_queues FROM admin_work_queue;
    IF v_queues < 5 THEN
        RAISE EXCEPTION 'TEST FAILED: the work queue lost a queue (% present)', v_queues;
    END IF;
    RAISE NOTICE 'PASS: % queues reported in one query', v_queues;
END $$;

\echo ''
\echo '=== 14. Liability is computed from POSTINGS, not a cache ==='
--
-- TWO THINGS HERE ARE ABOUT THE SHARED DATABASE, not about liability, and both
-- of them broke this block in CI while it passed when the file was run alone.
--
-- 1. `provider_float` is a PLATFORM account: one row per currency for the whole
--    database, so by the time this file runs the ledger suite has already
--    created the NGN one. Inserting unconditionally aborts with a unique
--    violation that reads as an admin bug and is not. Phase 5 recorded exactly
--    this and gave the card suite a resolve-or-create; this file needed one too.
--
-- 2. `admin_liability` sums EVERY customer account in the database, so an
--    equality against 7,500,000 is a claim about what every earlier suite
--    happened to leave behind. The assertion is on the DELTA instead — which is
--    the real claim anyway: that posting 7,500,000 to a wallet moves the view
--    by exactly that, because the view reads the ledger rather than a cache.
--
-- Same shape as the reconciliation worker's counts, which are lower bounds for
-- the same reason: a suite that demands exact global figures only works on an
-- empty database, and CI's is never empty by the time it gets here.
CREATE OR REPLACE FUNCTION admin_test_account(
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

DO $$
DECLARE
    v_user BIGINT; v_wallet BIGINT; v_float BIGINT; v_entry BIGINT;
    v_before BIGINT; v_after BIGINT;
BEGIN
    SELECT id INTO v_user FROM users WHERE email = 'op-customer@example.ng';

    v_wallet := admin_test_account('customer_wallet', v_user, 'NGN', 'credit');
    v_float  := admin_test_account('provider_float',  NULL,   'NGN', 'debit');

    SELECT COALESCE(total_owed_minor, 0) INTO v_before
      FROM admin_liability WHERE currency = 'NGN';
    v_before := COALESCE(v_before, 0);

    INSERT INTO journal_entries (idempotency_key, kind, description, occurred_at)
    VALUES ('op:liability', 'wallet_funding', 'test', now()) RETURNING id INTO v_entry;
    INSERT INTO postings (journal_entry_id, account_id, amount_minor, currency)
    VALUES (v_entry, v_wallet, 7500000, 'NGN'), (v_entry, v_float, -7500000, 'NGN');

    SELECT COALESCE(total_owed_minor, 0) INTO v_after
      FROM admin_liability WHERE currency = 'NGN';

    IF v_after - v_before <> 7500000 THEN
        RAISE EXCEPTION 'TEST FAILED: liability moved by % rather than 7500000',
            v_after - v_before;
    END IF;
    RAISE NOTICE 'PASS: what we owe customers is read from the ledger itself';
END $$;
