-- ===========================================================================
--  Xetral — error capture invariant tests
--  packages/ledger/sql/015_error_events.test.sql
--
--  NOT idempotent. Run against a freshly created database, in migration order.
-- ===========================================================================

\set QUIET on
\pset format unaligned
\pset tuples_only on

\echo '=== 1. A fingerprint must be the shape the recorder produces ==='
-- If the column and `fingerprintOf` ever disagree, every recording attempt
-- fails — silently, inside a filter written never to throw. That is the worst
-- combination available, so the shape is constrained on both sides.
DO $$
BEGIN
    INSERT INTO error_events (fingerprint, message) VALUES ('not-a-fingerprint', 'boom');
    RAISE EXCEPTION 'TEST FAILED: a malformed fingerprint was stored';
EXCEPTION
    WHEN check_violation THEN
        RAISE NOTICE 'PASS: a fingerprint is 16 hex characters';
END $$;

\echo ''
\echo '=== 2. Recording a new failure creates one row ==='
DO $$
DECLARE v_id BIGINT; v_count BIGINT;
BEGIN
    v_id := record_error('aaaaaaaaaaaaaaaa', 'error', 'user <n> not found',
                         '/v1/admin/users/:id', 500);

    SELECT occurrences INTO v_count FROM error_events WHERE id = v_id;
    IF v_count <> 1 THEN
        RAISE EXCEPTION 'TEST FAILED: expected 1 occurrence, got %', v_count;
    END IF;
    RAISE NOTICE 'PASS: a new failure is recorded';
END $$;

\echo ''
\echo '=== 3. The SAME failure counts, it does not accumulate rows ==='
-- The whole reason the fingerprint exists. A thousand occurrences of one bug
-- must be one row with a count, or the table is a log and "is this new?" —
-- the only question it answers — cannot be asked.
DO $$
DECLARE v_count BIGINT; v_rows BIGINT;
BEGIN
    PERFORM record_error('aaaaaaaaaaaaaaaa', 'error', 'user <n> not found',
                         '/v1/admin/users/:id', 500);
    PERFORM record_error('aaaaaaaaaaaaaaaa', 'error', 'user <n> not found',
                         '/v1/admin/users/:id', 500);

    SELECT occurrences INTO v_count FROM error_events WHERE fingerprint = 'aaaaaaaaaaaaaaaa';
    SELECT count(*) INTO v_rows FROM error_events WHERE fingerprint = 'aaaaaaaaaaaaaaaa';

    IF v_count <> 3 THEN
        RAISE EXCEPTION 'TEST FAILED: expected 3 occurrences, got %', v_count;
    END IF;
    IF v_rows <> 1 THEN
        RAISE EXCEPTION 'TEST FAILED: expected 1 row, got %', v_rows;
    END IF;
    RAISE NOTICE 'PASS: repeats increment a count rather than adding rows';
END $$;

\echo ''
\echo '=== 4. Severity is raised, never lowered ==='
-- A flow that is sometimes critical must always be reported as critical.
-- Letting a later ordinary occurrence downgrade it would mean the worst thing
-- that ever happened stops being visible the moment the mild version recurs.
DO $$
DECLARE v_severity error_severity;
BEGIN
    PERFORM record_error('bbbbbbbbbbbbbbbb', 'critical', 'suspense deposit unattributed', NULL, NULL);
    PERFORM record_error('bbbbbbbbbbbbbbbb', 'error', 'suspense deposit unattributed', NULL, NULL);

    SELECT severity INTO v_severity FROM error_events WHERE fingerprint = 'bbbbbbbbbbbbbbbb';
    IF v_severity <> 'critical' THEN
        RAISE EXCEPTION 'TEST FAILED: severity was downgraded to %', v_severity;
    END IF;
    RAISE NOTICE 'PASS: severity only ever rises';
END $$;

\echo ''
\echo '=== 5. A NEW fingerprint is due for an alert ==='
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM errors_alert_due WHERE fingerprint = 'aaaaaaaaaaaaaaaa') THEN
        RAISE EXCEPTION 'TEST FAILED: a failure nobody has been told about is not due';
    END IF;
    RAISE NOTICE 'PASS: a failure nobody has heard of is worth saying';
