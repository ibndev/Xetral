\echo '=== 055: the United Kingdom and Canada ==='

\echo '=== 1. Both are open, and both name a currency ==='
DO $$
DECLARE v_open BIGINT;
BEGIN
    SELECT count(*) INTO v_open FROM countries
     WHERE code IN ('GB', 'CA') AND enabled AND currency IN ('GBP', 'CAD');
    IF v_open <> 2 THEN
        RAISE EXCEPTION 'TEST FAILED: % of 2 corridors are open', v_open;
    END IF;
    RAISE NOTICE 'PASS: the UK and Canada are open';
END $$;

\echo '=== 2. Neither could have been opened without cover ==='
-- 040's trigger refuses a country whose currency has no daily ceiling at every
-- tier and nothing watching it — so a file that opened a country before adding
-- the rows would fail on its own trigger. That test 1 passed means the
-- ordering held; this asserts the rows are actually there rather than trusting
-- that it did.
DO $$
DECLARE v_tiers INT; v_watched BOOLEAN;
BEGIN
    FOR v_tiers, v_watched IN
        SELECT (SELECT count(*) FROM kyc_tier_limits k WHERE k.currency = c.currency),
               EXISTS (SELECT 1 FROM risk_thresholds r WHERE r.currency = c.currency)
          FROM countries c WHERE c.code IN ('GB', 'CA')
    LOOP
        IF v_tiers < 3 THEN
            RAISE EXCEPTION 'TEST FAILED: a ceiling is missing at % of 3 tiers', v_tiers;
        END IF;
        IF NOT v_watched THEN
            RAISE EXCEPTION 'TEST FAILED: nothing monitors transactions in that currency';
        END IF;
    END LOOP;
    RAISE NOTICE 'PASS: both currencies have a ceiling at every tier and are watched';
END $$;

\echo '=== 3. THEY SHARE A DIALLING CODE WITH THE UNITED STATES, and that is fine ==='
-- +1 belongs to Canada and the US both. It is the reason the phone pickers key
-- on the COUNTRY CODE rather than on the dialling code: two entries with one
-- value make `find()` return whichever came first, so a customer selects
-- Canada and the screen says United States. Asserted here because the schema
-- is where the collision is visible.
DO $$
DECLARE v_sharing BIGINT;
BEGIN
    SELECT count(*) INTO v_sharing FROM countries WHERE dial_code = '1';
    IF v_sharing < 2 THEN
        RAISE EXCEPTION
            'TEST FAILED: only % country uses +1, so the collision this guards '
            'against cannot occur and the guard is untested', v_sharing;
    END IF;
    RAISE NOTICE 'PASS: % countries share +1, which is why pickers key on the country', v_sharing;
END $$;

\echo '=== 4. Neither can be funded yet, and that is REPORTED ==='
-- Paystack issues dedicated accounts in Nigeria and nowhere else, so a
-- customer here can be paid — by another customer, by a link, in crypto — and
-- cannot top up. A real and temporary state, and one that should be visible
-- rather than discovered from a support ticket.
DO $$
DECLARE v_seen BIGINT;
BEGIN
    SELECT count(*) INTO v_seen FROM countries_without_a_way_in WHERE code IN ('GB', 'CA');
    IF v_seen <> 2 THEN
        RAISE EXCEPTION 'TEST FAILED: % of 2 unfundable corridors are reported', v_seen;
    END IF;
    RAISE NOTICE 'PASS: a corridor with no way in is reported rather than silent';
END $$;
