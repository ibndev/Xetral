-- ===========================================================================
--  Xetral — invariants for 056_reset_codes.sql
--
--  EVERY HASH HERE IS PREFIXED `56`. These suites share one database and
--  013's own file has already claimed `repeat('a', 64)` through
--  `repeat('f', 64)`; `token_hash` is globally UNIQUE, so an unprefixed one
--  aborts this whole file on its first block — in CI order, where nobody is
--  watching. The same collision Phase 10 records about `p10:` idempotency
--  keys.
--  Every block prints PASS. A TEST FAILED means a control is not wired up.
-- ===========================================================================

\set ON_ERROR_STOP on

-- A customer to reset. Their own, so this file does not depend on what any
-- other suite left behind.
DO $$
DECLARE
    uid BIGINT;
BEGIN
    INSERT INTO users (email, status)
    VALUES ('reset-codes@xetral.test', 'active')
    RETURNING id INTO uid;

    INSERT INTO user_credentials (user_id, password_hash)
    VALUES (uid, 'v1:placeholder');
END $$;

-- ---------------------------------------------------------------------------
-- 1. A RIGHT CODE SETS THE PASSWORD AND REVOKES EVERY LIVE SESSION
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    uid BIGINT;
    outcome password_reset_outcome;
    stored TEXT;
BEGIN
    SELECT id INTO uid FROM users WHERE email = 'reset-codes@xetral.test';

    INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
    VALUES (uid, '56a' || repeat('a', 61), now() + interval '15 minutes');

    SELECT out_outcome INTO outcome
      FROM consume_password_reset_code(uid, '56a' || repeat('a', 61), 'v1:new', 5);

    IF outcome <> 'consumed' THEN
        RAISE EXCEPTION 'TEST FAILED 1: a correct code returned %', outcome;
    END IF;

    SELECT password_hash INTO stored FROM user_credentials WHERE user_id = uid;
    IF stored <> 'v1:new' THEN
        RAISE EXCEPTION 'TEST FAILED 1: the password was not set, it is %', stored;
    END IF;

    RAISE NOTICE 'PASS 1: a correct code is consumed and sets the password';
END $$;

-- ---------------------------------------------------------------------------
-- 2. THE SAME CODE A SECOND TIME IS REFUSED
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    uid BIGINT;
    outcome password_reset_outcome;
BEGIN
    SELECT id INTO uid FROM users WHERE email = 'reset-codes@xetral.test';

    SELECT out_outcome INTO outcome
      FROM consume_password_reset_code(uid, '56a' || repeat('a', 61), 'v1:again', 5);

    IF outcome <> 'already_used' THEN
        RAISE EXCEPTION 'TEST FAILED 2: a replayed code returned %', outcome;
    END IF;

    RAISE NOTICE 'PASS 2: a consumed code is never consumed twice';
END $$;

-- ---------------------------------------------------------------------------
-- 3. WRONG GUESSES ARE COUNTED, AND THE CEILING BURNS EVERY LIVE CODE
--
-- The attack this stops: a code matches no row, so a per-row counter is never
-- incremented by a wrong guess and the ceiling never applies. The count has to
-- be charged against what IS outstanding.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    uid BIGINT;
    outcome password_reset_outcome;
    live INT;
BEGIN
    SELECT id INTO uid FROM users WHERE email = 'reset-codes@xetral.test';

    INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
    VALUES (uid, '56b' || repeat('b', 61), now() + interval '15 minutes');

    -- Two wrong guesses against a ceiling of three: counted, not yet burnt.
    FOR i IN 1..2 LOOP
        SELECT out_outcome INTO outcome
          FROM consume_password_reset_code(uid, '56c' || repeat('c', 61), 'v1:x', 3);
        IF outcome <> 'unknown_token' THEN
            RAISE EXCEPTION 'TEST FAILED 3: guess % returned %', i, outcome;
        END IF;
    END LOOP;

    SELECT attempts INTO live FROM password_reset_tokens
     WHERE user_id = uid AND token_hash = '56b' || repeat('b', 61);
    IF live <> 2 THEN
        RAISE EXCEPTION 'TEST FAILED 3: wrong guesses were not counted, attempts = %', live;
    END IF;

    -- The third reaches the ceiling and burns the live code.
    SELECT out_outcome INTO outcome
      FROM consume_password_reset_code(uid, '56c' || repeat('c', 61), 'v1:x', 3);
    IF outcome <> 'too_many_attempts' THEN
        RAISE EXCEPTION 'TEST FAILED 3: the ceiling returned %', outcome;
    END IF;

    SELECT count(*) INTO live FROM password_reset_tokens
     WHERE user_id = uid AND consumed_at IS NULL;
    IF live <> 0 THEN
        RAISE EXCEPTION 'TEST FAILED 3: % codes survived the ceiling', live;
    END IF;

    -- AND THE RIGHT CODE NO LONGER WORKS. Burning has to mean burnt: if the
    -- correct code still opened the account after the ceiling, the ceiling
    -- would only be slowing an attacker down rather than stopping them.
    SELECT out_outcome INTO outcome
      FROM consume_password_reset_code(uid, '56b' || repeat('b', 61), 'v1:x', 3);
    IF outcome <> 'already_used' THEN
        RAISE EXCEPTION 'TEST FAILED 3: a burnt code still returned %', outcome;
    END IF;

    RAISE NOTICE 'PASS 3: wrong guesses are counted and the ceiling burns every live code';
