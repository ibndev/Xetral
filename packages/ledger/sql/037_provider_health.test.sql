-- ===========================================================================
--  Xetral — provider health invariants
--  packages/ledger/sql/037_provider_health.test.sql
-- ===========================================================================

\set QUIET on
\pset format unaligned
\pset tuples_only on

\echo '=== 1. A REJECTION IS NOT ILL HEALTH ==='
-- The distinction the whole file rests on. A rejection is the provider
-- understanding the request and refusing it — insufficient float, a declined
-- card. Counting it as an outage makes a busy decline rate look like one, and
-- an alert that fires on ordinary business is one people mute.
DO $$
DECLARE v_failures BIGINT; v_rejected BIGINT; v_percent INT;
BEGIN
    PERFORM record_provider_call('p37bank', 'authorize', 'rejected', 'insufficient funds');
    PERFORM record_provider_call('p37bank', 'authorize', 'rejected', 'card frozen');
    PERFORM record_provider_call('p37bank', 'authorize', 'succeeded');

    SELECT failures, rejected, failure_percent INTO v_failures, v_rejected, v_percent
      FROM provider_health_recent WHERE provider = 'p37bank' AND operation = 'authorize';

    IF v_rejected <> 2 THEN
        RAISE EXCEPTION 'TEST FAILED: refusals were not counted at all (%)', v_rejected;
    END IF;
    IF v_failures <> 0 OR v_percent <> 0 THEN
        RAISE EXCEPTION 'TEST FAILED: two declines read as a % failure rate', v_percent;
    END IF;
    RAISE NOTICE 'PASS: a declined card is the provider working';
END $$;

\echo '=== 2. Unreachable, timed out and unparseable DO ==='
DO $$
DECLARE v_failures BIGINT; v_percent INT;
BEGIN
    PERFORM record_provider_call('p37down', 'issueCard', 'unavailable', 'connection refused');
    PERFORM record_provider_call('p37down', 'issueCard', 'timed_out', 'timed out');
    PERFORM record_provider_call('p37down', 'issueCard', 'contract', 'unexpected shape');
    PERFORM record_provider_call('p37down', 'issueCard', 'succeeded');
    -- Five calls, because `provider_degraded_minimum_calls` is five and block
    -- 6 reads this provider. Four would have been a real outage the queue
    -- correctly ignored, which is block 5's point rather than this one's.
    PERFORM record_provider_call('p37down', 'issueCard', 'succeeded');

    SELECT failures, failure_percent INTO v_failures, v_percent
      FROM provider_health_recent WHERE provider = 'p37down';

    IF v_failures <> 3 THEN
        RAISE EXCEPTION 'TEST FAILED: expected three failures, found %', v_failures;
    END IF;
    IF v_percent <> 60 THEN
        RAISE EXCEPTION 'TEST FAILED: three of five failing came out as % percent, not 60',
            v_percent;
    END IF;
    RAISE NOTICE 'PASS: the three that mean something are counted';
END $$;

\echo '=== 3. Calls are BUCKETED, not one row each ==='
-- A row per call is a log, and 015 records what happens to a table that
-- becomes one: a single bad afternoon buries the row that matters.
DO $$
DECLARE v_rows INT; v_attempts INT; v_i INT;
BEGIN
    FOR v_i IN 1..50 LOOP
        PERFORM record_provider_call('p37busy', 'send', 'succeeded');
    END LOOP;

    SELECT count(*), max(attempts) INTO v_rows, v_attempts
      FROM provider_health WHERE provider = 'p37busy';

    IF v_rows <> 1 THEN
        RAISE EXCEPTION 'TEST FAILED: fifty calls wrote % rows', v_rows;
    END IF;
    IF v_attempts <> 50 THEN
        RAISE EXCEPTION 'TEST FAILED: the bucket counted % of fifty calls', v_attempts;
    END IF;
    RAISE NOTICE 'PASS: one row a minute, whatever the traffic';
END $$;

\echo '=== 4. Each OPERATION is judged separately ==='
-- One broken endpoint is a different incident from a provider being down, and
-- the fix is different too. Averaged together, a healthy endpoint hides a
-- broken one.
DO $$
DECLARE v_broken INT; v_fine INT;
BEGIN
    PERFORM record_provider_call('p37split', 'quote', 'succeeded');
    PERFORM record_provider_call('p37split', 'quote', 'succeeded');
    PERFORM record_provider_call('p37split', 'execute', 'unavailable', 'down');
    PERFORM record_provider_call('p37split', 'execute', 'unavailable', 'down');

    SELECT failure_percent INTO v_broken FROM provider_health_recent
     WHERE provider = 'p37split' AND operation = 'execute';
    SELECT failure_percent INTO v_fine FROM provider_health_recent
     WHERE provider = 'p37split' AND operation = 'quote';

    IF v_broken <> 100 OR v_fine <> 0 THEN
        RAISE EXCEPTION 'TEST FAILED: a broken endpoint averaged into a healthy one (% / %)',
            v_broken, v_fine;
    END IF;
    RAISE NOTICE 'PASS: a broken endpoint is visible next to a working one';
END $$;

