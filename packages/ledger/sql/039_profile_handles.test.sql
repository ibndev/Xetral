-- ============================================================================
--  039 — Tests: a handle is claimed once and never reissued.
--
--  The property that protects money is not "handles are unique" — a plain
--  unique index gives that. It is that a RELEASED handle stays taken, because
--  a payment link posted in a message thread last month must not start paying
--  somebody else this month.
-- ============================================================================

\set ON_ERROR_STOP on

-- ---------------------------------------------------------------------------
-- 1. The shape is enforced, and the cases that matter are the confusable ones.
-- ---------------------------------------------------------------------------
DO $$
DECLARE uid BIGINT;
BEGIN
    INSERT INTO users (email, status) VALUES ('h039-shape@example.ng', 'active')
    RETURNING id INTO uid;

    BEGIN
        UPDATE users SET handle = 'Olawale' WHERE id = uid;
        RAISE EXCEPTION 'TEST FAILED 1a: an uppercase handle was accepted, so @Olawale '
                        'and @olawale would be two different people';
    EXCEPTION WHEN check_violation THEN NULL;
    END;

    BEGIN
        UPDATE users SET handle = '_olawale' WHERE id = uid;
        RAISE EXCEPTION 'TEST FAILED 1b: a leading underscore was accepted, which reads '
                        'as the same handle at a glance';
    EXCEPTION WHEN check_violation THEN NULL;
    END;

    BEGIN
        UPDATE users SET handle = 'ab' WHERE id = uid;
        RAISE EXCEPTION 'TEST FAILED 1c: a two-character handle was accepted';
    EXCEPTION WHEN check_violation THEN NULL;
    END;

    UPDATE users SET handle = 'olawale' WHERE id = uid;
    RAISE NOTICE 'PASS 1: the handle shape refuses the confusable cases';
END $$;

-- ---------------------------------------------------------------------------
-- 2. Claiming records history, by TRIGGER — so a psql prompt cannot skip it.
-- ---------------------------------------------------------------------------
DO $$
DECLARE recorded BOOLEAN;
BEGIN
    SELECT EXISTS (
        SELECT 1 FROM handle_history h
          JOIN users u ON u.id = h.user_id
         WHERE h.handle = 'olawale' AND u.email = 'h039-shape@example.ng'
    ) INTO recorded;
    IF NOT recorded THEN
        RAISE EXCEPTION 'TEST FAILED 2: a handle was claimed and never recorded';
    END IF;
    RAISE NOTICE 'PASS 2: claiming a handle records it';
END $$;

-- ---------------------------------------------------------------------------
-- 3. THE ONE THAT MATTERS: a released handle cannot be taken by anybody else.
--
-- Without this, changing your handle frees it, a stranger claims it, and every
-- payment link you have ever shared now pays them.
-- ---------------------------------------------------------------------------
DO $$
DECLARE other BIGINT; first BIGINT;
BEGIN
    SELECT id INTO first FROM users WHERE email = 'h039-shape@example.ng';
    INSERT INTO users (email, status) VALUES ('h039-thief@example.ng', 'active')
    RETURNING id INTO other;

    -- The original owner moves on, which RELEASES 'olawale'.
    UPDATE users SET handle = 'olawale_ng' WHERE id = first;

    BEGIN
        UPDATE users SET handle = 'olawale' WHERE id = other;
        RAISE EXCEPTION 'TEST FAILED 3: a released handle was reissued, so an old payment '
                        'link now pays a different person';
    EXCEPTION WHEN unique_violation THEN NULL;
    END;

    -- And the original owner may take their own back, because the history row
    -- is theirs. Losing your own handle by renaming twice would be its own bug.
    UPDATE users SET handle = 'olawale' WHERE id = first;
    RAISE NOTICE 'PASS 3: a released handle stays taken, and its owner may reclaim it';
END $$;

-- ---------------------------------------------------------------------------
-- 4. The payable view carries a name and NOT an email.
--
-- A link resolver has to show who is about to be paid. If it could also show
-- the address behind the handle, every published payment link would be an
-- email harvester.
-- ---------------------------------------------------------------------------
DO $$
DECLARE cols TEXT;
BEGIN
    SELECT string_agg(column_name, ',' ORDER BY column_name) INTO cols
      FROM information_schema.columns WHERE table_name = 'payable_handles';

    IF cols LIKE '%email%' OR cols LIKE '%phone%' THEN
        RAISE EXCEPTION 'TEST FAILED 4a: payable_handles exposes a contact detail: %', cols;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM payable_handles WHERE handle = 'olawale') THEN
        RAISE EXCEPTION 'TEST FAILED 4b: an active customer with a handle is not payable';
    END IF;
    RAISE NOTICE 'PASS 4: the payable view resolves a handle and leaks no contact detail';
END $$;

-- ---------------------------------------------------------------------------
-- 5. A closed account is not payable. Money sent to one is money stranded.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
    UPDATE users SET status = 'closed' WHERE email = 'h039-shape@example.ng';
    IF EXISTS (SELECT 1 FROM payable_handles WHERE handle = 'olawale') THEN
        RAISE EXCEPTION 'TEST FAILED 5: a closed account is still payable by link';
    END IF;
    UPDATE users SET status = 'active' WHERE email = 'h039-shape@example.ng';
    RAISE NOTICE 'PASS 5: a closed account drops out of the payable view';
END $$;
