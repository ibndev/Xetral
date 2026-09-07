-- ============================================================================
--  063 — tests. Every block prints PASS or raises.
-- ============================================================================

\set ON_ERROR_STOP on

DO $$
DECLARE v_u BIGINT;
BEGIN
    INSERT INTO users (uuid, email, phone, full_name, country)
    VALUES (gen_random_uuid(), 't63-gh@example.test', '+233244000063', 'Momo Tester', 'GH')
    RETURNING id INTO v_u;
    RAISE NOTICE 'seeded a Ghanaian customer for the momo tests';
END $$;

-- ---------------------------------------------------------------------------
--  1. A linked number starts CLAIMED, not verified.
--
--  There is no way to ask who owns a wallet — 043's `name_unavailable` — so
--  linking asserts nothing about the holder. Defaulting to verified would make
--  the state meaningless on the one path it exists to gate.
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_u BIGINT; v_status TEXT; v_at TIMESTAMPTZ;
BEGIN
    SELECT id INTO v_u FROM users WHERE email = 't63-gh@example.test';
    INSERT INTO momo_accounts (user_id, network, msisdn, currency)
    VALUES (v_u, 'MTN', '+233244000063', 'GHS');

    SELECT status, verified_at INTO v_status, v_at
      FROM momo_accounts WHERE user_id = v_u;

    IF v_status <> 'claimed' THEN
        RAISE EXCEPTION 'TEST FAILED 1: a fresh link is %', v_status;
    END IF;
    IF v_at IS NOT NULL THEN
        RAISE EXCEPTION 'TEST FAILED 1: a claimed number carries a verification moment';
    END IF;
    RAISE NOTICE 'PASS 1: a linked number starts claimed';
END $$;

-- ---------------------------------------------------------------------------
--  2. ONE LIVE NUMBER PER CUSTOMER.
--
--  Two live wallets on one account is two places a payout could go, and the
--  screen would have to ask which — on the request whose whole point is that
--  it does not have to.
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_u BIGINT;
BEGIN
    SELECT id INTO v_u FROM users WHERE email = 't63-gh@example.test';
    BEGIN
        INSERT INTO momo_accounts (user_id, network, msisdn, currency)
        VALUES (v_u, 'VOD', '+233209999063', 'GHS');
        RAISE EXCEPTION 'TEST FAILED 2: a second live number was accepted';
    EXCEPTION WHEN unique_violation THEN
        NULL;
    END;
    RAISE NOTICE 'PASS 2: a customer holds one live mobile money number';
END $$;

-- ---------------------------------------------------------------------------
--  3. AND ONE CUSTOMER PER NUMBER.
--
--  Two accounts on one wallet would let a deposit from it be attributed to
--  either — 025's argument about one person and one BVN, applied to the
--  identifier money actually moves on here.
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_other BIGINT;
BEGIN
    INSERT INTO users (uuid, email, phone, full_name, country)
    VALUES (gen_random_uuid(), 't63-gh2@example.test', '+233244000163', 'Second', 'GH')
    RETURNING id INTO v_other;

    BEGIN
        INSERT INTO momo_accounts (user_id, network, msisdn, currency)
        VALUES (v_other, 'MTN', '+233244000063', 'GHS');
        RAISE EXCEPTION 'TEST FAILED 3: one wallet was linked to two customers';
    EXCEPTION WHEN unique_violation THEN
        NULL;
    END;
    RAISE NOTICE 'PASS 3: a wallet belongs to one customer';
END $$;

-- ---------------------------------------------------------------------------
--  4. THE NUMBER IS IMMUTABLE.
--
--  An UPDATE moving it would point authorised money at a wallet nobody named,
--  and every control that has already read this row would be describing
--  something else. The rule 043 applies to a bank payout destination.
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_u BIGINT;
BEGIN
    SELECT id INTO v_u FROM users WHERE email = 't63-gh@example.test';
    BEGIN
        UPDATE momo_accounts SET msisdn = '+233555000063' WHERE user_id = v_u;
        RAISE EXCEPTION 'TEST FAILED 4: the number was changed in place';
    EXCEPTION WHEN raise_exception THEN
        IF SQLERRM LIKE 'TEST FAILED%' THEN RAISE; END IF;
    END;

    BEGIN
        UPDATE momo_accounts SET network = 'VOD' WHERE user_id = v_u;
        RAISE EXCEPTION 'TEST FAILED 4: the network was changed in place';
    EXCEPTION WHEN raise_exception THEN
        IF SQLERRM LIKE 'TEST FAILED%' THEN RAISE; END IF;
    END;
    RAISE NOTICE 'PASS 4: a linked number and its network are immutable';
