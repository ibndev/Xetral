-- ============================================================================
--  082 invariants — refusals counted once each; approval details reach the account
-- ============================================================================
\set ON_ERROR_STOP on

-- 1. The same refusal twice is one row counted twice, not two rows.
DO $$
DECLARE
    v_rows  INT;
    v_count BIGINT;
BEGIN
    PERFORM record_account_refusal('paystack', 'NGN', 'p82', 'test:082 customer validation required');
    PERFORM record_account_refusal('paystack', 'NGN', 'p82', 'test:082 customer validation required');

    SELECT count(*), max(occurrences) INTO v_rows, v_count
      FROM account_refusals WHERE reason = 'test:082 customer validation required';
    IF v_rows <> 1 OR v_count <> 2 THEN
        RAISE EXCEPTION 'TEST FAILED: expected one row counted twice, got % row(s), count %', v_rows, v_count;
    END IF;
    RAISE NOTICE 'PASS: a repeated refusal is counted, not duplicated';
END $$;

-- 2. A different rail, currency or code is a different refusal — including a
--    NULL code beside a present one, which a plain unique constraint would
--    not tell apart.
DO $$
DECLARE
    v_rows INT;
BEGIN
    PERFORM record_account_refusal('flutterwave', 'NGN', 'p82', 'test:082 customer validation required');
    PERFORM record_account_refusal('paystack', 'NGN', NULL, 'test:082 customer validation required');
    PERFORM record_account_refusal('paystack', 'NGN', NULL, 'test:082 customer validation required');

    SELECT count(*) INTO v_rows
      FROM account_refusals WHERE reason = 'test:082 customer validation required';
    IF v_rows <> 3 THEN
        RAISE EXCEPTION 'TEST FAILED: expected three distinct refusals, got %', v_rows;
    END IF;
    RAISE NOTICE 'PASS: rail, currency and code each make a refusal distinct';
END $$;

-- 3. The table names no customer — the property that lets it be kept.
DO $$
DECLARE
    v_bad TEXT;
BEGIN
    SELECT string_agg(column_name, ', ') INTO v_bad
      FROM information_schema.columns
     WHERE table_name = 'account_refusals'
       AND column_name ~ '(user|customer|email|phone|name|bvn)';
    IF v_bad IS NOT NULL THEN
        RAISE EXCEPTION 'TEST FAILED: account_refusals has a column that could hold a person: %', v_bad;
    END IF;
    RAISE NOTICE 'PASS: account_refusals holds nothing about a person';
END $$;

-- 4. A reason longer than the cap is cut, never refused: recording must not
--    fail because a rail answered with a page of HTML.
DO $$
DECLARE
    v_len INT;
BEGIN
    PERFORM record_account_refusal('paystack', 'NGN', 'p82-long', repeat('x', 5000));
    SELECT length(reason) INTO v_len FROM account_refusals WHERE provider_code = 'p82-long';
    IF v_len <> 1000 THEN
        RAISE EXCEPTION 'TEST FAILED: a long reason was stored at % characters', v_len;
    END IF;
    RAISE NOTICE 'PASS: a long reason is capped rather than refused';
END $$;

-- 5. It has a retention decision.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM retention_decisions WHERE table_name = 'account_refusals') THEN
        RAISE EXCEPTION 'TEST FAILED: account_refusals has no retention decision';
    END IF;
    RAISE NOTICE 'PASS: account_refusals has a retention decision';
END $$;

-- 6. An approval made AFTER 067 still reaches the account: a blank name and a
--    blank number are filled from the approved submission, and a value the
--    customer set is never overwritten.
DO $$
DECLARE
    v_user  BIGINT;
    v_other BIGINT;
    v_phone TEXT;
    v_name  TEXT;
BEGIN
    INSERT INTO users (email, status, country)
    VALUES ('p82-late@example.ng', 'active', 'NG') RETURNING id INTO v_user;
    INSERT INTO users (email, status, country, full_name)
    VALUES ('p82-named@example.ng', 'active', 'NG', 'Chosen Name') RETURNING id INTO v_other;

    INSERT INTO kyc_submissions (user_id, full_name, date_of_birth, phone, bvn_sealed,
                                 bvn_last4, bvn_fingerprint, address, status,
                                 reviewed_by, reviewed_at)
    VALUES (v_user, 'Ada Late', DATE '1990-01-01', '08038200082', 'v1:p82a', '0082',
            'v1:' || repeat('8', 63) || '1', '1 Test Street', 'approved', v_other, now()),
           (v_other, 'Other Late', DATE '1990-01-01', '08038200083', 'v1:p82b', '0083',
            'v1:' || repeat('8', 63) || '2', '1 Test Street', 'approved', v_user, now());

    PERFORM fill_details_from_kyc(v_user);
    PERFORM fill_details_from_kyc(v_other);

    SELECT phone, full_name INTO v_phone, v_name FROM users WHERE id = v_user;
    IF v_phone IS DISTINCT FROM '+2348038200082' OR v_name IS DISTINCT FROM 'Ada Late' THEN
        RAISE EXCEPTION 'TEST FAILED: approval details did not reach the account (% / %)', v_phone, v_name;
    END IF;

    SELECT full_name INTO v_name FROM users WHERE id = v_other;
    IF v_name IS DISTINCT FROM 'Chosen Name' THEN
        RAISE EXCEPTION 'TEST FAILED: a name the customer chose was overwritten with %', v_name;
    END IF;
    RAISE NOTICE 'PASS: a later approval fills blanks and overwrites nothing';
END $$;
