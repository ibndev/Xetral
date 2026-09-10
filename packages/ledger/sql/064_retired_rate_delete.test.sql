\set ON_ERROR_STOP on
\echo '=== 064 — deleting a retired published rate ==='

-- ---------------------------------------------------------------------------
\echo '--- 1. A LIVE RATE CANNOT BE DELETED ---'
-- The half that protects a customer: removing a live rate unprices the
-- corridor, and an unpublished pair is REFUSED rather than quoted from a
-- default. The next customer is told the pair cannot be converted and nothing
-- says a row went missing.
-- ---------------------------------------------------------------------------
DO $$
DECLARE live_id BIGINT;
BEGIN
    INSERT INTO fx_published_rates
        (base_currency, quote_currency, numerator, denominator, quote_per_base)
    VALUES ('NGN', 'JPY', 1, 10, '0.100000')
    RETURNING id INTO live_id;

    BEGIN
        DELETE FROM fx_published_rates WHERE id = live_id;
        RAISE EXCEPTION 'TEST FAILED: a live rate was deleted';
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM LIKE 'TEST FAILED%' THEN RAISE; END IF;
        IF SQLERRM NOT LIKE '%LIVE published rate cannot be deleted%' THEN
            RAISE EXCEPTION 'TEST FAILED: refused for the wrong reason: %', SQLERRM;
        END IF;
    END;
    RAISE NOTICE 'PASS: a live rate cannot be deleted';

    -- ------------------------------------------------------------------
    RAISE NOTICE '--- 2. A RETIRED RATE CAN BE ---';
    -- Nothing references a rate row by key and `fx_trades` carries its own
    -- applied ratio, so this loses an offer nobody took rather than the price
    -- of anything that happened.
    -- ------------------------------------------------------------------
    UPDATE fx_published_rates SET retired_at = now() WHERE id = live_id;
    DELETE FROM fx_published_rates WHERE id = live_id;
    IF EXISTS (SELECT 1 FROM fx_published_rates WHERE id = live_id) THEN
        RAISE EXCEPTION 'TEST FAILED: the retired rate is still there';
    END IF;
    RAISE NOTICE 'PASS: a retired rate is deletable';
END $$;

-- ---------------------------------------------------------------------------
\echo '--- 3. EDITING ONE IN PLACE IS STILL REFUSED ---'
-- 053's actual subject, untouched by any of the above.
-- ---------------------------------------------------------------------------
DO $$
DECLARE r_id BIGINT;
BEGIN
    INSERT INTO fx_published_rates
        (base_currency, quote_currency, numerator, denominator, quote_per_base)
    VALUES ('NGN', 'JPY', 1, 10, '0.100000')
    RETURNING id INTO r_id;

    BEGIN
        UPDATE fx_published_rates SET numerator = 999 WHERE id = r_id;
        RAISE EXCEPTION 'TEST FAILED: a published rate was edited';
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM LIKE 'TEST FAILED%' THEN RAISE; END IF;
        IF SQLERRM NOT LIKE '%cannot be edited%' THEN
            RAISE EXCEPTION 'TEST FAILED: refused for the wrong reason: %', SQLERRM;
        END IF;
    END;
    RAISE NOTICE 'PASS: a published rate still cannot be edited';

    UPDATE fx_published_rates SET retired_at = now() WHERE id = r_id;
    DELETE FROM fx_published_rates WHERE id = r_id;
END $$;

\echo '=== 064 done ==='
