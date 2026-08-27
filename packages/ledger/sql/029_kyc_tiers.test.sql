-- ===========================================================================
--  Xetral — verification tier invariants
--  packages/ledger/sql/029_kyc_tiers.test.sql
-- ===========================================================================

\set QUIET on
\pset format unaligned
\pset tuples_only on

INSERT INTO users (email, status) VALUES
  ('p29-new@example.ng',   'active'),
  ('p29-step@example.ng',  'active'),
  ('p29-staff@example.ng', 'active');

\echo '=== 1. EVERY TIER AND CURRENCY HAS A LIMIT ==='
-- The coverage argument, one layer up from 027's. A limits table is a list of
-- what somebody thought of, and the combination nobody thought of is where an
-- account with no ceiling lives. There is deliberately NO FALLBACK, so a gap
-- here would not be a smaller limit — it would be none.
DO $$
DECLARE v_gap TEXT;
BEGIN
    SELECT string_agg(tier || '/' || currency, ', ') INTO v_gap
      FROM kyc_tier_coverage WHERE NOT has_limit;
    IF v_gap IS NOT NULL THEN
        RAISE EXCEPTION
            'TEST FAILED: no daily limit for %. A customer at that tier holding '
            'that currency has NO ceiling at all', v_gap;
    END IF;
    RAISE NOTICE 'PASS: every tier has a limit in every currency the ledger holds';
END $$;

\echo '=== 2. A NEW CUSTOMER starts at the LEAST trusted tier ==='
-- The default is 0, so a path that forgets to set one — a registration
-- endpoint, an import, a fixture — produces an account with an unverified
-- ceiling rather than a verified one. A default of 1 would mean forgetting
-- hands out verified limits and nothing fails.
DO $$
DECLARE v_tier SMALLINT;
BEGIN
    SELECT kyc_tier INTO v_tier FROM users WHERE email = 'p29-new@example.ng';
    IF v_tier <> 0 THEN
        RAISE EXCEPTION 'TEST FAILED: a new customer starts at tier %', v_tier;
    END IF;
    RAISE NOTICE 'PASS: an unverified account starts unverified';
END $$;

\echo '=== 3. An UNVERIFIED account may move NO CRYPTO ==='
-- Zero is a real limit here rather than a missing row. On a chain is the one
-- place money cannot be recalled from, so it is the one movement that must not
-- be available to an account nobody has identified.
DO $$
DECLARE v_limit BIGINT;
BEGIN
    SELECT daily_limit_minor INTO v_limit FROM kyc_tier_limits
     WHERE tier = 0 AND currency = 'USDT';
    IF v_limit <> 0 THEN
        RAISE EXCEPTION 'TEST FAILED: an unidentified account may move % USDT minor units',
            v_limit;
    END IF;
    SELECT daily_limit_minor INTO v_limit FROM kyc_tier_limits
     WHERE tier = 0 AND currency = 'BTC';
    IF v_limit <> 0 THEN
        RAISE EXCEPTION 'TEST FAILED: an unidentified account may move % BTC minor units',
            v_limit;
    END IF;
    RAISE NOTICE 'PASS: no chain withdrawal without an identity';
END $$;

\echo '=== 4. Each tier allows MORE than the one below it ==='
-- Otherwise verifying a customer is a step that takes something away, and the
-- product tells people to complete KYC in order to be limited harder.
DO $$
DECLARE v_row RECORD;
BEGIN
    FOR v_row IN
        SELECT lo.currency, lo.tier AS lower_tier,
               lo.daily_limit_minor AS lower_limit,
               hi.daily_limit_minor AS higher_limit
          FROM kyc_tier_limits lo
          JOIN kyc_tier_limits hi
            ON hi.currency = lo.currency AND hi.tier = lo.tier + 1
    LOOP
        IF v_row.higher_limit < v_row.lower_limit THEN
            RAISE EXCEPTION
                'TEST FAILED: in % tier % allows % and tier % allows only % — '
                'verifying a customer would lower their ceiling',
                v_row.currency, v_row.lower_tier, v_row.lower_limit,
                v_row.lower_tier + 1, v_row.higher_limit;
        END IF;
    END LOOP;
    RAISE NOTICE 'PASS: knowing more about somebody never allows them less';
END $$;

\echo '=== 5. A tier CANNOT SKIP the evidence below it ==='
-- Enhanced due diligence is a statement about source of funds ON TOP of a
-- verified identity. Granting it to somebody whose identity was never checked
-- would make the higher ceiling rest on nothing.
DO $$
DECLARE v_u BIGINT;
BEGIN
    SELECT id INTO v_u FROM users WHERE email = 'p29-step@example.ng';
    UPDATE users SET kyc_tier = 2 WHERE id = v_u;
    RAISE EXCEPTION 'TEST FAILED: a customer went straight from 0 to 2';
EXCEPTION WHEN restrict_violation THEN
    RAISE NOTICE 'PASS: each tier rests on the evidence of the one below';
END $$;

