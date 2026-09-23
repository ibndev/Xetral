-- ===========================================================================
--  078 — invariants for the card funding plan
--
--  Each block states one property and fails with TEST FAILED if it does not
--  hold. The CHECKs are immediate, so no SET CONSTRAINTS is needed here.
-- ===========================================================================
\set ON_ERROR_STOP on

DO $$
DECLARE
    v_user BIGINT;
    v_card BIGINT;
BEGIN
    INSERT INTO users (email, status, full_name, country, phone)
    VALUES ('078-owner@example.test', 'active', 'Ada Obi', 'NG', '+2348030780078')
    RETURNING id INTO v_user;
    INSERT INTO cards (user_id, provider_card_id, last4, status)
    VALUES (v_user, 'p78-card', '7878', 'active')
    RETURNING id INTO v_card;

    -- 1. A base currency is a registry-shaped code or nothing.
    UPDATE cards SET base_currency = 'GHS' WHERE id = v_card;
    BEGIN
        UPDATE cards SET base_currency = 'naira' WHERE id = v_card;
        RAISE EXCEPTION 'TEST FAILED: a base currency that is not a code was accepted';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
    RAISE NOTICE 'PASS 1: a card base currency is a currency code';

    -- 2. A leg in the card's own currency converts nothing and costs nothing.
    INSERT INTO card_topup_sources
        (card_id, user_id, topup_key, seq, currency, target_currency, debit_minor,
         delivers_minor, converted, spread_basis_points, applied_numerator, applied_denominator)
    VALUES (v_card, v_user, 'k78', 0, 'USD', 'USD', 1000, 1000, false, 0, 1, 1);
    BEGIN
        INSERT INTO card_topup_sources
            (card_id, user_id, topup_key, seq, currency, target_currency, debit_minor,
             delivers_minor, converted, spread_basis_points, applied_numerator, applied_denominator)
        VALUES (v_card, v_user, 'k78-fee', 0, 'USD', 'USD', 1000, 1000, false, 150, 1, 1);
        RAISE EXCEPTION 'TEST FAILED: a fee was charged on a leg that converts nothing';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
    BEGIN
        INSERT INTO card_topup_sources
            (card_id, user_id, topup_key, seq, currency, target_currency, debit_minor,
             delivers_minor, converted, spread_basis_points, applied_numerator, applied_denominator)
        VALUES (v_card, v_user, 'k78-same', 0, 'USD', 'USD', 1000, 990, true, 100, 99, 100);
        RAISE EXCEPTION 'TEST FAILED: a dollar leg on a dollar card claimed a conversion';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
    RAISE NOTICE 'PASS 2: no fee and no conversion on the card currency''s own wallet';

    -- 3. One wallet appears once per attempt.
    INSERT INTO card_topup_sources
        (card_id, user_id, topup_key, seq, currency, target_currency, debit_minor,
         delivers_minor, converted, spread_basis_points, applied_numerator, applied_denominator)
    VALUES (v_card, v_user, 'k78', 1, 'NGN', 'USD', 1650000, 985, true, 150, 985, 1650000);
    BEGIN
        INSERT INTO card_topup_sources
            (card_id, user_id, topup_key, seq, currency, target_currency, debit_minor,
             delivers_minor, converted, spread_basis_points, applied_numerator, applied_denominator)
        VALUES (v_card, v_user, 'k78', 2, 'NGN', 'USD', 1650000, 985, true, 150, 985, 1650000);
        RAISE EXCEPTION 'TEST FAILED: one wallet was tapped twice in one plan';
    EXCEPTION WHEN unique_violation THEN NULL;
    END;
    RAISE NOTICE 'PASS 3: each wallet is tapped at most once per top-up';

    -- 4. Append-only.
    BEGIN
        UPDATE card_topup_sources SET debit_minor = 1 WHERE card_id = v_card;
        RAISE EXCEPTION 'TEST FAILED: a funding plan was edited';
    EXCEPTION WHEN raise_exception THEN
        IF SQLERRM NOT LIKE '%append-only%' THEN RAISE; END IF;
    END;
    BEGIN
        DELETE FROM card_topup_sources WHERE card_id = v_card;
        RAISE EXCEPTION 'TEST FAILED: a funding plan was deleted';
    EXCEPTION WHEN raise_exception THEN
        IF SQLERRM NOT LIKE '%append-only%' THEN RAISE; END IF;
    END;
    RAISE NOTICE 'PASS 4: a funding plan cannot be edited or deleted';

    -- 5. The view shows a plan whose conversion has not happened as exactly
    --    that: no trade, not a missing row.
    IF (SELECT count(*) FROM card_topup_funding WHERE card_id = v_card AND topup_key = 'k78') <> 2 THEN
        RAISE EXCEPTION 'TEST FAILED: the funding view dropped a leg';
    END IF;
    IF EXISTS (SELECT 1 FROM card_topup_funding
                WHERE card_id = v_card AND currency = 'NGN' AND fx_trade_uuid IS NOT NULL) THEN
        RAISE EXCEPTION 'TEST FAILED: a conversion that never ran was attributed a trade';
    END IF;
    RAISE NOTICE 'PASS 5: the funding view shows every leg, executed or not';

    -- 6. The coverage guards know about both.
    IF NOT EXISTS (SELECT 1 FROM retention_decisions WHERE table_name = 'card_topup_sources') THEN
        RAISE EXCEPTION 'TEST FAILED: card_topup_sources has no retention decision';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM attention_sources WHERE source = 'card_topup_funding') THEN
        RAISE EXCEPTION 'TEST FAILED: card_topup_funding is not classified';
    END IF;
    RAISE NOTICE 'PASS 6: retention and attention coverage include the new table and view';
END $$;
