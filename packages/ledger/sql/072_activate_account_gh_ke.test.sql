-- ===========================================================================
--  072 — invariants for offering an account number outside Nigeria
-- ===========================================================================
\set ON_ERROR_STOP on

DO $$
DECLARE
    v_in TEXT[];
BEGIN
    -- 1. THE COLUMN STILL SAYS A NUBAN IS NIGERIAN, and 051 still agrees.
    --
    --    This migration's first draft appended `virtual_account` to Ghana and
    --    Kenya so the Add Money button would appear there, and 051's
    --    invariant — "a NUBAN is offered outside Nigeria" is a TEST FAILURE —
    --    turned red. The invariant was right: a NUBAN is a NIGERIAN account
    --    number, and whatever Flutterwave issues in Accra is not one.
    --
    --    The button never needed the column. The screen offers it wherever
    --    the platform operates and the rail answers, so what was bought was
    --    nothing and what was spent was an invariant.
    SELECT funding_methods INTO v_in FROM countries WHERE code = 'GH';
    IF 'virtual_account' = ANY (v_in) THEN
        RAISE EXCEPTION 'TEST FAILED 1a: GH claims a NUBAN (051 refuses this)';
    END IF;
    SELECT funding_methods INTO v_in FROM countries WHERE code = 'KE';
    IF 'virtual_account' = ANY (v_in) THEN
        RAISE EXCEPTION 'TEST FAILED 1b: KE claims a NUBAN (051 refuses this)';
    END IF;
    RAISE NOTICE 'PASS 1: a dedicated account number is still Nigeria''s alone';
END $$;

DO $$
DECLARE
    v_in TEXT[];
BEGIN
    -- 2. AND THE TWO REAL WAYS IN SURVIVED. 051 gave both countries the
    --    wallet and 071 gave them bank transfer; neither is affected by a
    --    button that asks a provider a question.
    SELECT funding_methods INTO v_in FROM countries WHERE code = 'GH';
    IF NOT ('mobile_money' = ANY (v_in) AND 'bank_transfer' = ANY (v_in)) THEN
        RAISE EXCEPTION 'TEST FAILED 2a: GH funds by %', v_in;
    END IF;
    SELECT funding_methods INTO v_in FROM countries WHERE code = 'KE';
    IF NOT ('mobile_money' = ANY (v_in) AND 'bank_transfer' = ANY (v_in)) THEN
        RAISE EXCEPTION 'TEST FAILED 2b: KE funds by %', v_in;
    END IF;
    RAISE NOTICE 'PASS 2: the wallet and bank-transfer rails are untouched';
END $$;

DO $$
DECLARE
    v_in TEXT[];
BEGIN
    -- 3. NIGERIA IS UNCHANGED.
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

DO $$
DECLARE
    v_user  BIGINT;
    v_entry BIGINT;
    v_rail  TEXT;
BEGIN
    -- 6. A PAYOUT THAT DOES NOT NAME ITS RAIL GETS THE COUNTRY'S, ON THE WAY
    --    IN. 070 backfilled and then asserted the result, which is a claim
    --    about one UPDATE rather than about the table — the next silent INSERT
    --    broke it, and CI found six of them. This is the property itself.
    SELECT id INTO v_user FROM users WHERE email = 'p70-rails@example.test';
    IF v_user IS NULL THEN
        RAISE EXCEPTION 'TEST FAILED 6: the 070 fixture is missing';
    END IF;
    SELECT reserve_entry_id INTO v_entry FROM bank_payouts WHERE reference = 'p70:ref-1';

    INSERT INTO bank_payouts
        (user_id, reference, idempotency_key, country, bank_code, bank_name,
         account_number, currency, amount_minor, fee_minor, reserve_entry_id)
    VALUES (v_user, 'p72:silent', 'p72:silent', 'GH', 'MTN', 'MTN Mobile Money',
            '233553921133', 'GHS', 500, 0, v_entry);

    SELECT payout_method INTO v_rail FROM bank_payouts WHERE reference = 'p72:silent';
    IF v_rail IS DISTINCT FROM 'mobile_money' THEN
        RAISE EXCEPTION 'TEST FAILED 6: a silent GH payout recorded %',
            COALESCE(v_rail, 'nothing');
    END IF;
    RAISE NOTICE 'PASS 6: a payout that names no rail takes its country''s';
END $$;

DO $$
DECLARE
    v_null BIGINT;
BEGIN
    -- 7. AND NOTHING IN A KNOWN COUNTRY IS LEFT WITHOUT ONE. 070's assertion,
    --    now that the trigger above makes it true of every row rather than of
    --    the ones that happened to exist when a migration ran.
    SELECT count(*) INTO v_null
      FROM bank_payouts p
      JOIN countries c ON c.code = p.country
     WHERE p.payout_method IS NULL;
    IF v_null <> 0 THEN
        RAISE EXCEPTION 'TEST FAILED 7: % payout(s) with a known country have no rail', v_null;
    END IF;
    RAISE NOTICE 'PASS 7: every payout in a known country records its rail';
END $$;
