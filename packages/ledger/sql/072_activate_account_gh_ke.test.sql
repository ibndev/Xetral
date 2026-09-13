-- ===========================================================================
--  072 — invariants for offering an account number outside Nigeria
-- ===========================================================================
\set ON_ERROR_STOP on

DO $$
DECLARE
    v_in TEXT[];
BEGIN
    -- 1. GHANA AND KENYA MAY ASK. The button is offered; whether Flutterwave
    --    answers is Flutterwave's to say, which is the whole correction.
    SELECT funding_methods INTO v_in FROM countries WHERE code = 'GH';
    IF NOT ('virtual_account' = ANY (v_in)) THEN
        RAISE EXCEPTION 'TEST FAILED 1a: GH funds by %', v_in;
    END IF;
    SELECT funding_methods INTO v_in FROM countries WHERE code = 'KE';
    IF NOT ('virtual_account' = ANY (v_in)) THEN
        RAISE EXCEPTION 'TEST FAILED 1b: KE funds by %', v_in;
    END IF;
    RAISE NOTICE 'PASS 1: Ghana and Kenya may ask for an account number';
END $$;

DO $$
DECLARE
    v_in TEXT[];
BEGIN
    -- 2. AND THE OTHER TWO WAYS IN SURVIVED. Appending a third must not be a
    --    decision against the first two: a wallet charge and a bank transfer
    --    are how most money actually arrives in both countries, and 051 and
    --    071 each recorded one of them.
    SELECT funding_methods INTO v_in FROM countries WHERE code = 'GH';
    IF NOT ('mobile_money' = ANY (v_in) AND 'bank_transfer' = ANY (v_in)) THEN
        RAISE EXCEPTION 'TEST FAILED 2a: GH lost a funding method: %', v_in;
    END IF;
    SELECT funding_methods INTO v_in FROM countries WHERE code = 'KE';
    IF NOT ('mobile_money' = ANY (v_in) AND 'bank_transfer' = ANY (v_in)) THEN
        RAISE EXCEPTION 'TEST FAILED 2b: KE lost a funding method: %', v_in;
    END IF;
    RAISE NOTICE 'PASS 2: the wallet and bank-transfer rails are untouched';
END $$;

DO $$
DECLARE
    v_in TEXT[];
BEGIN
    -- 3. NIGERIA IS UNCHANGED. Its dedicated NUBAN is a different product
    --    from a checkout account, and 071's argument is that calling one the
    --    other makes Add Money hand back something that expires.
    SELECT funding_methods INTO v_in FROM countries WHERE code = 'NG';
    IF v_in <> ARRAY['virtual_account'] THEN
        RAISE EXCEPTION 'TEST FAILED 3: NG funds by %', v_in;
    END IF;
    RAISE NOTICE 'PASS 3: Nigeria still funds by its own dedicated account alone';
END $$;

DO $$
DECLARE
    v_gap BIGINT;
BEGIN
    -- 4. NO ENABLED COUNTRY OFFERS AN ACCOUNT WITH NOTHING ROUTED TO SERVE
    --    IT. 059 routes GHS and KES to Flutterwave for collection, so this
    --    must be empty — and if a later migration removes a route while
    --    leaving the offer, this is what says so.
    SELECT count(*) INTO v_gap FROM countries_offering_an_unrouted_account;
    IF v_gap <> 0 THEN
        RAISE EXCEPTION 'TEST FAILED 4: % country/ies offer an unrouted account', v_gap;
    END IF;
    RAISE NOTICE 'PASS 4: every country offering an account has a collection rail';
END $$;

DO $$
DECLARE
    v_decision TEXT;
BEGIN
    -- 5. 036 — every view is classified, in both directions.
    SELECT decision INTO v_decision FROM attention_sources
     WHERE source = 'countries_offering_an_unrouted_account';
    IF v_decision IS DISTINCT FROM 'watch' THEN
        RAISE EXCEPTION 'TEST FAILED 5: attention says % for the unrouted-account view',
            COALESCE(v_decision, 'nothing');
    END IF;
    RAISE NOTICE 'PASS 5: the unrouted-account view is classified';
END $$;
