-- ===========================================================================
--  071 — invariants for the v4 credentials and the two-way corridors
-- ===========================================================================
\set ON_ERROR_STOP on

DO $$
DECLARE
    v_count BIGINT;
BEGIN
    -- 1. BOTH HALVES OF THE v4 PAIR EXIST AS SLOTS. One without the other is
    --    a box an operator fills and nothing reads — 026's rule that a
    --    credential with no adapter behind it reads as "this is running".
    SELECT count(*) INTO v_count FROM provider_credential_slots
     WHERE provider = 'flutterwave'
       AND name IN ('v4_client_id', 'v4_client_secret')
       AND in_use;
    IF v_count <> 2 THEN
        RAISE EXCEPTION 'TEST FAILED 1: % of 2 v4 slots are in use', v_count;
    END IF;
    RAISE NOTICE 'PASS 1: both v4 credential slots exist and are in use';
END $$;

DO $$
DECLARE
    v_secret BIGINT;
BEGIN
    -- 2. THE v3 SECRET KEY IS UNTOUCHED. v4 is used for ONE READ that moves
    --    nothing; every payout, every checkout and every webhook still
    --    authorises with the v3 key. Retiring it here would be 042's mistake
    --    in reverse — turning "you need a second credential" into "your first
    --    one is wrong".
    SELECT count(*) INTO v_secret FROM provider_credential_slots
     WHERE provider = 'flutterwave' AND name = 'secret_key' AND in_use;
    IF v_secret <> 1 THEN
        RAISE EXCEPTION 'TEST FAILED 2: the v3 secret key slot is no longer in use';
    END IF;
    RAISE NOTICE 'PASS 2: the v3 secret key is still the credential money moves on';
END $$;

DO $$
DECLARE
    v_in TEXT[];
BEGIN
    -- 3. GHANA AND KENYA CAN BE FUNDED THE WAY THEY CAN BE PAID. 070 gave
    --    them two ways out and left one way in, which is a product where the
    --    Send screen offers a choice the Add Money screen does not.
    SELECT funding_methods INTO v_in FROM countries WHERE code = 'GH';
    IF NOT ('bank_transfer' = ANY (v_in) AND 'mobile_money' = ANY (v_in)) THEN
        RAISE EXCEPTION 'TEST FAILED 3a: GH funds by %', v_in;
    END IF;

    SELECT funding_methods INTO v_in FROM countries WHERE code = 'KE';
    IF NOT ('bank_transfer' = ANY (v_in) AND 'mobile_money' = ANY (v_in)) THEN
        RAISE EXCEPTION 'TEST FAILED 3b: KE funds by %', v_in;
    END IF;
    RAISE NOTICE 'PASS 3: Ghana and Kenya fund by wallet and by bank transfer';
END $$;

DO $$
DECLARE
    v_in TEXT[];
BEGIN
    -- 4. NIGERIA IS UNTOUCHED. It funds by a DEDICATED ACCOUNT NUMBER issued
    --    in the customer's own name (006), which is a different product from
    --    a checkout showing a one-off account to pay into. Collapsing them
    --    would make Add Money offer to "activate your account number" and
    --    hand back something that expires.
    SELECT funding_methods INTO v_in FROM countries WHERE code = 'NG';
    IF v_in <> ARRAY['virtual_account'] THEN
        RAISE EXCEPTION 'TEST FAILED 4: NG funds by %', v_in;
    END IF;
    RAISE NOTICE 'PASS 4: Nigeria still funds by its own dedicated account';
END $$;

DO $$
BEGIN
    -- 5. ONLY FUNDING METHODS THAT EXIST. A value with no adapter behind it
    --    is a tile on the Add Money screen that cannot be tapped — the momo
    --    network lesson, in the other direction.
    BEGIN
        UPDATE countries SET funding_methods = ARRAY['carrier_pigeon'] WHERE code = 'NG';
        RAISE EXCEPTION 'TEST FAILED 5: an unknown funding method was accepted';
    EXCEPTION WHEN check_violation THEN
        RAISE NOTICE 'PASS 5: only funding methods that exist may be offered';
    END;
END $$;

DO $$
DECLARE
    v_out TEXT[];
BEGIN
    -- 6. THE HALF-OPEN CORRIDOR IS VISIBLE. `out_only` names a rail money can
    --    leave on and cannot arrive on — which is allowed and should be a
    --    decision somebody made rather than something nobody could see.
    --    Ghana and Kenya should now have none.
    SELECT out_only INTO v_out FROM country_money_paths WHERE code = 'GH';
    IF coalesce(array_length(v_out, 1), 0) <> 0 THEN
        RAISE EXCEPTION 'TEST FAILED 6: GH can still pay out on % and not take it in', v_out;
    END IF;
    RAISE NOTICE 'PASS 6: Ghana has no rail it can pay out on and not be paid on';
END $$;

DO $$
DECLARE
    v_decision TEXT;
BEGIN
    -- 7. 036 — every view is classified, in both directions.
    SELECT decision INTO v_decision FROM attention_sources
     WHERE source = 'country_money_paths';
    IF v_decision IS DISTINCT FROM 'internal' THEN
        RAISE EXCEPTION 'TEST FAILED 7: attention says % for country_money_paths',
            COALESCE(v_decision, 'nothing');
    END IF;
    RAISE NOTICE 'PASS 7: the money-paths view is classified';
END $$;
