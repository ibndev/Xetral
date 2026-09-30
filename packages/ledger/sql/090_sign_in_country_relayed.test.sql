-- ============================================================================
--  090 invariants — only a relayed country is where a customer has been
-- ============================================================================
\set ON_ERROR_STOP on

DO $$
BEGIN
  INSERT INTO users (email, status) VALUES
    ('p90-legacy@example.test', 'active'),
    ('p90-new@example.test', 'active');
  RAISE NOTICE 'PASS 0: fixtures';
END $$;

-- 1. A history written before 090 — the web server's DE — is not a baseline:
--    the first relayed country is not announced as a move.
DO $$
DECLARE v_user BIGINT; v_seen BOOLEAN;
BEGIN
  SELECT id INTO v_user FROM users WHERE email = 'p90-legacy@example.test';
  INSERT INTO sign_in_events (user_id, identifier_hash, country, outcome)
  VALUES (v_user, repeat('a', 64), 'DE', 'succeeded');

  SELECT country_seen_before INTO v_seen FROM sign_in_is_familiar(v_user, NULL, 'NG');
  IF NOT v_seen THEN
    RAISE EXCEPTION 'TEST FAILED: an unrelayed DE history made NG read as a new country';
  END IF;
  RAISE NOTICE 'PASS 1: countries written before the relay are not where anybody has been';
END $$;

-- 2. Once a relayed country exists, a different one is new and the same one is not.
DO $$
DECLARE v_user BIGINT;
BEGIN
  SELECT id INTO v_user FROM users WHERE email = 'p90-legacy@example.test';
  INSERT INTO sign_in_events (user_id, identifier_hash, country, country_relayed, outcome)
  VALUES (v_user, repeat('a', 64), 'NG', TRUE, 'succeeded');

  IF NOT (SELECT country_seen_before FROM sign_in_is_familiar(v_user, NULL, 'NG')) THEN
    RAISE EXCEPTION 'TEST FAILED: the relayed home country read as new';
  END IF;
  IF (SELECT country_seen_before FROM sign_in_is_familiar(v_user, NULL, 'RU')) THEN
    RAISE EXCEPTION 'TEST FAILED: a country never relayed read as familiar';
  END IF;
  IF (SELECT country_seen_before FROM sign_in_is_familiar(v_user, NULL, 'DE')) THEN
    RAISE EXCEPTION 'TEST FAILED: an unrelayed DE row made DE familiar';
  END IF;
  RAISE NOTICE 'PASS 2: a relayed history is compared against';
END $$;

-- 3. A new account's first placed sign-in is its baseline, not an alert.
DO $$
DECLARE v_user BIGINT;
BEGIN
  SELECT id INTO v_user FROM users WHERE email = 'p90-new@example.test';
  IF NOT (SELECT country_seen_before FROM sign_in_is_familiar(v_user, NULL, 'GH')) THEN
    RAISE EXCEPTION 'TEST FAILED: an account with no history was alerted about its first country';
  END IF;
  RAISE NOTICE 'PASS 3: the first placed sign-in establishes home';
END $$;

-- 4. A relay is a country: a relayed row with none is refused.
DO $$
DECLARE v_user BIGINT;
BEGIN
  SELECT id INTO v_user FROM users WHERE email = 'p90-new@example.test';
  INSERT INTO sign_in_events (user_id, identifier_hash, country, country_relayed, outcome)
  VALUES (v_user, repeat('b', 64), NULL, TRUE, 'succeeded');
  RAISE EXCEPTION 'TEST FAILED: a relayed sign-in with no country was written';
EXCEPTION WHEN check_violation THEN
  RAISE NOTICE 'PASS 4: a relayed row carries its country';
END $$;

-- 5. Still append-only: 090 did not open an UPDATE path onto the flag.
DO $$
BEGIN
  UPDATE sign_in_events SET country_relayed = TRUE
   WHERE user_id = (SELECT id FROM users WHERE email = 'p90-legacy@example.test')
     AND country = 'DE';
  RAISE EXCEPTION 'TEST FAILED: a written row was re-marked as relayed';
EXCEPTION WHEN OTHERS THEN
  IF SQLERRM LIKE 'TEST FAILED%' THEN RAISE; END IF;
  RAISE NOTICE 'PASS 5: history is not rewritten to look relayed';
END $$;
