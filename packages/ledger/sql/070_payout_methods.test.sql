-- ===========================================================================
--  070 — invariants for a country offering more than one rail
-- ===========================================================================
\set ON_ERROR_STOP on

DO $$
DECLARE
    v_offers TEXT[];
BEGIN
    -- 1. GHANA AND KENYA OFFER BOTH, and the default is still the wallet.
    --    Most people in both countries are paid into one, so the screen opens
    --    there; a bank transfer is the second answer rather than the absent
    --    one.
    SELECT payout_methods INTO v_offers FROM countries WHERE code = 'GH';
    IF NOT ('bank' = ANY (v_offers) AND 'mobile_money' = ANY (v_offers)) THEN
        RAISE EXCEPTION 'TEST FAILED 1a: GH offers %', v_offers;
    END IF;
    IF (SELECT payout_method FROM countries WHERE code = 'GH') <> 'mobile_money' THEN
        RAISE EXCEPTION 'TEST FAILED 1b: GH no longer opens on mobile money';
    END IF;

    SELECT payout_methods INTO v_offers FROM countries WHERE code = 'KE';
    IF NOT ('bank' = ANY (v_offers) AND 'mobile_money' = ANY (v_offers)) THEN
        RAISE EXCEPTION 'TEST FAILED 1c: KE offers %', v_offers;
    END IF;
    RAISE NOTICE 'PASS 1: Ghana and Kenya offer both rails, opening on the wallet';
END $$;

DO $$
DECLARE
    v_offers TEXT[];
BEGIN
    -- 2. NIGERIA IS UNTOUCHED. There is no consumer mobile money rail there
    --    for this platform to send to, and offering one would be 046's fault
    --    in the other direction: a product the customer's money cannot reach.
    SELECT payout_methods INTO v_offers FROM countries WHERE code = 'NG';
    IF v_offers <> ARRAY['bank'] THEN
        RAISE EXCEPTION 'TEST FAILED 2: NG offers %', v_offers;
    END IF;
    RAISE NOTICE 'PASS 2: Nigeria still offers banks alone';
END $$;

DO $$
BEGIN
    -- 3. THE DEFAULT MUST BE ONE OF THE OFFERED RAILS. Otherwise a screen
    --    opens on a rail the country does not offer, and the first thing the
    --    customer sees is the one option they cannot use.
    BEGIN
        UPDATE countries SET payout_methods = ARRAY['bank'] WHERE code = 'GH';
        RAISE EXCEPTION 'TEST FAILED 3: the default fell outside what is offered';
    EXCEPTION WHEN check_violation THEN
        RAISE NOTICE 'PASS 3: the default must be one of the offered rails';
    END;
END $$;

DO $$
BEGIN
    -- 4. AN EMPTY SET IS REFUSED. A country offering nothing is a Send screen
    --    with a heading and no options, which reads as a broken page rather
    --    than as a decision.
    BEGIN
        UPDATE countries SET payout_methods = ARRAY[]::TEXT[] WHERE code = 'NG';
        RAISE EXCEPTION 'TEST FAILED 4a: a country was left with no rail';
    EXCEPTION WHEN check_violation THEN
        RAISE NOTICE 'PASS 4a: a country must offer at least one rail';
    END;

    -- And only rails that exist. A value with no adapter behind it is a
    -- picker entry that cannot be used — the momo network lesson, one level up.
    BEGIN
        UPDATE countries SET payout_methods = ARRAY['bank', 'carrier_pigeon'] WHERE code = 'NG';
        RAISE EXCEPTION 'TEST FAILED 4b: an unknown rail was accepted';
    EXCEPTION WHEN check_violation THEN
        RAISE NOTICE 'PASS 4b: only rails that exist may be offered';
    END;
END $$;

DO $$
DECLARE
    v_user   BIGINT;
    v_wallet BIGINT;
    v_pend   BIGINT;
    v_float  BIGINT;
    v_entry  BIGINT;
    v_id     BIGINT;
