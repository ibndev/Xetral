-- 068 invariants. Every block prints PASS or raises TEST FAILED.
--
-- Run against a freshly migrated database. Not idempotent: the fixtures below
-- insert rows and the file is written to be read in order.

\set ON_ERROR_STOP on

-- ---------------------------------------------------------------------------
-- 1. A XETRAL ACCOUNT HAS NO RAIL, AND EVERY OTHER DESTINATION HAS ONE
--
--    By CHECK rather than by the endpoint. Without it a `momo` row with no
--    network is writable, and the failure surfaces at the provider as an
--    unhelpful refusal about a field the customer never saw.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    who BIGINT;
BEGIN
    INSERT INTO users (email, status, full_name, country, phone)
    VALUES ('068-owner@example.test', 'active', 'Ama Mensah', 'GH', '+233501112222')
    RETURNING id INTO who;

    CREATE TEMP TABLE r68 (user_id BIGINT);
    INSERT INTO r68 VALUES (who);

    -- A Xetral recipient: no rail, and that is correct.
    INSERT INTO recipients (user_id, kind, country, currency, destination, display_name)
    VALUES (who, 'xetral', 'NG', 'NGN', '2348031234567', 'Chidi Okeke');

    -- A wallet: a rail, and that is correct too.
    INSERT INTO recipients
        (user_id, kind, country, currency, rail_code, rail_name, destination,
         display_name, resolved_name)
    VALUES
        (who, 'momo', 'GH', 'GHS', 'MTN', 'MTN Mobile Money', '233553921133',
         'RABI SIEDU', 'RABI SIEDU');

    BEGIN
        INSERT INTO recipients (user_id, kind, country, currency, destination, display_name)
        VALUES (who, 'momo', 'GH', 'GHS', '233553921134', 'No network');
        RAISE EXCEPTION 'TEST FAILED: a momo recipient with no rail was accepted';
    EXCEPTION WHEN check_violation THEN
        NULL;
    END;

    BEGIN
        INSERT INTO recipients
            (user_id, kind, country, currency, rail_code, rail_name, destination, display_name)
        VALUES (who, 'xetral', 'NG', 'NGN', 'MTN', 'MTN Mobile Money', '2348031234568', 'Rail?');
        RAISE EXCEPTION 'TEST FAILED: a Xetral recipient carrying a rail was accepted';
    EXCEPTION WHEN check_violation THEN
        NULL;
    END;

    RAISE NOTICE 'PASS 1: the rail and the kind cannot disagree';
END $$;

-- ---------------------------------------------------------------------------
-- 2. A DESTINATION IS DIGITS, ALREADY IN THE FORM THE RAIL ACCEPTS
--
--    `0553921133`, `+233 55 392 1133` and `233553921133` are one wallet, and a
--    unique index on text cannot see that. The service normalises before the
--    row is written; this is what makes that structural rather than customary.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    who BIGINT;
BEGIN
    SELECT user_id INTO who FROM r68;

    BEGIN
        INSERT INTO recipients
            (user_id, kind, country, currency, rail_code, rail_name, destination, display_name)
        VALUES
            (who, 'momo', 'GH', 'GHS', 'MTN', 'MTN Mobile Money',
             '+233553921135', 'Plus sign');
        RAISE EXCEPTION 'TEST FAILED: a destination carrying a + was accepted';
    EXCEPTION WHEN check_violation THEN
        NULL;
    END;

    BEGIN
        INSERT INTO recipients
            (user_id, kind, country, currency, rail_code, rail_name, destination, display_name)
        VALUES
            (who, 'momo', 'GH', 'GHS', 'MTN', 'MTN Mobile Money',
             '233 553 921 136', 'Spaces');
        RAISE EXCEPTION 'TEST FAILED: a destination carrying spaces was accepted';
    EXCEPTION WHEN check_violation THEN
        NULL;
    END;

    RAISE NOTICE 'PASS 2: a destination must be digits only';
END $$;

-- ---------------------------------------------------------------------------
-- 3. ONE LIVE ROW PER DESTINATION, AND A REMOVED ONE DOES NOT BLOCK A RE-ADD
--
--    Partial on `removed_at IS NULL`, for the reason 006's virtual-account
--    index is partial. A customer who removed somebody by accident must be
--    able to add them back rather than being told they already exist — about a
--    row they cannot see.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    who  BIGINT;
    gone BIGINT;
