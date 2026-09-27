-- ============================================================================
--  084 invariants — an address is proved by a code, and the code is spent once
-- ============================================================================
\set ON_ERROR_STOP on

-- Two live codes for one address; the second is the one the customer holds.
INSERT INTO signup_email_codes (email, code_hash, expires_at)
VALUES ('t084@example.ng', repeat('a', 64), now() + interval '10 minutes'),
       ('t084@example.ng', repeat('b', 64), now() + interval '10 minutes');

-- 1. A wrong guess spends nothing and charges EVERY live code.
DO $$
DECLARE
    v_outcome TEXT;
BEGIN
    v_outcome := consume_signup_email_code('t084@example.ng', repeat('c', 64), 5);
    IF v_outcome <> 'wrong' THEN
        RAISE EXCEPTION 'TEST FAILED: a wrong guess answered %', v_outcome;
    END IF;
    IF EXISTS (SELECT 1 FROM signup_email_codes WHERE email = 't084@example.ng' AND attempts <> 1) THEN
        RAISE EXCEPTION 'TEST FAILED: a wrong guess did not charge every live code';
    END IF;
    RAISE NOTICE 'PASS: a wrong guess charges every live code for the address';
END $$;

-- 2a. CHECKING the right code spends nothing.
DO $$
BEGIN
    IF consume_signup_email_code('t084@example.ng', repeat('b', 64), 5, FALSE) <> 'matched' THEN
        RAISE EXCEPTION 'TEST FAILED: checking the right code did not answer matched';
    END IF;
    IF EXISTS (SELECT 1 FROM signup_email_codes WHERE email = 't084@example.ng' AND consumed_at IS NOT NULL) THEN
        RAISE EXCEPTION 'TEST FAILED: checking a code spent it';
    END IF;
    RAISE NOTICE 'PASS: a check spends nothing';
END $$;

-- 2. The right code is consumed once, and a second use finds nothing to spend.
DO $$
DECLARE
    v_first  TEXT;
    v_second TEXT;
BEGIN
    v_first := consume_signup_email_code('t084@example.ng', repeat('b', 64), 5);
    v_second := consume_signup_email_code('t084@example.ng', repeat('b', 64), 5);
    IF v_first <> 'consumed' OR v_second <> 'wrong' THEN
        RAISE EXCEPTION 'TEST FAILED: consumed as % then %', v_first, v_second;
    END IF;
    RAISE NOTICE 'PASS: a code is spent exactly once';
END $$;

-- 3. The ceiling refuses even the RIGHT code once reached.
INSERT INTO signup_email_codes (email, code_hash, expires_at)
VALUES ('t084b@example.ng', repeat('d', 64), now() + interval '10 minutes');
DO $$
DECLARE
    v_outcome TEXT;
BEGIN
    FOR i IN 1..3 LOOP
        PERFORM consume_signup_email_code('t084b@example.ng', repeat('e', 64), 3);
    END LOOP;
    v_outcome := consume_signup_email_code('t084b@example.ng', repeat('d', 64), 3);
    IF v_outcome <> 'too_many_attempts' THEN
        RAISE EXCEPTION 'TEST FAILED: the right code after the ceiling answered %', v_outcome;
    END IF;
    RAISE NOTICE 'PASS: the attempt ceiling holds against the right code';
END $$;

-- 4. An address with no live code has nothing to guess at.
DO $$
BEGIN
    IF consume_signup_email_code('nobody084@example.ng', repeat('a', 64), 5) <> 'none' THEN
        RAISE EXCEPTION 'TEST FAILED: an address with no code did not answer none';
    END IF;
    RAISE NOTICE 'PASS: no live code answers none';
END $$;

-- 5. A spent code cannot be un-spent, and attempts cannot be lowered.
DO $$
BEGIN
    BEGIN
        UPDATE signup_email_codes SET consumed_at = NULL
         WHERE email = 't084@example.ng' AND consumed_at IS NOT NULL;
        RAISE EXCEPTION 'TEST FAILED: a spent code was un-spent';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
    BEGIN
        UPDATE signup_email_codes SET attempts = 0 WHERE email = 't084b@example.ng';
        RAISE EXCEPTION 'TEST FAILED: attempts were lowered';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
    RAISE NOTICE 'PASS: spending and the ceiling are one-way';
END $$;

-- 6. The address is stored lower-cased, by CHECK.
DO $$
BEGIN
    BEGIN
        INSERT INTO signup_email_codes (email, code_hash, expires_at)
        VALUES ('Mixed@Example.ng', repeat('a', 64), now() + interval '1 minute');
        RAISE EXCEPTION 'TEST FAILED: a mixed-case address was stored';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
    RAISE NOTICE 'PASS: addresses are stored lower-cased';
END $$;

-- 7. The table has a retention decision, and the switch ships ON.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM retention_decisions WHERE table_name = 'signup_email_codes') THEN
        RAISE EXCEPTION 'TEST FAILED: signup_email_codes has no retention decision';
    END IF;
    IF (SELECT value FROM platform_settings WHERE key = 'signup_email_verification') <> 'true' THEN
        RAISE EXCEPTION 'TEST FAILED: signup email verification does not ship on';
    END IF;
    RAISE NOTICE 'PASS: retained deliberately, and on by default';
END $$;
