-- ===========================================================================
--  Xetral — attention coverage invariants
--  packages/ledger/sql/036_attention.test.sql
-- ===========================================================================

\set QUIET on
\pset format unaligned
\pset tuples_only on

\echo '=== 1. EVERY view is classified ==='
-- The whole point. `admin_work_queue` named five sources and was written
-- before disputes, monitoring, cases, stuck card holds, consent, data
-- requests and three drift views existed — so an operator saw five empty
-- queues and concluded there was nothing to do. An incomplete list that looks
-- complete is trusted.
DO $$
DECLARE v_undecided TEXT;
BEGIN
    SELECT string_agg(source, ', ') INTO v_undecided
      FROM attention_coverage WHERE decision = 'UNDECIDED';
    IF v_undecided IS NOT NULL THEN
        RAISE EXCEPTION 'TEST FAILED: nobody said what these views are for: %', v_undecided;
    END IF;
    RAISE NOTICE 'PASS: a new view cannot be forgotten';
END $$;

\echo '=== 2. And no classification describes a view that is gone ==='
-- A list describing a surface that is not there invites the reader to stop
-- trusting it — the argument route-coverage.test.ts makes about routes.
DO $$
DECLARE v_orphaned TEXT;
BEGIN
    SELECT string_agg(source, ', ') INTO v_orphaned
      FROM attention_coverage WHERE decision = 'ORPHANED';
    IF v_orphaned IS NOT NULL THEN
        RAISE EXCEPTION 'TEST FAILED: classified but does not exist: %', v_orphaned;
    END IF;
    RAISE NOTICE 'PASS: the list describes what is actually there';
END $$;

\echo '=== 3. Every QUEUE reaches the overview ==='
-- The failure that started this: a view reporting a problem, and no way to
-- see it without knowing the view exists.
DO $$
DECLARE v_missing TEXT;
BEGIN
    SELECT string_agg(a.queue_name, ', ') INTO v_missing
      FROM attention_sources a
     WHERE a.decision = 'queue'
       AND NOT EXISTS (SELECT 1 FROM admin_work_queue q WHERE q.queue = a.queue_name);
    IF v_missing IS NOT NULL THEN
        RAISE EXCEPTION 'TEST FAILED: queues nobody can see: %', v_missing;
    END IF;
    RAISE NOTICE 'PASS: what is waiting is on the overview';
END $$;

\echo '=== 4. And the overview shows nothing that is not a declared queue ==='
-- The other direction. A row on the overview with no source behind it is a
-- number nobody can explain or act on.
DO $$
DECLARE v_extra TEXT;
BEGIN
    SELECT string_agg(q.queue, ', ') INTO v_extra
      FROM admin_work_queue q
     WHERE NOT EXISTS (
            SELECT 1 FROM attention_sources a
             WHERE a.decision = 'queue' AND a.queue_name = q.queue);
    IF v_extra IS NOT NULL THEN
        RAISE EXCEPTION 'TEST FAILED: overview rows with no declared source: %', v_extra;
    END IF;
    RAISE NOTICE 'PASS: every number on the overview has a source';
END $$;

\echo '=== 5. A queue reports ZERO rather than nothing ==='
-- Every arm is an unconditional aggregate, so an empty queue still
-- contributes a row. "consent: 0 waiting" says the queue was checked; an
-- absent row says nothing at all, and the two look identical on a dashboard.
DO $$
DECLARE v_n INT; v_declared INT;
BEGIN
    SELECT count(*) INTO v_n FROM admin_work_queue;
    SELECT count(*) INTO v_declared FROM attention_sources WHERE decision = 'queue';
    IF v_n <> v_declared THEN
        RAISE EXCEPTION 'TEST FAILED: % rows for % declared queues — an empty one vanished',
            v_n, v_declared;
    END IF;
    RAISE NOTICE 'PASS: an empty queue still says so';
END $$;

\echo '=== 6. The overview grew from FIVE ==='
-- Guards the fix itself. Phase 12 shipped five sources and seven phases added
-- queues that never reached it; a regression that quietly dropped them back
-- would look exactly like the original bug.
DO $$
DECLARE v_n INT;
BEGIN
    SELECT count(*) INTO v_n FROM admin_work_queue;
    IF v_n < 20 THEN
        RAISE EXCEPTION 'TEST FAILED: only % queues on the overview', v_n;
    END IF;
    RAISE NOTICE 'PASS: % queues, not five', v_n;
END $$;

\echo '=== 7. A queue must be NAMED, and a non-queue must not be ==='
-- The two halves cannot drift: a source marked as a queue with no name would
-- be invisible on the overview, and a name on something nobody works would
-- put a permanent row on it.
DO $$
BEGIN
    INSERT INTO attention_sources (source, decision, queue_name, rationale)
    VALUES ('p36_unnamed', 'queue', NULL, 'a queue that nothing could display');
    RAISE EXCEPTION 'TEST FAILED: a queue with no name on the overview';
EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS: a queue is something you can see';
END $$;

DO $$
BEGIN
    INSERT INTO attention_sources (source, decision, queue_name, rationale)
    VALUES ('p36_named', 'watch', 'somewhere', 'informational, and yet named as a queue');
    RAISE EXCEPTION 'TEST FAILED: something nobody works has a queue name';
EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS: only a queue is a queue';
END $$;

\echo '=== 8. A classification must say WHY ==='
-- 'internal' is the cheap answer, and a one-word rationale is how a view that
-- does need working gets filed under it.
DO $$
BEGIN
    INSERT INTO attention_sources (source, decision, queue_name, rationale)
    VALUES ('p36_terse', 'internal', NULL, 'internal');
    RAISE EXCEPTION 'TEST FAILED: a view was classified with one word';
EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS: every decision is explained';
END $$;

\echo '=== 9. A real queue actually FILLS ==='
-- Guards the wiring rather than the list: every assertion above would pass
-- against a view that can never return a row.
DO $$
DECLARE v_before BIGINT; v_after BIGINT;
BEGIN
    SELECT waiting INTO v_before FROM admin_work_queue WHERE queue = 'consent';

    INSERT INTO users (email, status) VALUES ('p36-waiting@example.ng', 'active');

    SELECT waiting INTO v_after FROM admin_work_queue WHERE queue = 'consent';
    IF v_after <= v_before THEN
        RAISE EXCEPTION 'TEST FAILED: a customer who has agreed to nothing is not waiting';
    END IF;
    RAISE NOTICE 'PASS: the overview moves when something needs doing';
END $$;
