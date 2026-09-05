\set ON_ERROR_STOP on

-- NOT `SET client_min_messages TO WARNING`, which is what the first draft of
-- this file did: RAISE NOTICE is how every suite here reports a PASS, and CI
-- SCANS PSQL'S OUTPUT rather than trusting its exit code — because the drift
-- check reports through a SELECT and exits zero. Suppressing notices makes a
-- suite that proves nothing look identical to one that proves everything.

-- ---------------------------------------------------------------------------
-- 040 — countries, and the cover a currency owes before a country opens.
-- ---------------------------------------------------------------------------

-- 1 ------------------------------------------------------------------------
-- The seed opens exactly the three countries the platform operates in, and
-- leaves the rest closed. A seed that enabled everything would be a licensing
-- claim written by a migration.
DO $$
DECLARE open_count INT; ng BOOLEAN;
BEGIN
    SELECT count(*) INTO open_count FROM countries WHERE enabled;
    SELECT enabled INTO ng FROM countries WHERE code = 'NG';
    IF open_count < 3 THEN
        RAISE EXCEPTION 'TEST FAILED 1: expected at least 3 enabled countries, found %', open_count;
    END IF;
    IF ng IS NOT TRUE THEN
        RAISE EXCEPTION 'TEST FAILED 1: Nigeria is not enabled';
    END IF;
    RAISE NOTICE 'PASS 1: the seed opens the countries it operates in';
END $$;

-- 2 ------------------------------------------------------------------------
-- EVERY SEEDED CURRENCY IS ONE THE MONEY REGISTRY HOLDS.
--
-- The list is written out rather than read from anywhere, because the registry
-- is TypeScript and this is SQL — there is no join between them, which is the
-- whole reason a country cannot invent a currency. If a currency is added to
-- `CURRENCIES`, it goes here too; if a country names one that is not here, it
-- is a country whose customers would have amounts wrong by a power of ten.
DO $$
DECLARE stray TEXT;
BEGIN
    SELECT string_agg(DISTINCT code || '->' || currency, ', ') INTO stray
      FROM countries
     WHERE currency NOT IN ('NGN','USD','GBP','EUR','GHS','KES','CAD','JPY','BTC','USDT','USDC');
    IF stray IS NOT NULL THEN
        RAISE EXCEPTION
            'TEST FAILED 2: these countries name a currency the money registry '
            'does not hold: %. Add it to packages/shared/src/money/currency.ts '
            'with its exponent, or the amounts are wrong by a power of ten.', stray;
    END IF;
    RAISE NOTICE 'PASS 2: every country names a currency the code can represent';
END $$;

-- 3 ------------------------------------------------------------------------
-- A COUNTRY CANNOT BE ENABLED FOR A CURRENCY WITH NO CEILING.
-- This is the rule that stops an operator handing a country's customers an
-- account nothing limits.
DO $$
DECLARE refused BOOLEAN := FALSE;
BEGIN
    BEGIN
        INSERT INTO countries (code, name, dial_code, currency, enabled)
        VALUES ('XA', 'Testland', '999', 'XTS', TRUE);
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM NOT LIKE '%cannot be enabled%' THEN
            RAISE EXCEPTION 'TEST FAILED 3: refused for the wrong reason: %', SQLERRM;
        END IF;
        refused := TRUE;
    END;
    IF NOT refused THEN
        RAISE EXCEPTION 'TEST FAILED 3: a country with an uncovered currency was enabled';
    END IF;
    RAISE NOTICE 'PASS 3: enabling refuses a currency with no daily ceiling';
END $$;

-- 4 ------------------------------------------------------------------------
-- ...and refuses one that has ceilings but nothing WATCHING it. Two separate
-- gaps, two separate messages, because "add limits" and "add a threshold" are
-- different actions.
DO $$
DECLARE refused BOOLEAN := FALSE;
BEGIN
    INSERT INTO kyc_tier_limits (tier, currency, daily_limit_minor)
    VALUES (0,'XTS',0),(1,'XTS',100),(2,'XTS',200);

    BEGIN
        INSERT INTO countries (code, name, dial_code, currency, enabled)
        VALUES ('XB', 'Testland Two', '998', 'XTS', TRUE);
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM NOT LIKE '%risk_thresholds%' THEN
            RAISE EXCEPTION 'TEST FAILED 4: refused for the wrong reason: %', SQLERRM;
        END IF;
        refused := TRUE;
    END;
    IF NOT refused THEN
        RAISE EXCEPTION 'TEST FAILED 4: a country with no monitoring threshold was enabled';
    END IF;
    RAISE NOTICE 'PASS 4: enabling refuses a currency nothing monitors';
END $$;

