-- ============================================================================
--  091 — resetting a TEST account so its email and phone can register again
--
--  THE OWNER TESTS SIGNUP, THE ACCOUNT NUMBER AND KYC ON REAL ADDRESSES, AND
--  EACH ONE COULD BE USED ONCE. `users_email_unique` and `users_phone_unique`
--  refuse the second registration; an approved KYC submission holds the BVN
--  against every later account (025); an identity check holds it against the
--  account-number form (089); and the account number itself stays live at the
--  rail, which keys its customer on the email and hands the same number back.
--
--  WHAT THIS IS NOT: DELETING THE USER ROW. The ledger's postings, the audit
--  log, sign-in history and consent records reference it and are append-only
--  by trigger — they are the evidence of what happened, and a reset that could
--  remove them could be pointed at an account somebody wants the evidence of
--  gone. So the account is RETIRED: everything that can go goes, the email and
--  phone are released by replacing them, the status is `closed`, and what must
--  stay stays under a name nobody can sign in with.
--
--  WHICH ACCOUNTS is decided by the application, from `TEST_ACCOUNT_EMAILS` and
--  `TEST_ACCOUNT_PHONES`, on an admin route. The database adds the guard it CAN
--  hold: a staff account is refused whatever list it is on, because a reset
--  that could reach an administrator would be a way to erase one.
--
--  EVERY RESET IS WRITTEN DOWN HERE, by the same function, in the same
--  transaction. A reset with no record cannot happen.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS test_account_resets (
    id           BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    -- The retired account. Its row stays; this points at it.
    user_id      BIGINT      NOT NULL REFERENCES users(id),
    -- What was released, as it was before the reset replaced it — "which
    -- account" in the only words anybody asking will use.
    email        TEXT        NULL,
    phone        TEXT        NULL,
    reset_by     BIGINT      NOT NULL REFERENCES users(id),
    -- What went, in words.
    removed      TEXT        NOT NULL,
    -- Money the retired account still holds, per account kind and currency,
    -- in MINOR units. A reset moves no money; it names what is left.
    left_behind  TEXT        NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS test_account_resets_recent ON test_account_resets (created_at DESC);

CREATE OR REPLACE FUNCTION refuse_test_account_reset_edit() RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'test_account_resets is append-only; % is refused', TG_OP
        USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS test_account_resets_append_only ON test_account_resets;
CREATE TRIGGER test_account_resets_append_only
    BEFORE UPDATE OR DELETE ON test_account_resets
    FOR EACH ROW EXECUTE FUNCTION refuse_test_account_reset_edit();

/*
 * 089 REFUSES EVERY DELETE OF AN IDENTITY CHECK, and keeps doing so. The one
 * exception is a row belonging to the account `reset_test_account()` is
 * resetting, named by a TRANSACTION-LOCAL setting that function sets.
 *
 * Anybody can call `set_config`, so the setting alone grants nothing: the
 * application role holds no DELETE on this table (099), so the only thing
 * that can act on it is the owner-run function below.
 */
CREATE OR REPLACE FUNCTION refuse_account_identity_delete() RETURNS TRIGGER AS $$
BEGIN
    IF current_setting('xetral.test_reset_user', true) = OLD.user_id::text THEN
        RETURN OLD;
    END IF;
    RAISE EXCEPTION 'identity checks are kept, not deleted' USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

/**
 * Retires one account so its email and phone can register again.
 *
 * NAMES EVERY TABLE IT TOUCHES AND HAS NO DYNAMIC SQL — the rule
 * `apply_retention()` and `erase_customer_personal_data()` follow, because a
 * deletion job whose reach changes with an INSERT elsewhere is not a job
 * anybody reviewed. It never touches the ledger.
 *
 * ORDER MATTERS in three places: the tier comes down to 0 BEFORE the KYC rows
 * go (085 refuses a tier no approved submission supports); sessions and
 * biometrics go BEFORE the devices they reference; and the address is read
 * BEFORE it is replaced, so the log and the signup codes see the real one.
 */
CREATE OR REPLACE FUNCTION reset_test_account(p_user_id BIGINT, p_actor_id BIGINT)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_email   TEXT;
    v_phone   TEXT;
    v_status  TEXT;
    v_left    TEXT;
    v_removed TEXT[] := ARRAY[]::TEXT[];
    v_n       INT;
BEGIN
    SELECT email, phone, status INTO v_email, v_phone, v_status
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

    /* The email and phone, RELEASED by replacement. A tombstone rather than a
       null for the email, as 034 does — the unique index is what refuses a
       duplicate, and the tombstone keeps this row from ever matching one. */
    UPDATE users
       SET email = 'reset+' || uuid || '@invalid',
           phone = NULL,
           status = 'closed'
     WHERE id = p_user_id;

    IF v_status IS DISTINCT FROM 'closed' THEN
        INSERT INTO user_status_changes (user_id, from_status, to_status, changed_by, reason)
        VALUES (p_user_id, v_status, 'closed', p_actor_id, 'test account reset');
    END IF;

    INSERT INTO test_account_resets (user_id, email, phone, reset_by, removed, left_behind)
    VALUES (p_user_id, v_email, v_phone, p_actor_id,
            array_to_string(v_removed, ', '), v_left);

    RETURN array_to_string(v_removed, ', ');
END;
$$;

/*
 * A reset is destructive and cannot be undone by appending, so it joins the
 * actions that must say why. Written out in full, as every migration that
 * extends this list has done.
 */
ALTER TABLE admin_audit_log DROP CONSTRAINT IF EXISTS destructive_actions_say_why;
ALTER TABLE admin_audit_log ADD CONSTRAINT destructive_actions_say_why CHECK (
    action NOT IN ('user.freeze', 'user.close', 'deposit.return', 'giftcard.clawback',
                   'data.erase', 'price.retire', 'recovery.reverse', 'price.delete',
                   'test_account.reset')
    OR reason IS NOT NULL
);

INSERT INTO retention_decisions (table_name, decision, rationale) VALUES
  ('test_account_resets', 'keep',
   'Who reset which test account and when, and what money it still held. The '
   'record of a destructive action has to outlive the action.')
ON CONFLICT (table_name) DO NOTHING;

COMMIT;