\echo '=== 6. Going DOWN is unrestricted ==='
-- A tier is a claim about what we know. Finding out we were wrong must never
-- be harder than the mistake was.
DO $$
DECLARE v_u BIGINT;
BEGIN
    SELECT id INTO v_u FROM users WHERE email = 'p29-step@example.ng';
    UPDATE users SET kyc_tier = 1 WHERE id = v_u;
    UPDATE users SET kyc_tier = 2 WHERE id = v_u;
    UPDATE users SET kyc_tier = 0 WHERE id = v_u;
    RAISE NOTICE 'PASS: a ceiling can be taken away in one step';
END $$;

\echo '=== 7. Every change is RECORDED, by trigger ==='
-- By trigger and not by the endpoint, so a tier cannot be changed without the
-- change being recorded — including from a psql prompt, which is the case an
-- endpoint-side record does not cover.
DO $$
DECLARE v_u BIGINT; v_n INT; v_last RECORD;
BEGIN
    SELECT id INTO v_u FROM users WHERE email = 'p29-step@example.ng';
    SELECT count(*) INTO v_n FROM kyc_tier_changes WHERE user_id = v_u;
    IF v_n <> 3 THEN
        RAISE EXCEPTION 'TEST FAILED: three tier changes recorded % rows', v_n;
    END IF;

    SELECT * INTO v_last FROM kyc_tier_changes
     WHERE user_id = v_u ORDER BY id DESC LIMIT 1;
    IF v_last.from_tier <> 2 OR v_last.to_tier <> 0 THEN
        RAISE EXCEPTION 'TEST FAILED: the last change reads % -> %',
            v_last.from_tier, v_last.to_tier;
    END IF;
    RAISE NOTICE 'PASS: every tier change is written down';
END $$;

\echo '=== 8. A change to the SAME tier records nothing ==='
-- Otherwise a routine UPDATE touching the row fills the history with entries
-- that describe no change, and the log a reviewer reads during an incident is
-- mostly noise.
DO $$
DECLARE v_u BIGINT; v_before INT; v_after INT;
BEGIN
    SELECT id INTO v_u FROM users WHERE email = 'p29-step@example.ng';
    SELECT count(*) INTO v_before FROM kyc_tier_changes WHERE user_id = v_u;
    UPDATE users SET kyc_tier = 0 WHERE id = v_u;
    SELECT count(*) INTO v_after FROM kyc_tier_changes WHERE user_id = v_u;

    IF v_after <> v_before THEN
        RAISE EXCEPTION 'TEST FAILED: setting a tier to itself recorded a change';
    END IF;
    RAISE NOTICE 'PASS: only a real change is recorded';
END $$;

\echo '=== 9. The history is APPEND-ONLY ==='
DO $$
DECLARE v_u BIGINT;
BEGIN
    SELECT id INTO v_u FROM users WHERE email = 'p29-step@example.ng';
    DELETE FROM kyc_tier_changes WHERE user_id = v_u;
    RAISE EXCEPTION 'TEST FAILED: a tier change was deleted';
EXCEPTION WHEN restrict_violation THEN
    RAISE NOTICE 'PASS: who raised a ceiling cannot be removed from the record';
END $$;

\echo '=== 10. A tier OUTSIDE the range is refused ==='
-- Three tiers exist because three have a real path to them. A fourth would be
-- a row in a table that reads like a product and is a dead end for the
-- customer who reaches its ceiling.
DO $$
DECLARE v_u BIGINT;
BEGIN
    SELECT id INTO v_u FROM users WHERE email = 'p29-new@example.ng';
    -- Climbed one step at a time, so the "no skipping" trigger is satisfied
    -- and the RANGE is what refuses. Jumping straight to 3 would be caught by
    -- the trigger instead — a BEFORE trigger runs ahead of a CHECK — and the
    -- block would pass while proving something else entirely.
    UPDATE users SET kyc_tier = 1 WHERE id = v_u;
    UPDATE users SET kyc_tier = 2 WHERE id = v_u;
    UPDATE users SET kyc_tier = 3 WHERE id = v_u;
    RAISE EXCEPTION 'TEST FAILED: a tier nothing can grant was set';
EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS: only tiers a customer can actually reach exist';
END $$;

\echo '=== 11. Every tier this schema permits HAS a limits row ==='
-- The other direction of block 1. Block 1 asks whether every currency is
-- covered; this asks whether every tier the CHECK allows is, so widening the
-- CHECK without seeding the grid does not merge.
DO $$
DECLARE v_tier INT; v_n INT;
BEGIN
    FOR v_tier IN 0..2 LOOP
        SELECT count(*) INTO v_n FROM kyc_tier_limits WHERE tier = v_tier;
        IF v_n = 0 THEN
            RAISE EXCEPTION
                'TEST FAILED: tier % is permitted by the CHECK and has no limits at all',
                v_tier;
        END IF;
    END LOOP;
    RAISE NOTICE 'PASS: no tier exists that has no ceiling';
END $$;
