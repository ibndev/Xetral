-- ============================================================================
--  091 invariants — a reset test account releases its email, phone and BVN,
--  and leaves the evidence where it was
-- ============================================================================
\set ON_ERROR_STOP on

-- 0. Fixtures: an operator, a test account with everything that blocks a
--    second registration, and a staff account a reset must never reach.
DO $$
DECLARE v_test BIGINT; v_device BIGINT; v_session BIGINT;
BEGIN
  INSERT INTO users (email, phone, full_name, status) VALUES
    ('p91-operator@example.test', '+2348000009101', 'Ope Rator', 'active'),
    ('p91-tester@example.test',   '+2348000009102', 'Tess Ter',  'active'),
    ('p91-staff@example.test',    '+2348000009103', 'Staf Fer',  'active');
  INSERT INTO staff_roles (user_id, role)
  SELECT id, 'admin' FROM users WHERE email = 'p91-staff@example.test';

  SELECT id INTO v_test FROM users WHERE email = 'p91-tester@example.test';
  INSERT INTO user_credentials (user_id, password_hash)
  VALUES (v_test, 'v1:scrypt:' || encode(sha256('p91'::bytea), 'hex'));

  INSERT INTO devices (user_id, fingerprint_hash, platform, display_name)
  VALUES (v_test, encode(sha256('p91-a'::bytea), 'hex'), 'android', 'kept handset')
  RETURNING id INTO v_device;
  INSERT INTO auth_sessions (user_id, device_id) VALUES (v_test, v_device) RETURNING id INTO v_session;
  INSERT INTO refresh_tokens (session_id, token_hash, generation, expires_at)
  VALUES (v_session, encode(sha256('p91-token'::bytea), 'hex'), 0, now() + interval '30 days');
  -- Sign-in history points at this device, so the device must be KEPT.
  INSERT INTO sign_in_events (user_id, identifier_hash, device_id, outcome)
  VALUES (v_test, repeat('9', 64), v_device, 'succeeded');
  INSERT INTO devices (user_id, fingerprint_hash, platform, display_name)
  VALUES (v_test, encode(sha256('p91-b'::bytea), 'hex'), 'ios', 'spare handset');

  INSERT INTO kyc_submissions
    (user_id, full_name, date_of_birth, phone, bvn_sealed, bvn_last4, address, bvn_fingerprint)
  VALUES (v_test, 'Tess Ter', '1990-01-01', '+2348000009102', 'v1:x:y:z', '9102', 'Lagos',
          'v1:' || encode(sha256('p91-bvn'::bytea), 'hex'));
  INSERT INTO account_identity_checks
    (user_id, provider, bvn_fingerprint, bvn_last4, bank_code, account_last4, status, resolved_at)
  VALUES (v_test, 'paystack', 'v1:' || encode(sha256('p91-bvn'::bytea), 'hex'), '9102',
          '058', '1234', 'validated', now());

  INSERT INTO virtual_accounts (user_id, provider_account_id, account_number, bank_name, account_name)
  VALUES (v_test, 'p91-va', '0091000091', 'Test Bank', 'XETRAL/TESS TER');

  RAISE NOTICE 'PASS 0: fixtures';
END $$;

-- 1. A staff account is refused, whatever list the application believes it is on.
DO $$
BEGIN
  PERFORM reset_test_account(
    (SELECT id FROM users WHERE email = 'p91-staff@example.test'),
    (SELECT id FROM users WHERE email = 'p91-operator@example.test'));
  RAISE EXCEPTION 'TEST FAILED: a staff account was reset';
EXCEPTION WHEN restrict_violation THEN
  RAISE NOTICE 'PASS 1: a reset cannot reach a staff account';
END $$;

-- 2. The setting that lets the reset delete an identity check grants the
--    application role nothing on its own: it holds no DELETE.
DO $$
BEGIN
  SET LOCAL ROLE xetral_app;
  PERFORM set_config('xetral.test_reset_user',
                     (SELECT id FROM users WHERE email = 'p91-tester@example.test')::text, true);
  DELETE FROM account_identity_checks
   WHERE user_id = (SELECT id FROM users WHERE email = 'p91-tester@example.test');
  RESET ROLE;
  RAISE EXCEPTION 'TEST FAILED: the application deleted an identity check by setting a flag';
EXCEPTION WHEN insufficient_privilege THEN
  RESET ROLE;
  RAISE NOTICE 'PASS 2: only the reset function can delete an identity check';
END $$;