END $$;

-- ---------------------------------------------------------------------------
--  5. VERIFICATION IS ONE WAY.
--
--  "Money arrived from this wallet" is a statement about HISTORY. If one
--  UPDATE could clear it, the record would be a claim about the present — the
--  reason a consumed refresh token can never be un-consumed.
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_u BIGINT;
BEGIN
    SELECT id INTO v_u FROM users WHERE email = 't63-gh@example.test';
    UPDATE momo_accounts SET status = 'verified', verified_at = now() WHERE user_id = v_u;

    BEGIN
        UPDATE momo_accounts SET status = 'claimed', verified_at = NULL WHERE user_id = v_u;
        RAISE EXCEPTION 'TEST FAILED 5: a verified number was un-verified';
    EXCEPTION WHEN raise_exception THEN
        IF SQLERRM LIKE 'TEST FAILED%' THEN RAISE; END IF;
    END;
    RAISE NOTICE 'PASS 5: verification cannot be undone';
END $$;

-- ---------------------------------------------------------------------------
--  6. REMOVING IS FINAL, AND FREES THE CUSTOMER TO LINK ANOTHER.
--
--  Both halves matter: a removed row cannot be restored, and the partial
--  indexes stop counting it — otherwise unlinking would strand an account with
--  no way to link anything again.
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_u BIGINT; v_live INT;
BEGIN
    SELECT id INTO v_u FROM users WHERE email = 't63-gh@example.test';
    UPDATE momo_accounts SET status = 'removed', removed_at = now() WHERE user_id = v_u;

    BEGIN
        UPDATE momo_accounts SET status = 'verified' WHERE user_id = v_u;
        RAISE EXCEPTION 'TEST FAILED 6: a removed number was restored';
    EXCEPTION WHEN raise_exception THEN
        IF SQLERRM LIKE 'TEST FAILED%' THEN RAISE; END IF;
    END;

    INSERT INTO momo_accounts (user_id, network, msisdn, currency)
    VALUES (v_u, 'VOD', '+233209999063', 'GHS');

    SELECT COUNT(*) INTO v_live FROM linked_momo_accounts WHERE user_id = v_u;
    IF v_live <> 1 THEN
        RAISE EXCEPTION 'TEST FAILED 6: % live rows after relinking', v_live;
    END IF;
    RAISE NOTICE 'PASS 6: removal is final and the customer may link another';
END $$;

-- ---------------------------------------------------------------------------
--  7. THE NUMBER MUST BE E.164.
--
--  040's argument: a plain unique index on text cannot see that three
--  spellings of one number are one wallet, and every per-customer control
--  assumes one person cannot become several.
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_u BIGINT;
BEGIN
    SELECT id INTO v_u FROM users WHERE email = 't63-gh2@example.test';
    BEGIN
        INSERT INTO momo_accounts (user_id, network, msisdn, currency)
        VALUES (v_u, 'MTN', '0244123456', 'GHS');
        RAISE EXCEPTION 'TEST FAILED 7: a national-format number was accepted';
    EXCEPTION WHEN check_violation THEN
        NULL;
    END;
    RAISE NOTICE 'PASS 7: only an E.164 number can reach a row';
END $$;

-- ---------------------------------------------------------------------------
--  8. The view carries no name and no email.
--
--  `payable_links`' rule: an identifier joined to a person is a harvester
--  wherever it is later exposed.
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_leak TEXT;
BEGIN
    SELECT string_agg(column_name, ', ') INTO v_leak
      FROM information_schema.columns
     WHERE table_name = 'linked_momo_accounts'
       AND column_name IN ('email', 'full_name', 'name', 'first_name');
    IF v_leak IS NOT NULL THEN
        RAISE EXCEPTION 'TEST FAILED 8: the view exposes %', v_leak;
    END IF;
    RAISE NOTICE 'PASS 8: the view is an identifier, not a directory';
END $$;

-- ---------------------------------------------------------------------------
--  9. 019 has a decision for the new table.
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_decision TEXT;
BEGIN
    SELECT decision INTO v_decision FROM retention_decisions WHERE table_name = 'momo_accounts';
    IF v_decision IS DISTINCT FROM 'keep' THEN
        RAISE EXCEPTION 'TEST FAILED 9: momo_accounts is decided %', v_decision;
    END IF;
    RAISE NOTICE 'PASS 9: the linked wallet is part of the financial record';
END $$;
