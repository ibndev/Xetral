-- ===========================================================================
--  069 — invariants for the name-enquiry refusal record
-- ===========================================================================
\set ON_ERROR_STOP on

DO $$
DECLARE
    v_rows BIGINT;
BEGIN
    -- 1. A refusal is BUCKETED, not appended. Two refusals on one rail are one
    --    row with a count of two — 015's rule, restated by 037. A row per call
    --    is the log this shape exists to avoid.
    PERFORM record_name_enquiry_refusal(
        'flutterwave', 'GH', 'MTN', 'Sorry, that account number is invalid',
        'MTN/233…1133: invalid', 'test');
    PERFORM record_name_enquiry_refusal(
        'flutterwave', 'GH', 'MTN', 'Sorry, that account number is invalid',
        'MTN/0…1133: invalid', 'test');

    SELECT count(*) INTO v_rows FROM name_enquiry_refusals
     WHERE provider = 'flutterwave' AND country = 'GH' AND rail_code = 'MTN';
    IF v_rows <> 1 THEN
        RAISE EXCEPTION 'TEST FAILED 1a: two refusals made % rows, not one', v_rows;
    END IF;

    SELECT refusals INTO v_rows FROM name_enquiry_refusals
     WHERE provider = 'flutterwave' AND country = 'GH' AND rail_code = 'MTN';
    IF v_rows <> 2 THEN
        RAISE EXCEPTION 'TEST FAILED 1b: the count says % rather than 2', v_rows;
    END IF;
    RAISE NOTICE 'PASS 1: a refusal is counted, not appended';
END $$;

DO $$
DECLARE
    v_first TIMESTAMPTZ;
    v_last  TIMESTAMPTZ;
    v_msg   TEXT;
BEGIN
    -- 2. THE FIRST SIGHTING SURVIVES and the message is the LATEST. When a
    --    corridor started refusing is the question an operator asks after a
    --    credential was rotated; what it says NOW is the question they ask
    --    while somebody is on the phone.
    SELECT first_seen_at, last_seen_at, last_message
      INTO v_first, v_last, v_msg
      FROM name_enquiry_refusals
     WHERE provider = 'flutterwave' AND country = 'GH' AND rail_code = 'MTN';

    IF v_first > v_last THEN
        RAISE EXCEPTION 'TEST FAILED 2a: first_seen_at is after last_seen_at';
    END IF;

    PERFORM record_name_enquiry_refusal(
        'flutterwave', 'GH', 'MTN', 'Name enquiry is not enabled for this merchant',
        'MTN/233…1133: not enabled', 'live');

    IF (SELECT first_seen_at FROM name_enquiry_refusals
         WHERE provider = 'flutterwave' AND country = 'GH' AND rail_code = 'MTN') <> v_first THEN
        RAISE EXCEPTION 'TEST FAILED 2b: first_seen_at moved';
    END IF;
    IF (SELECT last_message FROM name_enquiry_refusals
         WHERE provider = 'flutterwave' AND country = 'GH' AND rail_code = 'MTN') = v_msg THEN
        RAISE EXCEPTION 'TEST FAILED 2c: the newest sentence did not replace the old';
    END IF;
    RAISE NOTICE 'PASS 2: the first sighting is kept and the sentence is current';
END $$;

DO $$
BEGIN
    -- 3. THE KEY MODE IS A CLOSED SET, because it is the field most likely to
    --    answer the whole question and a free-text one would drift into
    --    "sandbox", "TEST" and "test key" meaning the same thing.
    BEGIN
        PERFORM record_name_enquiry_refusal(
            'flutterwave', 'GH', 'VOD', 'nope', 'VOD/233…1133: nope', 'sandbox');
        RAISE EXCEPTION 'TEST FAILED 3: an unknown key mode was accepted';
    EXCEPTION WHEN check_violation THEN
        RAISE NOTICE 'PASS 3: the key mode is a closed set';
    END;
END $$;

DO $$
BEGIN
    -- 4. A COUNTRY IS AN ISO CODE. `Ghana` and `gh` and `GH` in one column is
    --    three rails as far as the primary key is concerned, and the operator
    --    reading the screen would see one corridor three times.
    BEGIN
        PERFORM record_name_enquiry_refusal(
            'flutterwave', 'Ghana', 'MTN', 'nope', 'MTN: nope', 'live');
        RAISE EXCEPTION 'TEST FAILED 4: a country name was accepted as a code';
    EXCEPTION WHEN check_violation THEN
        RAISE NOTICE 'PASS 4: the country is an ISO code';
    END;
END $$;

DO $$
DECLARE
    v_decision TEXT;
BEGIN
    -- 5. 019 AND 036 BOTH HAVE A LINE ABOUT IT. A table with no retention
    --    decision and a view nobody classified are exactly what those two
    --    files exist to refuse, and both report in BOTH directions.
    SELECT decision INTO v_decision FROM retention_coverage
     WHERE table_name = 'name_enquiry_refusals';
    IF v_decision IS DISTINCT FROM 'keep' THEN
        RAISE EXCEPTION 'TEST FAILED 5a: retention says % for name_enquiry_refusals',
            COALESCE(v_decision, 'nothing');
    END IF;

    SELECT decision INTO v_decision FROM attention_sources
     WHERE source = 'name_enquiry_failures';
    IF v_decision IS DISTINCT FROM 'watch' THEN
        RAISE EXCEPTION 'TEST FAILED 5b: attention says % for name_enquiry_failures',
            COALESCE(v_decision, 'nothing');
    END IF;
    RAISE NOTICE 'PASS 5: the table and the view are both decided about';
END $$;

DO $$
DECLARE
    v_bad BIGINT;
BEGIN
    -- 6. NO COLUMN HERE COULD HOLD A CUSTOMER'S NUMBER, and that is
    --    structural rather than a discipline — the same claim 003 makes about
    --    a card number. The trail carries a SHAPE (`233…1133`); a column
    --    called anything like `account_number` would invite somebody in a
    --    hurry to write the digits into it.
    SELECT count(*) INTO v_bad
      FROM information_schema.columns
     WHERE table_name = 'name_enquiry_refusals'
       AND (column_name LIKE '%account%' OR column_name LIKE '%phone%'
            OR column_name LIKE '%msisdn%' OR column_name LIKE '%number%'
            OR column_name LIKE '%secret%' OR column_name LIKE '%key' );
    IF v_bad <> 0 THEN
        RAISE EXCEPTION 'TEST FAILED 6: % column(s) here could hold a number or a key', v_bad;
    END IF;
    RAISE NOTICE 'PASS 6: no column here could hold a number or a credential';
END $$;