-- 3. The reset runs, and names what went.
DO $$
DECLARE v_removed TEXT;
BEGIN
  SET LOCAL ROLE xetral_app;
  SELECT reset_test_account(
    (SELECT id FROM users WHERE email = 'p91-tester@example.test'),
    (SELECT id FROM users WHERE email = 'p91-operator@example.test')) INTO v_removed;
  RESET ROLE;
  IF v_removed NOT LIKE '%identity details%' OR v_removed NOT LIKE '%account number%' THEN
    RAISE EXCEPTION 'TEST FAILED: the reset did not say what it removed: %', v_removed;
  END IF;
  RAISE NOTICE 'PASS 3: the application role can reset through the function';
END $$;

-- 4. The email, the phone and the BVN are free: the same person registers again
--    and their identity check stands.
DO $$
DECLARE v_new BIGINT;
BEGIN
  INSERT INTO users (email, phone, full_name, status)
  VALUES ('p91-tester@example.test', '+2348000009102', 'Tess Ter', 'active')
  RETURNING id INTO v_new;
  INSERT INTO account_identity_checks
    (user_id, provider, bvn_fingerprint, bvn_last4, bank_code, account_last4)
  VALUES (v_new, 'paystack', 'v1:' || encode(sha256('p91-bvn'::bytea), 'hex'), '9102', '058', '1234');
  INSERT INTO virtual_accounts (user_id, provider_account_id, account_number, bank_name, account_name)
  VALUES (v_new, 'p91-va-2', '0091000092', 'Test Bank', 'XETRAL/TESS TER');
  RAISE NOTICE 'PASS 4: the email, phone and BVN register again as a new customer';
END $$;

-- 5. What must stay stayed: the retired row, the sign-in history, the device
--    that history points at (revoked), and the account number (closed).
DO $$
DECLARE v_old BIGINT;
BEGIN
  SELECT user_id INTO v_old FROM test_account_resets WHERE email = 'p91-tester@example.test';
  IF v_old IS NULL THEN RAISE EXCEPTION 'TEST FAILED: the reset was not logged'; END IF;
  IF (SELECT status FROM users WHERE id = v_old) <> 'closed'
     OR (SELECT email FROM users WHERE id = v_old) NOT LIKE 'reset+%@invalid'
     OR (SELECT phone FROM users WHERE id = v_old) IS NOT NULL THEN
    RAISE EXCEPTION 'TEST FAILED: the retired account still holds its address or is open';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM sign_in_events WHERE user_id = v_old) THEN
    RAISE EXCEPTION 'TEST FAILED: sign-in history was removed';
  END IF;
  IF (SELECT count(*) FROM devices WHERE user_id = v_old) <> 1
     OR EXISTS (SELECT 1 FROM devices WHERE user_id = v_old AND status <> 'revoked') THEN
    RAISE EXCEPTION 'TEST FAILED: devices were not removed, or the referenced one was not kept revoked';
  END IF;
  IF EXISTS (SELECT 1 FROM auth_sessions WHERE user_id = v_old)
     OR EXISTS (SELECT 1 FROM user_credentials WHERE user_id = v_old)
     OR EXISTS (SELECT 1 FROM kyc_submissions WHERE user_id = v_old) THEN
    RAISE EXCEPTION 'TEST FAILED: sessions, credentials or KYC survived the reset';
  END IF;
  IF (SELECT status FROM virtual_accounts WHERE user_id = v_old) <> 'closed' THEN
    RAISE EXCEPTION 'TEST FAILED: the account number was left live';
  END IF;
  RAISE NOTICE 'PASS 5: the evidence stays, attached to a name nobody can sign in with';
END $$;

-- 6. The log is append-only, and a reset must say why in the audit log.
DO $$
BEGIN
  BEGIN
    DELETE FROM test_account_resets WHERE email = 'p91-tester@example.test';
    RAISE EXCEPTION 'TEST FAILED: a reset record was deleted';
  EXCEPTION WHEN restrict_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO admin_audit_log (actor_id, action, subject_type, subject_id)
    SELECT id, 'test_account.reset', 'user', 'p91' FROM users WHERE email = 'p91-operator@example.test';
    RAISE EXCEPTION 'TEST FAILED: a reset was audited without a reason';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  IF NOT EXISTS (SELECT 1 FROM retention_decisions WHERE table_name = 'test_account_resets') THEN
    RAISE EXCEPTION 'TEST FAILED: test_account_resets has no retention decision';
  END IF;
  RAISE NOTICE 'PASS 6: the record of a reset cannot be pruned';
END $$;

-- 7. Outside a reset, an identity check still cannot be deleted — even by the owner.
DO $$
BEGIN
  DELETE FROM account_identity_checks
   WHERE user_id = (SELECT id FROM users WHERE email = 'p91-tester@example.test');
  RAISE EXCEPTION 'TEST FAILED: an identity check was deleted outside a reset';
EXCEPTION WHEN check_violation THEN
  RAISE NOTICE 'PASS 7: 089''s rule still holds for everybody else';
END $$;
