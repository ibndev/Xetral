\echo '=== 050: the country a customer chose, made structural ==='

\echo '=== 1. The dialling code in a number is read back out as the country ==='
-- The MECHANISM, not the state of the table. Asserting "no account has a
-- null country" would be vacuous here — the migration runs against an empty
-- database in this suite, and every user the other test files create is
-- fixture data that names no country. What matters is that the function does
-- what the migration ran it for, so it is called again on a row planted for
-- the purpose.
DO $$
DECLARE v_country CHAR(2);
BEGIN
    INSERT INTO users (email, status, phone)
    VALUES ('p50-gh@example.ng', 'active', '+233201234567');
    INSERT INTO users (email, status, phone)
    VALUES ('p50-ke@example.ng', 'active', '+254712345678');
    -- No phone at all, so nothing to read: this is the row the second half of
    -- the function is about.
    INSERT INTO users (email, status) VALUES ('p50-none@example.ng', 'active');

    PERFORM backfill_country_from_phone();

    SELECT country INTO v_country FROM users WHERE email = 'p50-gh@example.ng';
    IF v_country <> 'GH' THEN
        RAISE EXCEPTION 'TEST FAILED: +233 resolved to % rather than Ghana', v_country;
    END IF;

    SELECT country INTO v_country FROM users WHERE email = 'p50-ke@example.ng';
    IF v_country <> 'KE' THEN
        RAISE EXCEPTION 'TEST FAILED: +254 resolved to % rather than Kenya', v_country;
    END IF;

    -- A row with nothing to read is Nigerian, and that is a claim about
    -- history: registration has supplied a country since 040, so a null
    -- belongs to a row written when this platform was Nigeria-only.
    SELECT country INTO v_country FROM users WHERE email = 'p50-none@example.ng';
    IF v_country <> 'NG' THEN
        RAISE EXCEPTION 'TEST FAILED: an unreadable row became % rather than NG', v_country;
    END IF;

    RAISE NOTICE 'PASS: a country is read back out of the number, or assumed and said so';
END $$;

\echo '=== 2. A gap is VISIBLE rather than impossible ==='
-- The column stays nullable deliberately — see the migration header — so what
-- makes this safe is that a missing country is reported rather than silently
-- guessed about by five separate surfaces. A view nobody looks at would be no
-- better than the nulls, which is why 036 also has to classify it.
DO $$
DECLARE v_seen BIGINT;
        v_would BOOLEAN;
BEGIN
    INSERT INTO users (email, status, phone) VALUES ('p50-gap@example.ng', 'active', '+2348095000009');

    SELECT count(*) INTO v_seen FROM users_without_a_country
     WHERE email = 'p50-gap@example.ng';
    IF v_seen <> 1 THEN
        RAISE EXCEPTION 'TEST FAILED: an account with no country is invisible';
    END IF;

    -- And it says whether the phone could have answered, which is what tells
    -- an operator this row was written after 050 rather than before it.
    SELECT phone_would_say INTO v_would FROM users_without_a_country
     WHERE email = 'p50-gap@example.ng';
    IF NOT v_would THEN
        RAISE EXCEPTION 'TEST FAILED: a resolvable number is not reported as one';
    END IF;

    RAISE NOTICE 'PASS: a missing country is reported, with whether the number says it';
    DELETE FROM users WHERE email = 'p50-gap@example.ng';
END $$;

\echo '=== 3. The longest dialling code wins ==='
-- '1' is the United States and '1876' is Jamaica. Matching the shorter prefix
-- first would make every Jamaican number American, and the failure is silent:
-- the account works, in the wrong country, with the wrong currency.
--
-- The overlapping pair is CREATED HERE rather than waited for. 040's seed has
-- no two codes where one starts with the other, so a test that only asserted
-- against what is seeded would pass on a table that cannot exhibit the bug —
-- and would go on passing on the day somebody adds Jamaica. Disabled, so the
-- coverage trigger has nothing to say about a currency nobody holds.
DO $$
DECLARE v_code TEXT;
BEGIN
    INSERT INTO countries (code, name, dial_code, currency, enabled)
    VALUES ('JM', 'Jamaica', '1876', 'USD', FALSE)
    ON CONFLICT (code) DO NOTHING;

    SELECT c.code INTO v_code
      FROM countries c
     WHERE '18765550000' LIKE c.dial_code || '%'
     ORDER BY length(c.dial_code) DESC
     LIMIT 1;

    IF v_code IS DISTINCT FROM 'JM' THEN
        RAISE EXCEPTION 'TEST FAILED: +1876 resolved to % rather than Jamaica', v_code;
    END IF;

    -- And the shorter code still wins for a number that is only its own.
    SELECT c.code INTO v_code
      FROM countries c
     WHERE '12125550000' LIKE c.dial_code || '%'
     ORDER BY length(c.dial_code) DESC
     LIMIT 1;

    IF v_code IS DISTINCT FROM 'US' THEN
        RAISE EXCEPTION 'TEST FAILED: +1212 resolved to % rather than the US', v_code;
    END IF;

    RAISE NOTICE 'PASS: a longer dialling code beats the shorter one it starts with';
END $$;

\echo '=== 4. A country a customer CHOSE is not overruled by their number ==='
-- Somebody may hold a foreign number and live where they say they do. The
-- picker is the statement they made; the phone is only consulted when there
-- is no statement at all.
DO $$
DECLARE v_country CHAR(2);
BEGIN
    INSERT INTO users (email, status, country, phone)
    VALUES ('p50-chosen@example.ng', 'active', 'GH', '+2348095000002');

    SELECT country INTO v_country FROM users WHERE email = 'p50-chosen@example.ng';
    IF v_country <> 'GH' THEN
        RAISE EXCEPTION 'TEST FAILED: a chosen country was overwritten with %', v_country;
    END IF;
    RAISE NOTICE 'PASS: what the customer selected stands';
END $$;

\echo '=== 5. Every country a user names has a currency to lead with ==='
-- The column is not a foreign key — countries are data and currencies are
-- not, which is 040's whole design — so this is the check that would catch a
-- country deleted out from under an account. A user pointing at no country
-- row falls back to naira on every screen, silently.
DO $$
DECLARE v_orphans BIGINT;
BEGIN
    SELECT count(*) INTO v_orphans
      FROM users u LEFT JOIN countries c ON c.code = u.country
     WHERE c.code IS NULL;
    IF v_orphans > 0 THEN
        RAISE EXCEPTION 'TEST FAILED: % users name a country that does not exist', v_orphans;
    END IF;
    RAISE NOTICE 'PASS: every account names a country the platform knows';
END $$;
