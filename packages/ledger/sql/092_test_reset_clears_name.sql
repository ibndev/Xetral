-- ============================================================================
--  092 — a reset test account gives up its NAME as well as its email and phone
--
--  091 RELEASED THE EMAIL AND THE PHONE AND KEPT THE NAME. The owner pressed
--  "Delete this test account permanently", watched the email become a
--  tombstone and the phone go blank — and the customer page still opened on
--  the person's name, which reads as an account that was not deleted at all.
--  Nothing needs it: the name is not what the ledger, the audit log, consent
--  or sign-in history point at (they point at the row's id), and a retired
--  account nobody can sign in to has nobody to greet.
--
--  THE NAME GOES TO THE RESET LOG, NOT NOWHERE. `test_account_resets` already
--  records the email and phone as they were, because "which account" is asked
--  in the words a person uses. The name is the third of those words.
--
--  ACCOUNTS ALREADY RESET ARE CLEARED TOO. Every row in the log is a retired
--  account somebody meant to delete; leaving their names would make this fix
--  apply only to the next reset.
--
--  NOT TOUCHED: a closed account number's `account_name`. `virtual_accounts`
--  is immutable by trigger and the name there is what the BANK was given — a
--  deposit already made into that number is attributed through the row, and
--  rewriting it would make the record disagree with the bank's.
-- ============================================================================

BEGIN;

ALTER TABLE test_account_resets ADD COLUMN IF NOT EXISTS full_name TEXT NULL;

CREATE OR REPLACE FUNCTION reset_test_account(p_user_id BIGINT, p_actor_id BIGINT)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_email   TEXT;
    v_phone   TEXT;
    v_name    TEXT;
    v_status  TEXT;
    v_left    TEXT;
    v_removed TEXT[] := ARRAY[]::TEXT[];
    v_n       INT;
BEGIN
    SELECT email, phone, full_name, status INTO v_email, v_phone, v_name, v_status
      FROM users WHERE id = p_user_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'no such account' USING ERRCODE = 'no_data_found';
    END IF;

    IF EXISTS (SELECT 1 FROM staff_roles WHERE user_id = p_user_id AND revoked_at IS NULL) THEN
        RAISE EXCEPTION 'a staff account cannot be reset' USING ERRCODE = 'restrict_violation';
    END IF;

    PERFORM set_config('xetral.test_reset_user', p_user_id::text, true);

    -- What the account still holds. Named, never moved: a reset is not a way
    -- to make money disappear, and the ledger keeps it owed to this row.
    SELECT string_agg(a.kind || ' ' || a.currency || ' ' || b.balance_minor, ', '
                      ORDER BY a.kind, a.currency)
      INTO v_left
      FROM accounts a JOIN account_balances b ON b.account_id = a.id
     WHERE a.owner_id = p_user_id
       AND a.kind IN ('customer_wallet', 'customer_card', 'customer_pending')
       AND b.balance_minor <> 0;

    -- How they signed in.
    DELETE FROM biometric_enrollments WHERE user_id = p_user_id;
    DELETE FROM refresh_tokens WHERE session_id IN (
        SELECT id FROM auth_sessions WHERE user_id = p_user_id);
    DELETE FROM auth_sessions WHERE user_id = p_user_id;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n > 0 THEN v_removed := v_removed || 'sessions and tokens'::TEXT; END IF;

    DELETE FROM password_reset_tokens WHERE user_id = p_user_id;
    DELETE FROM transaction_pins WHERE user_id = p_user_id;
    DELETE FROM user_credentials WHERE user_id = p_user_id;
    v_removed := v_removed || 'password and PIN'::TEXT;

    -- Devices: gone, except those sign-in history points at, which are
    -- revoked instead — that history is kept, and so must its references be.
    DELETE FROM devices d
     WHERE d.user_id = p_user_id
       AND NOT EXISTS (SELECT 1 FROM sign_in_events s WHERE s.device_id = d.id);
    UPDATE devices SET status = 'revoked' WHERE user_id = p_user_id AND status <> 'revoked';
    v_removed := v_removed || 'devices'::TEXT;

    DELETE FROM push_devices WHERE user_id = p_user_id;
    DELETE FROM notification_outbox WHERE user_id = p_user_id;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n > 0 THEN v_removed := v_removed || 'notifications'::TEXT; END IF;

    DELETE FROM recipients WHERE user_id = p_user_id;
    DELETE FROM momo_accounts WHERE user_id = p_user_id;
    DELETE FROM provider_customers WHERE user_id = p_user_id;
    v_removed := v_removed || 'saved recipients and linked wallets'::TEXT;

    -- KYC. The tier first: 085 refuses a tier above 0 with no approved
    -- submission behind it, and the submissions are about to go.
    UPDATE users SET kyc_tier = 0 WHERE id = p_user_id AND kyc_tier <> 0;
    DELETE FROM account_identity_checks WHERE user_id = p_user_id;
    DELETE FROM kyc_submissions WHERE user_id = p_user_id;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n > 0 THEN v_removed := v_removed || 'identity details'::TEXT; END IF;

    IF v_email IS NOT NULL THEN
        DELETE FROM signup_email_codes WHERE email = lower(v_email);
    END IF;

    -- The account number. Closed, never deleted — deposits already made into
    -- it are attributed through this row. The service switched it off at the
    -- rail first, so the next registration is issued a fresh one.
    UPDATE virtual_accounts SET status = 'closed' WHERE user_id = p_user_id AND status <> 'closed';
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n > 0 THEN v_removed := v_removed || 'account number'::TEXT; END IF;

    /* The email, phone and NAME, released. A tombstone rather than a null for
       the email, as 034 does — the unique index is what refuses a duplicate,
       and the tombstone keeps this row from ever matching one. The name has
       no index to satisfy, so it is simply gone (092). */
    UPDATE users
       SET email = 'reset+' || uuid || '@invalid',
           phone = NULL,
           full_name = NULL,
           status = 'closed'
     WHERE id = p_user_id;
    IF v_name IS NOT NULL THEN v_removed := v_removed || 'name'::TEXT; END IF;

    IF v_status IS DISTINCT FROM 'closed' THEN
        INSERT INTO user_status_changes (user_id, from_status, to_status, changed_by, reason)
        VALUES (p_user_id, v_status, 'closed', p_actor_id, 'test account reset');
    END IF;

    INSERT INTO test_account_resets (user_id, email, phone, full_name, reset_by, removed, left_behind)
    VALUES (p_user_id, v_email, v_phone, v_name, p_actor_id,
            array_to_string(v_removed, ', '), v_left);

    RETURN array_to_string(v_removed, ', ');
END;
$$;

-- The accounts already reset under 091.
UPDATE users
   SET full_name = NULL
 WHERE full_name IS NOT NULL
   AND status = 'closed'
   AND id IN (SELECT user_id FROM test_account_resets);

COMMIT;
