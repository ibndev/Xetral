-- ============================================================================
--  092 invariants — a reset test account keeps no name, and the log says
--  whose it was
-- ============================================================================
\set ON_ERROR_STOP on

-- 0. Fixtures: an operator and a named test account.
DO $$
BEGIN
  INSERT INTO users (email, phone, full_name, status) VALUES
    ('p92-operator@example.test', '+2348000009201', 'Ope Rator', 'active'),
    ('p92-tester@example.test',   '+2348000009202', 'Bola Adeyemi', 'active');
  RAISE NOTICE 'PASS 0: fixtures';
END $$;

-- 1. The reset clears the name, says so, and the log keeps it.
DO $$
DECLARE v_id BIGINT; v_removed TEXT;
BEGIN
  SELECT id INTO v_id FROM users WHERE email = 'p92-tester@example.test';
  SET LOCAL ROLE xetral_app;
  SELECT reset_test_account(v_id, (SELECT id FROM users WHERE email = 'p92-operator@example.test'))
    INTO v_removed;
  RESET ROLE;
  IF (SELECT full_name FROM users WHERE id = v_id) IS NOT NULL THEN
    RAISE EXCEPTION 'TEST FAILED: the retired account still carries its name';
  END IF;
  IF v_removed NOT LIKE '%name%' THEN
    RAISE EXCEPTION 'TEST FAILED: the reset did not say it removed the name: %', v_removed;
  END IF;
  IF (SELECT full_name FROM test_account_resets WHERE user_id = v_id) IS DISTINCT FROM 'Bola Adeyemi' THEN
    RAISE EXCEPTION 'TEST FAILED: the reset log does not say whose name it was';
  END IF;
  RAISE NOTICE 'PASS 1: the name is released and recorded';
END $$;

-- 2. A name is not a key: the same person registers again under it.
DO $$
BEGIN
  INSERT INTO users (email, phone, full_name, status)
  VALUES ('p92-tester@example.test', '+2348000009202', 'Bola Adeyemi', 'active');
  RAISE NOTICE 'PASS 2: the same email, phone and name register again';
END $$;