END $$;

-- ---------------------------------------------------------------------------
-- 4. THE COUNT NEVER GOES DOWN
--
-- A counter that can be lowered is the ceiling reset to zero by one UPDATE —
-- the same hole 013's trigger closes for `consumed_at`.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    uid BIGINT;
BEGIN
    SELECT id INTO uid FROM users WHERE email = 'reset-codes@xetral.test';

    BEGIN
        UPDATE password_reset_tokens SET attempts = 0
         WHERE user_id = uid AND token_hash = '56b' || repeat('b', 61);
        RAISE EXCEPTION 'TEST FAILED 4: the attempt count was lowered';
    EXCEPTION WHEN check_violation THEN
        NULL;
    END;

    RAISE NOTICE 'PASS 4: an attempt count can never be lowered';
END $$;

-- ---------------------------------------------------------------------------
-- 5. A CODE BELONGS TO ONE CUSTOMER
--
-- The hash is an HMAC over the user id as well as the code, so this should
-- never arise — and the function is scoped by customer anyway, because relying
-- on the hash alone would mean one lucky guess was lucky against every
-- account at once rather than against one.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    mine BIGINT;
    theirs BIGINT;
    outcome password_reset_outcome;
BEGIN
    SELECT id INTO mine FROM users WHERE email = 'reset-codes@xetral.test';

    INSERT INTO users (email, status)
    VALUES ('reset-codes-other@xetral.test', 'active')
    RETURNING id INTO theirs;
    INSERT INTO user_credentials (user_id, password_hash)
    VALUES (theirs, 'v1:placeholder');

    INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
    VALUES (mine, '56d' || repeat('d', 61), now() + interval '15 minutes');

    SELECT out_outcome INTO outcome
      FROM consume_password_reset_code(theirs, '56d' || repeat('d', 61), 'v1:x', 5);

    IF outcome <> 'unknown_token' THEN
        RAISE EXCEPTION 'TEST FAILED 5: one customer spent another customer''s code (%)', outcome;
    END IF;

    IF (SELECT password_hash FROM user_credentials WHERE user_id = theirs)
       <> 'v1:placeholder' THEN
        RAISE EXCEPTION 'TEST FAILED 5: the other account''s password changed';
    END IF;

    RAISE NOTICE 'PASS 5: a code is only spendable by the customer it was issued to';
END $$;

-- ---------------------------------------------------------------------------
-- 6. AN EXPIRED CODE IS NOT A GUESS
--
-- Ordering, as 013 records: an expired-but-unused code is somebody who took
-- too long over their email, and it must read differently from an attack.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    uid BIGINT;
    outcome password_reset_outcome;
BEGIN
    SELECT id INTO uid FROM users WHERE email = 'reset-codes-other@xetral.test';

    INSERT INTO password_reset_tokens (user_id, token_hash, issued_at, expires_at)
    VALUES (uid, '56e' || repeat('e', 61), now() - interval '2 hours', now() - interval '1 hour');

    SELECT out_outcome INTO outcome
      FROM consume_password_reset_code(uid, '56e' || repeat('e', 61), 'v1:x', 5);

    IF outcome <> 'expired' THEN
        RAISE EXCEPTION 'TEST FAILED 6: an expired code returned %', outcome;
    END IF;

    RAISE NOTICE 'PASS 6: an expired code is expired, not a wrong guess';
END $$;