END $$;

\echo ''
\echo '=== 6. Having been told, we do not say it again immediately ==='
-- An alerting rule people do not trust is one they mute, and a muted alert is
-- worse than none because it is still believed to be working. "It happened
-- again" is true of every open bug.
DO $$
BEGIN
    UPDATE error_events SET alerted_at = now(), alerted_count = occurrences
     WHERE fingerprint = 'aaaaaaaaaaaaaaaa';

    IF EXISTS (SELECT 1 FROM errors_alert_due WHERE fingerprint = 'aaaaaaaaaaaaaaaa') THEN
        RAISE EXCEPTION 'TEST FAILED: a failure already reported is due again on a repeat';
    END IF;
    RAISE NOTICE 'PASS: a known failure is not re-reported for recurring';
END $$;

\echo ''
\echo '=== 7. An order-of-magnitude escalation IS worth saying ==='
DO $$
DECLARE v_count BIGINT;
BEGIN
    -- Was 3 and alerted at 3. Push it past 30.
    UPDATE error_events SET occurrences = 30 WHERE fingerprint = 'aaaaaaaaaaaaaaaa';

    IF NOT EXISTS (SELECT 1 FROM errors_alert_due WHERE fingerprint = 'aaaaaaaaaaaaaaaa') THEN
        SELECT occurrences INTO v_count FROM error_events WHERE fingerprint = 'aaaaaaaaaaaaaaaa';
        RAISE EXCEPTION 'TEST FAILED: % occurrences after alerting at 3 is not due', v_count;
    END IF;
    RAISE NOTICE 'PASS: ten times worse than last time is news again';
END $$;

\echo ''
\echo '=== 8. A resolved failure drops out of the queue ==='
DO $$
BEGIN
    UPDATE error_events SET resolved_at = now() WHERE fingerprint = 'aaaaaaaaaaaaaaaa';

    IF EXISTS (SELECT 1 FROM errors_alert_due WHERE fingerprint = 'aaaaaaaaaaaaaaaa') THEN
        RAISE EXCEPTION 'TEST FAILED: a resolved failure is still due';
    END IF;
    IF EXISTS (SELECT 1 FROM errors_open WHERE fingerprint = 'aaaaaaaaaaaaaaaa') THEN
        RAISE EXCEPTION 'TEST FAILED: a resolved failure is still open';
    END IF;
    RAISE NOTICE 'PASS: resolving one removes it from both queues';
END $$;

\echo ''
\echo '=== 9. A recurrence REOPENS a resolved failure ==='
-- The one that matters most in this file. A bug somebody closed and which has
-- come back is news again; leaving it resolved would hide the recurrence
-- behind the fix that did not work.
DO $$
DECLARE v_resolved TIMESTAMPTZ;
BEGIN
    PERFORM record_error('aaaaaaaaaaaaaaaa', 'error', 'user <n> not found',
                         '/v1/admin/users/:id', 500);

    SELECT resolved_at INTO v_resolved FROM error_events WHERE fingerprint = 'aaaaaaaaaaaaaaaa';
    IF v_resolved IS NOT NULL THEN
        RAISE EXCEPTION 'TEST FAILED: a recurrence left the failure resolved';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM errors_open WHERE fingerprint = 'aaaaaaaaaaaaaaaa') THEN
        RAISE EXCEPTION 'TEST FAILED: a reopened failure is not in the open queue';
    END IF;
    RAISE NOTICE 'PASS: a bug that comes back is news again';
END $$;

\echo ''
\echo '=== 10. Timestamps cannot run backwards ==='
DO $$
BEGIN
    UPDATE error_events SET last_seen_at = first_seen_at - interval '1 hour'
     WHERE fingerprint = 'bbbbbbbbbbbbbbbb';
    RAISE EXCEPTION 'TEST FAILED: last_seen_at was moved before first_seen_at';
EXCEPTION
    WHEN check_violation THEN
        RAISE NOTICE 'PASS: a failure cannot last be seen before it first was';
END $$;

\echo ''
\echo 'error capture: all blocks passed'