BEGIN
    -- 5. A PAYOUT'S RAIL IS IMMUTABLE, like its provider (046) and its
    --    destination (043). The number on the row was normalised FOR that rail
    --    — E.164 for a wallet, exactly as typed for a bank — so a rail that
    --    could be edited afterwards would describe a payout never made, and a
    --    payout nothing can describe is one nothing can settle or reverse.
    --
    --    Fixtures written out, prefixed `p70:`, for the reason 043's header
    --    gives: a bare key aborts a whole file on its first block in CI order.
    INSERT INTO users (email, full_name, country, status)
    VALUES ('p70-rails@example.test', 'Rails Tester', 'GH', 'active')
    RETURNING id INTO v_user;

    INSERT INTO accounts (kind, owner_id, currency, normal_balance)
    VALUES ('customer_wallet', v_user, 'GHS', 'credit') RETURNING id INTO v_wallet;
    INSERT INTO accounts (kind, owner_id, currency, normal_balance)
    VALUES ('customer_pending', v_user, 'GHS', 'credit') RETURNING id INTO v_pend;

    SELECT id INTO v_float FROM accounts
     WHERE kind = 'provider_float' AND currency = 'GHS' AND owner_id IS NULL;
    IF v_float IS NULL THEN
        INSERT INTO accounts (kind, owner_id, currency, normal_balance)
        VALUES ('provider_float', NULL, 'GHS', 'debit') RETURNING id INTO v_float;
    END IF;

    -- Funded first, or the overdraft guard refuses the reserve below.
    INSERT INTO journal_entries (idempotency_key, kind, description, occurred_at)
    VALUES ('p70:fund', 'wallet_funding', 'p70 fixture', now()) RETURNING id INTO v_entry;
    INSERT INTO postings (journal_entry_id, account_id, amount_minor, currency)
    VALUES (v_entry, v_float, -100000, 'GHS'), (v_entry, v_wallet, 100000, 'GHS');

    INSERT INTO journal_entries (idempotency_key, kind, description, occurred_at)
    VALUES ('p70:reserve', 'wallet_withdrawal', 'p70 reserve', now()) RETURNING id INTO v_entry;
    INSERT INTO postings (journal_entry_id, account_id, amount_minor, currency)
    VALUES (v_entry, v_wallet, -1000, 'GHS'), (v_entry, v_pend, 1000, 'GHS');

    INSERT INTO bank_payouts
        (user_id, reference, idempotency_key, country, bank_code, bank_name,
         account_number, currency, amount_minor, fee_minor, reserve_entry_id,
         payout_method)
    VALUES (v_user, 'p70:ref-1', 'p70:key-1', 'GH', 'MTN', 'MTN Mobile Money',
            '233553921133', 'GHS', 1000, 0, v_entry, 'mobile_money')
    RETURNING id INTO v_id;

    BEGIN
        UPDATE bank_payouts SET payout_method = 'bank' WHERE id = v_id;
        RAISE EXCEPTION 'TEST FAILED 5: a payout''s rail was changed after sending';
    EXCEPTION WHEN check_violation THEN
        RAISE NOTICE 'PASS 5: a payout''s rail cannot change';
    END;
END $$;

DO $$
DECLARE
    v_null BIGINT;
BEGIN
    -- 6. EVERY EXISTING ROW WAS BACKFILLED FROM ITS COUNTRY, which is a claim
    --    about HISTORY rather than a guess: until this migration a country had
    --    exactly one rail, so that is the one every earlier payout used. A row
    --    whose country is no longer in the table keeps NULL — 061's rule is
    --    repair, never assert.
    SELECT count(*) INTO v_null
      FROM bank_payouts p
      JOIN countries c ON c.code = p.country
     WHERE p.payout_method IS NULL;
    IF v_null <> 0 THEN
        RAISE EXCEPTION 'TEST FAILED 6: % payout(s) with a known country have no rail', v_null;
    END IF;
    RAISE NOTICE 'PASS 6: every payout in a known country records its rail';
END $$;

DO $$
DECLARE
    v_decision TEXT;
BEGIN
    -- 7. 036 — every view is classified, in both directions.
    SELECT decision INTO v_decision FROM attention_sources
     WHERE source = 'country_payout_rails';
    IF v_decision IS DISTINCT FROM 'internal' THEN
        RAISE EXCEPTION 'TEST FAILED 7: attention says % for country_payout_rails',
            COALESCE(v_decision, 'nothing');
    END IF;
    RAISE NOTICE 'PASS 7: the rails view is classified';
END $$;