BEGIN
    SELECT user_id INTO who FROM r68;

    BEGIN
        INSERT INTO recipients
            (user_id, kind, country, currency, rail_code, rail_name, destination, display_name)
        VALUES
            (who, 'momo', 'GH', 'GHS', 'MTN', 'MTN Mobile Money', '233553921133', 'Again');
        RAISE EXCEPTION 'TEST FAILED: a second live recipient on one destination was accepted';
    EXCEPTION WHEN unique_violation THEN
        NULL;
    END;

    -- Remove it, and the same destination becomes addable again.
    UPDATE recipients SET removed_at = now()
     WHERE user_id = who AND destination = '233553921133'
     RETURNING id INTO gone;
    IF gone IS NULL THEN
        RAISE EXCEPTION 'TEST FAILED: the fixture recipient was not there to remove';
    END IF;

    INSERT INTO recipients
        (user_id, kind, country, currency, rail_code, rail_name, destination,
         display_name, resolved_name)
    VALUES
        (who, 'momo', 'GH', 'GHS', 'MTN', 'MTN Mobile Money', '233553921133',
         'RABI SIEDU', 'RABI SIEDU');

    RAISE NOTICE 'PASS 3: one live row per destination, and a removed one frees it';
END $$;

-- ---------------------------------------------------------------------------
-- 4. WHERE THE MONEY LANDS CANNOT BE EDITED
--
--    043 makes a payout's destination immutable because the reserve is already
--    posted and an UPDATE moving the number sends authorised money to somebody
--    never named. The same argument reaches one step further back: a saved
--    recipient is what a customer taps WITHOUT re-reading, so a row whose
--    number could be edited is a way to redirect every future payment.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    who BIGINT;
    row_id BIGINT;
BEGIN
    SELECT user_id INTO who FROM r68;
    SELECT id INTO row_id FROM recipients
     WHERE user_id = who AND kind = 'xetral' AND removed_at IS NULL;

    IF row_id IS NULL THEN
        RAISE EXCEPTION 'TEST FAILED: no live Xetral recipient to try to edit';
    END IF;

    BEGIN
        UPDATE recipients SET destination = '2348039999999' WHERE id = row_id;
        RAISE EXCEPTION 'TEST FAILED: a recipient destination was edited';
    EXCEPTION WHEN check_violation THEN
        NULL;
    END;

    BEGIN
        UPDATE recipients SET currency = 'GHS' WHERE id = row_id;
        RAISE EXCEPTION 'TEST FAILED: a recipient currency was edited';
    EXCEPTION WHEN check_violation THEN
        NULL;
    END;

    BEGIN
        UPDATE recipients SET country = 'GH' WHERE id = row_id;
        RAISE EXCEPTION 'TEST FAILED: a recipient country was edited';
    EXCEPTION WHEN check_violation THEN
        NULL;
    END;

    BEGIN
        UPDATE recipients SET kind = 'bank' WHERE id = row_id;
        RAISE EXCEPTION 'TEST FAILED: a recipient kind was edited';
    EXCEPTION WHEN check_violation THEN
        NULL;
    END;

    -- THE LABEL IS THE CUSTOMER'S OWN NOTE and may be changed. Renaming
    -- somebody in your address book moves no money; that is the whole
    -- distinction this trigger draws.
    UPDATE recipients SET display_name = 'Chidi (landlord)' WHERE id = row_id;

    RAISE NOTICE 'PASS 4: the destination is immutable and the label is not';
END $$;

-- ---------------------------------------------------------------------------
-- 5. A REMOVED RECIPIENT CANNOT BE RESTORED
--
--    Removal is final for the reason it is a column rather than a DELETE: an
--    un-removable row is history, and a row that could be brought back would
--    let a destination be parked and restored after a complaint was closed.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    row_id BIGINT;
BEGIN
    SELECT id INTO row_id FROM recipients
     WHERE user_id = (SELECT user_id FROM r68) AND removed_at IS NOT NULL
     LIMIT 1;
    IF row_id IS NULL THEN
        RAISE EXCEPTION 'TEST FAILED: no removed recipient to try to restore';
    END IF;

    BEGIN
        UPDATE recipients SET removed_at = NULL WHERE id = row_id;
        RAISE EXCEPTION 'TEST FAILED: a removed recipient was restored';
    EXCEPTION WHEN check_violation THEN
        NULL;
    END;

    RAISE NOTICE 'PASS 5: removal is final';