\echo '=== 5. One failure out of one is NOT degraded ==='
-- A 100% failure rate over a single call says nothing, and a quiet endpoint
-- reading as an outage is how the queue becomes noise.
DO $$
DECLARE v_n INT;
BEGIN
    PERFORM record_provider_call('p37quiet', 'rare', 'unavailable', 'one bad call');

    SELECT count(*) INTO v_n FROM provider_degraded WHERE provider = 'p37quiet';
    IF v_n <> 0 THEN
        RAISE EXCEPTION 'TEST FAILED: one failed call out of one was called an outage';
    END IF;
    RAISE NOTICE 'PASS: a rate needs enough calls to mean anything';
END $$;

\echo '=== 6. And enough of them IS ==='
DO $$
DECLARE v_n INT; v_contract BOOLEAN;
BEGIN
    SELECT count(*) INTO v_n FROM provider_degraded WHERE provider = 'p37down';
    IF v_n = 0 THEN
        RAISE EXCEPTION 'TEST FAILED: three of five failing is not reported as degraded';
    END IF;

    SELECT contract_broken INTO v_contract FROM provider_degraded
     WHERE provider = 'p37down' AND operation = 'issueCard';
    -- The one that pages: they changed their API and the same request will
    -- fail for ever, so no amount of waiting fixes it.
    IF NOT v_contract THEN
        RAISE EXCEPTION 'TEST FAILED: an unparseable reply is not marked apart';
    END IF;
    RAISE NOTICE 'PASS: a real outage is on the queue, and a contract break stands out';
END $$;

\echo '=== 7. A rejection-heavy provider is NEVER degraded ==='
-- The same point as block 1, at the level that actually pages somebody.
DO $$
DECLARE v_i INT; v_n INT;
BEGIN
    FOR v_i IN 1..40 LOOP
        PERFORM record_provider_call('p37declines', 'authorize', 'rejected', 'declined');
    END LOOP;

    SELECT count(*) INTO v_n FROM provider_degraded WHERE provider = 'p37declines';
    IF v_n <> 0 THEN
        RAISE EXCEPTION 'TEST FAILED: forty declines paged somebody about an outage';
    END IF;
    RAISE NOTICE 'PASS: a bad day for customers is not an outage';
END $$;

\echo '=== 8. A success does not ERASE the last failure message ==='
-- It is the thing somebody reads first, and a provider that recovers for one
-- call in the middle of an incident should not blank it.
DO $$
DECLARE v_error TEXT;
BEGIN
    PERFORM record_provider_call('p37msg', 'send', 'unavailable', 'connection refused');
    PERFORM record_provider_call('p37msg', 'send', 'succeeded');

    SELECT last_error INTO v_error FROM provider_health_recent WHERE provider = 'p37msg';
    IF v_error IS DISTINCT FROM 'connection refused' THEN
        RAISE EXCEPTION 'TEST FAILED: the failure message was lost (%)', v_error;
    END IF;
    RAISE NOTICE 'PASS: what went wrong survives a recovery';
END $$;

\echo '=== 9. There is NO automatic disable ==='
-- A decision, not a gap. A flapping provider would disable a flow nobody
-- meant to stop; re-enabling needs a person anyway, so the automation only
-- adds a surprise; and the switches exist to be used deliberately during an
-- incident by somebody who understands it.
DO $$
DECLARE v_crypto TEXT; v_cards TEXT; v_n INT;
BEGIN
    SELECT count(*) INTO v_n FROM provider_degraded;
    IF v_n = 0 THEN
        RAISE EXCEPTION 'TEST FAILED: nothing is degraded, so this proves nothing';
    END IF;

    SELECT value INTO v_crypto FROM platform_settings WHERE key = 'crypto_enabled';
    SELECT value INTO v_cards  FROM platform_settings WHERE key = 'cards_enabled';
    IF v_crypto <> 'true' OR v_cards <> 'true' THEN
        RAISE EXCEPTION 'TEST FAILED: a degraded provider switched a flow off by itself';
    END IF;
    RAISE NOTICE 'PASS: noticing is automatic and deciding is not';
END $$;

\echo '=== 10. It reaches the OVERVIEW ==='
-- 036 exists so a view reporting a problem cannot be added without wiring it
-- up. This is that check applied to the view this file adds.
DO $$
DECLARE v_waiting BIGINT; v_decision TEXT;
BEGIN
    SELECT decision INTO v_decision FROM attention_sources WHERE source = 'provider_degraded';
    IF v_decision <> 'queue' THEN
        RAISE EXCEPTION 'TEST FAILED: provider health is not declared a queue';
    END IF;

    SELECT waiting INTO v_waiting FROM admin_work_queue WHERE queue = 'provider_degraded';
    IF v_waiting IS NULL THEN
        RAISE EXCEPTION 'TEST FAILED: a failing provider is not on the overview';
    END IF;
    IF v_waiting = 0 THEN
        RAISE EXCEPTION 'TEST FAILED: the overview says nothing is wrong';
    END IF;
    RAISE NOTICE 'PASS: an operator sees it without knowing the view exists';
END $$;

\echo '=== 11. provider_health has a retention DECISION ==='
DO $$
DECLARE v_decision TEXT;
BEGIN
    SELECT decision INTO v_decision FROM retention_decisions WHERE table_name = 'provider_health';
    IF v_decision <> 'purge' THEN
        RAISE EXCEPTION 'TEST FAILED: minute buckets are kept for ever';
    END IF;
    RAISE NOTICE 'PASS: counts age out';
END $$;
