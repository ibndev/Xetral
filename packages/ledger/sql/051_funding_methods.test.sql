\echo '=== 051: how somebody puts money in, per country ==='

\echo '=== 1. Nigeria has a dedicated account rail and the others do not ==='
-- The whole reason this column exists. Offering a NUBAN to a customer in
-- Accra is offering a product their money cannot reach — 046's finding, in
-- the inbound direction.
DO $$
DECLARE v_ng TEXT[]; v_gh TEXT[]; v_ke TEXT[];
BEGIN
    SELECT funding_methods INTO v_ng FROM countries WHERE code = 'NG';
    SELECT funding_methods INTO v_gh FROM countries WHERE code = 'GH';
    SELECT funding_methods INTO v_ke FROM countries WHERE code = 'KE';

    IF NOT ('virtual_account' = ANY(v_ng)) THEN
        RAISE EXCEPTION 'TEST FAILED: Nigeria cannot issue a dedicated account';
    END IF;
    IF 'virtual_account' = ANY(v_gh) OR 'virtual_account' = ANY(v_ke) THEN
        RAISE EXCEPTION 'TEST FAILED: a NUBAN is offered outside Nigeria';
    END IF;
    IF NOT ('mobile_money' = ANY(v_gh)) OR NOT ('mobile_money' = ANY(v_ke)) THEN
        RAISE EXCEPTION 'TEST FAILED: Ghana and Kenya are not marked mobile money';
    END IF;
    RAISE NOTICE 'PASS: each country is offered the rail it actually has';
END $$;

\echo '=== 2. A method this platform does not implement is REFUSED ==='
-- A free-text array is a place to type `momo` and have the screen quietly
-- render nothing — the `crypto_enabled` failure, where a setting nothing
-- reads is worse than no setting because it is trusted.
DO $$
BEGIN
    UPDATE countries SET funding_methods = ARRAY['momo'] WHERE code = 'GH';
    RAISE EXCEPTION 'TEST FAILED: an unimplemented funding method was accepted';
EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS: only a method something reads can be offered';
END $$;

\echo '=== 3. BOTH is expressible, because a country may have both ==='
-- The day Paystack issues dedicated accounts in Ghana, an operator adds one
-- entry and the screen offers it on the next load. If that needed a migration
-- the column would not be doing its job.
DO $$
DECLARE v_gh TEXT[];
BEGIN
    UPDATE countries
       SET funding_methods = ARRAY['mobile_money', 'virtual_account']
     WHERE code = 'GH';

    SELECT funding_methods INTO v_gh FROM countries WHERE code = 'GH';
    IF cardinality(v_gh) <> 2 THEN
        RAISE EXCEPTION 'TEST FAILED: a country cannot hold two funding methods';
    END IF;

    -- Put it back: these suites share one database and a row left changed is
    -- a setting every later file is subject to.
    UPDATE countries SET funding_methods = ARRAY['mobile_money'] WHERE code = 'GH';
    RAISE NOTICE 'PASS: a country can offer both, without a migration';
END $$;

\echo '=== 4. An open country with NO way in is visible ==='
DO $$
DECLARE v_seen BIGINT;
BEGIN
    UPDATE countries SET funding_methods = '{}' WHERE code = 'KE';

    SELECT count(*) INTO v_seen FROM countries_without_a_way_in WHERE code = 'KE';
    IF v_seen <> 1 THEN
        RAISE EXCEPTION 'TEST FAILED: an open country with no funding rail is invisible';
    END IF;

    -- A country that is CLOSED is not a gap: nobody there has an account.
    UPDATE countries SET funding_methods = ARRAY['mobile_money'] WHERE code = 'KE';
    SELECT count(*) INTO v_seen FROM countries_without_a_way_in WHERE code = 'KE';
    IF v_seen <> 0 THEN
        RAISE EXCEPTION 'TEST FAILED: a country with a rail is still reported';
    END IF;

    RAISE NOTICE 'PASS: a country customers cannot fund from is reported';
END $$;
