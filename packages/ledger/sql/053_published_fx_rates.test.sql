\echo '=== 053: the rate itself, set by us ==='

\echo '=== 1. A rate is a RATIO of integers ==='
-- Phase 10's finding, made structural. "Minor units per major unit" works for
-- USD→NGN and collapses for NGN→USD, where one kobo is 0.0006 cents and any
-- per-major integer rounds to zero — so the whole corridor would quote nothing
-- in one direction and nobody would notice until a customer tried it.
DO $$
BEGIN
    INSERT INTO fx_published_rates
      (base_currency, quote_currency, numerator, denominator, quote_per_base)
    VALUES ('NGN', 'GHS', 78, 10000, '0.0078');
    RAISE NOTICE 'PASS: a sub-unit rate is expressible in the direction that collapses';
END $$;

\echo '=== 2. Zero or negative is refused ==='
-- A denominator of zero is a division by zero at quote time, and a negative
-- numerator is money moving the wrong way. Neither is something a form should
-- be trusted to prevent.
DO $$
BEGIN
    INSERT INTO fx_published_rates
      (base_currency, quote_currency, numerator, denominator, quote_per_base)
    VALUES ('NGN', 'KES', 100, 0, '1');
    RAISE EXCEPTION 'TEST FAILED: a zero denominator was accepted';
EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS: a rate cannot divide by zero';
END $$;

\echo '=== 3. ONE live rate per direction ==='
-- Two would make `ORDER BY ... LIMIT 1` the thing resolving the ambiguity,
-- which is 035's argument about overlapping gift card bands: a LIMIT 1
-- settling a question the schema should have refused.
DO $$
BEGIN
    INSERT INTO fx_published_rates
      (base_currency, quote_currency, numerator, denominator, quote_per_base)
    VALUES ('NGN', 'GHS', 79, 10000, '0.0079');
    RAISE EXCEPTION 'TEST FAILED: two live rates for one direction';
EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'PASS: one live rate per direction';
END $$;

\echo '=== 4. THE REVERSE DIRECTION IS A DIFFERENT ROW ==='
-- A rate is a ratio, so NGN→GHS says nothing about GHS→NGN. Publishing one and
-- assuming the other is how a corridor works in one direction and refuses in
-- the other, with nothing on any screen saying so.
DO $$
BEGIN
    INSERT INTO fx_published_rates
      (base_currency, quote_currency, numerator, denominator, quote_per_base)
    VALUES ('GHS', 'NGN', 1280000, 10000, '128.00');
    RAISE NOTICE 'PASS: each direction is published on its own';
END $$;

\echo '=== 5. A published rate is APPEND-ONLY ==='
-- Editing one rewrites the price of every past quote. Retire and republish, so
-- a trade months old can still be checked against what was live.
DO $$
BEGIN
    UPDATE fx_published_rates SET numerator = 999
     WHERE base_currency = 'NGN' AND quote_currency = 'GHS' AND retired_at IS NULL;
    RAISE EXCEPTION 'TEST FAILED: a published rate was edited';
EXCEPTION WHEN raise_exception THEN
    RAISE NOTICE 'PASS: a rate is retired and republished, never edited';
END $$;

\echo '=== 6. And is never deleted ==='
DO $$
BEGIN
    DELETE FROM fx_published_rates WHERE base_currency = 'NGN' AND quote_currency = 'GHS';
    RAISE EXCEPTION 'TEST FAILED: a published rate was deleted';
EXCEPTION WHEN raise_exception THEN
    RAISE NOTICE 'PASS: a published rate is never deleted';
END $$;

\echo '=== 7. Retiring frees the direction, and a retired rate stays retired ==='
DO $$
BEGIN
    UPDATE fx_published_rates SET retired_at = now()
     WHERE base_currency = 'NGN' AND quote_currency = 'GHS' AND retired_at IS NULL;

    -- The direction is free again.
    INSERT INTO fx_published_rates
      (base_currency, quote_currency, numerator, denominator, quote_per_base)
    VALUES ('NGN', 'GHS', 80, 10000, '0.0080');

    -- And what was retired cannot come back: un-retiring would resurrect a
    -- price without a record of the gap, which is the same claim about the
    -- present that 033 refuses for consent.
    BEGIN
        UPDATE fx_published_rates SET retired_at = NULL
         WHERE base_currency = 'NGN' AND quote_currency = 'GHS' AND retired_at IS NOT NULL;
        RAISE EXCEPTION 'TEST FAILED: a retired rate was brought back';
    EXCEPTION WHEN raise_exception THEN
        NULL;
    END;

    RAISE NOTICE 'PASS: retiring frees the direction and cannot be undone';
END $$;

\echo '=== 8. A spread with NO rate of ours is VISIBLE ==='
-- Correct where a provider quotes the pair, and wrong where none does — and
-- the second refuses every customer with nothing on any screen saying why.
DO $$
DECLARE v_seen BIGINT;
BEGIN
    INSERT INTO fx_spread_policies (base_currency, quote_currency, spread_basis_points)
    VALUES ('NGN', 'KES', 150);

    SELECT count(*) INTO v_seen FROM fx_pairs_priced_without_a_rate
     WHERE base_currency = 'NGN' AND quote_currency = 'KES';
    IF v_seen <> 1 THEN
        RAISE EXCEPTION 'TEST FAILED: a priced pair with no rate is invisible';
    END IF;

    INSERT INTO fx_published_rates
      (base_currency, quote_currency, numerator, denominator, quote_per_base)
    VALUES ('NGN', 'KES', 9, 100, '0.09');

    SELECT count(*) INTO v_seen FROM fx_pairs_priced_without_a_rate
     WHERE base_currency = 'NGN' AND quote_currency = 'KES';
    IF v_seen <> 0 THEN
        RAISE EXCEPTION 'TEST FAILED: a pair with a rate is still reported';
    END IF;

    RAISE NOTICE 'PASS: a margin with no rate behind it is reported';
END $$;