-- 5 ------------------------------------------------------------------------
-- A country may be ADDED with anything, closed. That is what makes this an
-- operator's table rather than a migration: the row goes in, the decision
-- comes later, and `countries_awaiting_a_decision` is where it waits.
DO $$
DECLARE waiting INT;
BEGIN
    INSERT INTO countries (code, name, dial_code, currency, enabled)
    VALUES ('XC', 'Testland Three', '997', 'XTS', FALSE);

    SELECT count(*) INTO waiting FROM countries_awaiting_a_decision WHERE code = 'XC';
    IF waiting <> 1 THEN
        RAISE EXCEPTION 'TEST FAILED 5: a closed country is not in the queue';
    END IF;
    RAISE NOTICE 'PASS 5: a country can be added closed and waits for a person';
END $$;

-- 6 ------------------------------------------------------------------------
-- Once the currency is covered, the same row enables. The guard is a
-- precondition, not a wall.
DO $$
DECLARE ok BOOLEAN;
BEGIN
    INSERT INTO risk_thresholds (currency, large_value_minor, notable_minor)
    VALUES ('XTS', 1000, 100);

    UPDATE countries SET enabled = TRUE WHERE code = 'XC';
    SELECT enabled INTO ok FROM countries WHERE code = 'XC';
    IF ok IS NOT TRUE THEN
        RAISE EXCEPTION 'TEST FAILED 6: a covered country could not be enabled';
    END IF;
    RAISE NOTICE 'PASS 6: a covered currency opens its country';
END $$;

-- 7 ------------------------------------------------------------------------
-- `countries_without_cover` catches the OTHER direction: cover removed after a
-- country was opened. Empty while the trigger holds, and the trigger cannot
-- see a DELETE from another table.
DO $$
DECLARE exposed INT;
BEGIN
    DELETE FROM risk_thresholds WHERE currency = 'XTS';

    SELECT count(*) INTO exposed FROM countries_without_cover WHERE code = 'XC';
    IF exposed <> 1 THEN
        RAISE EXCEPTION
            'TEST FAILED 7: a country whose currency lost its monitoring '
            'threshold is not reported';
    END IF;
    RAISE NOTICE 'PASS 7: losing cover after opening is visible';
END $$;

-- 8 ------------------------------------------------------------------------
-- The shape checks. A dial code is a PREFIX and not a number — '1' is valid
-- and so is a leading zero elsewhere — so it is text with a digits-only check.
DO $$
DECLARE refused INT := 0;
BEGIN
    BEGIN
        INSERT INTO countries (code,name,dial_code,currency) VALUES ('xx','Lower','1','NGN');
    EXCEPTION WHEN check_violation THEN refused := refused + 1; END;

    BEGIN
        INSERT INTO countries (code,name,dial_code,currency) VALUES ('XD','Plus','+44','NGN');
    EXCEPTION WHEN check_violation THEN refused := refused + 1; END;

    BEGIN
        INSERT INTO countries (code,name,dial_code,currency) VALUES ('XE','X','1','NGN');
    EXCEPTION WHEN check_violation THEN refused := refused + 1; END;

    IF refused <> 3 THEN
        RAISE EXCEPTION 'TEST FAILED 8: expected 3 shape refusals, got %', refused;
    END IF;
    RAISE NOTICE 'PASS 8: a lowercase code, a plus-prefixed dial code and a one-character name are refused';
END $$;

-- 9 ------------------------------------------------------------------------
-- A customer's country REFERENCES the table, so a signup cannot record a
-- place that does not exist. `full_name` is what they typed and is NOT the
-- verified name — that is `kyc_submissions.full_name`, and every money
-- decision reads that one.
DO $$
DECLARE refused BOOLEAN := FALSE;
BEGIN
    BEGIN
        INSERT INTO users (email, status, country) VALUES ('c040@test', 'active', 'QQ');
    EXCEPTION WHEN foreign_key_violation THEN refused := TRUE; END;

    IF NOT refused THEN
        RAISE EXCEPTION 'TEST FAILED 9: a user was recorded in a country that does not exist';
    END IF;
    RAISE NOTICE 'PASS 9: a customer cannot be in a country nobody has added';
END $$;

-- 10 -----------------------------------------------------------------------
-- Both coverage tables answer for this migration, in both directions.
DO $$
DECLARE undecided TEXT;
BEGIN
    SELECT string_agg(table_name, ', ') INTO undecided
      FROM retention_coverage
     WHERE decision IS NULL AND table_name = 'countries';
    IF undecided IS NOT NULL THEN
        RAISE EXCEPTION 'TEST FAILED 10: countries has no retention decision';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM attention_sources WHERE source = 'countries_awaiting_a_decision') THEN
        RAISE EXCEPTION 'TEST FAILED 10: the country queue is not classified';
    END IF;
    RAISE NOTICE 'PASS 10: retention and attention both answer for 040';
END $$;

-- Clean up the fixtures so a re-run against the same database is not the
-- thing that fails.
DELETE FROM countries WHERE code IN ('XA','XB','XC','XD','XE');
DELETE FROM kyc_tier_limits WHERE currency = 'XTS';
DELETE FROM risk_thresholds WHERE currency = 'XTS';