END $$;

-- ---------------------------------------------------------------------------
-- 6. A DISPLAY NAME IS NOT BLANK, AND A RESOLVED NAME IS ABSENT OR REAL
--
--    "No name" and "blank name" must not be the same row, or the absence stops
--    meaning anything — 067's rule about `bank_payouts.account_name`, applied
--    to the list a customer taps without re-reading.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    who BIGINT;
BEGIN
    SELECT user_id INTO who FROM r68;

    BEGIN
        INSERT INTO recipients (user_id, kind, country, currency, destination, display_name)
        VALUES (who, 'xetral', 'NG', 'NGN', '2348031234570', '   ');
        RAISE EXCEPTION 'TEST FAILED: a blank display name was accepted';
    EXCEPTION WHEN check_violation THEN
        NULL;
    END;

    BEGIN
        INSERT INTO recipients
            (user_id, kind, country, currency, destination, display_name, resolved_name)
        VALUES (who, 'xetral', 'NG', 'NGN', '2348031234571', 'Somebody', '  ');
        RAISE EXCEPTION 'TEST FAILED: a blank resolved name was accepted';
    EXCEPTION WHEN check_violation THEN
        NULL;
    END;

    -- NULL is the honest value where the rail has no name enquiry, and it is
    -- accepted. Kenya's M-PESA is that case, permanently.
    INSERT INTO recipients
        (user_id, kind, country, currency, rail_code, rail_name, destination,
         display_name, resolved_name)
    VALUES
        (who, 'momo', 'KE', 'KES', 'MPS', 'M-Pesa', '254712345678',
         'Wanjiru', NULL);

    RAISE NOTICE 'PASS 6: a name is absent or real, never blank';
END $$;

-- ---------------------------------------------------------------------------
-- 7. THE COVERAGE GUARDS ARE SATISFIED
--
--    019 fails the build on a table with no retention decision, in both
--    directions. A saved recipient is personal data about a THIRD PARTY — the
--    person being paid never agreed to anything here — so a missing decision
--    would be exactly the silence that guard exists to break.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    decided TEXT;
    priced  BOOLEAN;
BEGIN
    SELECT decision INTO decided FROM retention_decisions WHERE table_name = 'recipients';
    IF decided IS DISTINCT FROM 'purge' THEN
        RAISE EXCEPTION 'TEST FAILED: recipients has no purge retention decision (got %)', decided;
    END IF;

    SELECT TRUE INTO priced FROM platform_settings WHERE key = 'payout_debit_currencies';
    IF priced IS NOT TRUE THEN
        RAISE EXCEPTION 'TEST FAILED: payout_debit_currencies is not a setting';
    END IF;

    -- EMPTY IS THE DEFAULT, and that is the decision rather than an omission.
    -- Naming another balance makes the provider convert at ITS rate, which
    -- silently overrides the spread an operator published — 032's argument
    -- about the transfer levy, applied to a treasury choice.
    IF (SELECT value FROM platform_settings WHERE key = 'payout_debit_currencies') <> '' THEN
        RAISE EXCEPTION 'TEST FAILED: payout_debit_currencies must ship empty';
    END IF;

    RAISE NOTICE 'PASS 7: the retention decision and the debit setting are in place';
END $$;

-- ---------------------------------------------------------------------------
-- 8. A RECIPIENT BELONGS TO A REAL CUSTOMER
--
--    A foreign key rather than a convention, so an address book cannot outlive
--    the account it belongs to or be written against an id nobody holds.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
    BEGIN
        INSERT INTO recipients (user_id, kind, country, currency, destination, display_name)
        VALUES (-1, 'xetral', 'NG', 'NGN', '2348031234599', 'Nobody');
        RAISE EXCEPTION 'TEST FAILED: a recipient was written against no customer';
    EXCEPTION WHEN foreign_key_violation THEN
        NULL;
    END;
    RAISE NOTICE 'PASS 8: a recipient names a real customer';
END $$;
