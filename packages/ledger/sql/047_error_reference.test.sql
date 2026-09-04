-- 047 — the reference on a screen finds the row that explains it.
BEGIN;

DO $$
DECLARE
    v_id  BIGINT;
    v_ref TEXT;
    v_occ BIGINT;
BEGIN
    -- 1. A reference is stored, and reaches the view the dashboard reads.
    PERFORM record_error('0470000000000001', 'error', 'Error: the first one',
                         '/probe/one', 500, 'aa11bb');
    SELECT last_reference INTO v_ref FROM errors_open WHERE fingerprint = '0470000000000001';
    IF v_ref IS DISTINCT FROM 'aa11bb' THEN
        RAISE EXCEPTION 'TEST FAILED 1: errors_open did not carry the reference (got %)', v_ref;
    END IF;
    RAISE NOTICE 'PASS 1: a reference reaches the view the dashboard reads';

    -- 2. A newer occurrence REPLACES it. The question somebody asks is about
    --    the reference they are holding, which is the most recent one.
    PERFORM record_error('0470000000000001', 'error', 'Error: the first one',
                         '/probe/one', 500, 'cc22dd');
    SELECT last_reference, occurrences INTO v_ref, v_occ
      FROM error_events WHERE fingerprint = '0470000000000001';
    IF v_ref IS DISTINCT FROM 'cc22dd' OR v_occ <> 2 THEN
        RAISE EXCEPTION 'TEST FAILED 2: expected cc22dd/2, got %/%', v_ref, v_occ;
    END IF;
    RAISE NOTICE 'PASS 2: a newer occurrence replaces the reference and counts';

    -- 3. AN OCCURRENCE WITH NO REFERENCE DOES NOT ERASE ONE. Rows written
    --    before this migration carry none, and so would any caller that
    --    forgot; blanking the column would destroy the one thing a person is
    --    holding on a screenshot.
    PERFORM record_error('0470000000000001', 'error', 'Error: the first one',
                         '/probe/one', 500, NULL);
    SELECT last_reference INTO v_ref FROM error_events WHERE fingerprint = '0470000000000001';
    IF v_ref IS DISTINCT FROM 'cc22dd' THEN
        RAISE EXCEPTION 'TEST FAILED 3: a null occurrence erased the reference (got %)', v_ref;
    END IF;
    RAISE NOTICE 'PASS 3: an occurrence with no reference leaves the last one alone';

    -- 4. THE SHAPE IS ENFORCED. Without this the column is free text on a
    --    table everybody on call reads, and the first person in a hurry writes
    --    a sentence into it.
    BEGIN
        UPDATE error_events SET last_reference = 'not a reference'
         WHERE fingerprint = '0470000000000001';
        RAISE EXCEPTION 'TEST FAILED 4: a non-reference was accepted';
    EXCEPTION WHEN check_violation THEN
        RAISE NOTICE 'PASS 4: only six hex characters can be written';
    END;

    -- 5. THE OLD FIVE-ARGUMENT CALL STILL WORKS, AND IS UNAMBIGUOUS.
    --
    --    A deploy is not atomic: this migration lands while the previous
    --    bundle is still serving, so a function that stopped accepting its
    --    call would turn a rollout into an outage inside the error recorder.
    --
    --    This caught a real one. Adding a defaulted sixth parameter with
    --    `CREATE OR REPLACE` creates an OVERLOAD rather than replacing, and
    --    the five-argument call then matches both — "function record_error is
    --    not unique", raised on every 500 mid-deploy. The migration drops the
    --    old signature first.
    SELECT record_error('0470000000000002', 'error', 'Error: the second one',
                        '/probe/two', 500) INTO v_id;
    IF v_id IS NULL THEN
        RAISE EXCEPTION 'TEST FAILED 5: the five-argument form was refused';
    END IF;
    RAISE NOTICE 'PASS 5: the previous bundle''s call still works mid-deploy';
END $$;

ROLLBACK;
