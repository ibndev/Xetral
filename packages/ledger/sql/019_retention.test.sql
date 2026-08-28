-- ===========================================================================
--  Xetral — data retention invariant tests
--  packages/ledger/sql/019_retention.test.sql
-- ===========================================================================

\set QUIET on
\pset format unaligned
\pset tuples_only on

\echo '=== 1. EVERY table has a stated retention decision ==='
-- The retention analogue of route-coverage.test.ts, and it exists for the same
-- reason: a deletion job is a list of what somebody thought of, and the tables
-- nobody thought of are invisible in it. Those are exactly the ones that
-- accumulate customer data for years.
DO $$
DECLARE v_undecided TEXT;
BEGIN
    SELECT string_agg(table_name, ', ') INTO v_undecided
      FROM retention_coverage WHERE decision = 'UNDECIDED';

    IF v_undecided IS NOT NULL THEN
        RAISE EXCEPTION 'TEST FAILED: no retention decision for: %', v_undecided;
    END IF;
    RAISE NOTICE 'PASS: every table in the schema has a stated retention decision';
END $$;

\echo ''
\echo '=== 2. And no decision names a table that does not exist ==='
-- The other direction, which matters as much: a policy describing a surface
-- that is not there invites the reader to stop trusting the whole document.
DO $$
DECLARE v_orphans TEXT;
BEGIN
    SELECT string_agg(d.table_name, ', ') INTO v_orphans
      FROM retention_decisions d
      LEFT JOIN pg_tables t ON t.tablename = d.table_name AND t.schemaname = 'public'
     WHERE t.tablename IS NULL;

    IF v_orphans IS NOT NULL THEN
        RAISE EXCEPTION 'TEST FAILED: retention decisions for missing tables: %', v_orphans;
    END IF;
    RAISE NOTICE 'PASS: the retention policy describes only tables that exist';
END $$;

\echo ''
\echo '=== 3. Every LEDGER table is decided ''keep'' ==='
-- Stated as an assertion rather than left to the reader of a list. The
-- financial record must never be in the purge set, and a future edit that
-- moved one there would fail here rather than in production.
DO $$
DECLARE v_wrong TEXT;
BEGIN
    SELECT string_agg(table_name || '=' || decision, ', ') INTO v_wrong
      FROM retention_decisions
     WHERE table_name IN ('journal_entries', 'postings', 'accounts')
       AND decision <> 'keep';

    IF v_wrong IS NOT NULL THEN
        RAISE EXCEPTION 'TEST FAILED: a ledger table is not kept: %', v_wrong;
    END IF;
    RAISE NOTICE 'PASS: the financial record is never in the purge set';
END $$;

\echo ''
\echo '=== 4. The sweep DOES NOT TOUCH the ledger ==='
-- The claim that matters most, and it is asserted by counting rather than by
-- reading the function. 011's triggers would refuse a DELETE anyway — this
-- proves the job never even tries, so a sweep can never fail for that reason
-- at 4am against money nobody is watching.
DO $$
DECLARE
    v_entries_before BIGINT; v_postings_before BIGINT;
    v_entries_after  BIGINT; v_postings_after  BIGINT;
BEGIN
    SELECT count(*) INTO v_entries_before  FROM journal_entries;
    SELECT count(*) INTO v_postings_before FROM postings;

    PERFORM apply_retention();

    SELECT count(*) INTO v_entries_after  FROM journal_entries;
    SELECT count(*) INTO v_postings_after FROM postings;

    IF v_entries_after <> v_entries_before OR v_postings_after <> v_postings_before THEN
        RAISE EXCEPTION 'TEST FAILED: the sweep changed the ledger (% -> % entries, % -> % postings)',
              v_entries_before, v_entries_after, v_postings_before, v_postings_after;
    END IF;
    RAISE NOTICE 'PASS: a retention sweep leaves the financial record untouched';
END $$;

\echo ''
\echo '=== 5. It refuses to run with NO SETTINGS rather than guessing ==='
-- A retention job that invents its own periods when the settings are missing
-- is a job that deletes on the strength of a default nobody reviewed.
DO $$
BEGIN
    DELETE FROM platform_settings WHERE key = 'retention_totp_steps_hours';
    PERFORM apply_retention();
    RAISE EXCEPTION 'TEST FAILED: the sweep ran with no configured period';
EXCEPTION
    WHEN OTHERS THEN
        IF SQLERRM LIKE '%TEST FAILED%' THEN RAISE; END IF;
        RAISE NOTICE 'PASS: an unconfigured retention job deletes nothing';
END $$;

\echo ''
\echo '=== 6. A period of ZERO is REFUSED ==='
-- Zero would delete everything the moment it was saved, and it is one
-- keystroke from the number that was meant.
DO $$
BEGIN
    UPDATE platform_settings SET value = '0' WHERE key = 'retention_tokens_days';
    RAISE EXCEPTION 'TEST FAILED: a retention period of zero was accepted';
EXCEPTION
    WHEN check_violation THEN
        RAISE NOTICE 'PASS: a period that would delete everything at once is refused';
END $$;

\echo ''
\echo '=== 7. A LIVE refresh token is never deleted ==='
-- The failure this catches is a housekeeping job signing customers out.
DO $$
DECLARE
    v_user BIGINT; v_device BIGINT; v_session BIGINT; v_live BIGINT; v_still BIGINT;
BEGIN
    INSERT INTO users (email, status) VALUES ('retention-live@example.ng', 'active')
    RETURNING id INTO v_user;
    INSERT INTO devices (user_id, fingerprint_hash, platform)
    VALUES (v_user, repeat('a', 64), 'ios') RETURNING id INTO v_device;
    INSERT INTO auth_sessions (user_id, device_id) VALUES (v_user, v_device)
    RETURNING id INTO v_session;

    -- Created long ago and STILL VALID: exactly the row a naive age-only
    -- delete would take.
    INSERT INTO refresh_tokens (session_id, token_hash, generation, expires_at, issued_at)
    VALUES (v_session, repeat('b', 64), 1, now() + INTERVAL '30 days',
            now() - INTERVAL '400 days')
    RETURNING id INTO v_live;

    PERFORM apply_retention();

    SELECT count(*) INTO v_still FROM refresh_tokens WHERE id = v_live;
    IF v_still <> 1 THEN
        RAISE EXCEPTION 'TEST FAILED: a live refresh token was deleted by retention';
    END IF;
    RAISE NOTICE 'PASS: housekeeping does not sign a customer out';
END $$;

\echo ''
\echo '=== 8. A PENDING notification is never deleted ==='
-- The single worst thing this job could do: silently drop a password reset
-- somebody is waiting on.
DO $$
DECLARE v_user BIGINT; v_msg BIGINT; v_still BIGINT;
BEGIN
    SELECT id INTO v_user FROM users WHERE email = 'retention-live@example.ng';

    INSERT INTO notification_outbox
      (user_id, kind, class, recipient, payload_sealed, idempotency_key, created_at)
    VALUES (v_user, 'password_reset', 'security', 'retention-live@example.ng',
            'v1:sealed', 'retention-pending-1', now() - INTERVAL '400 days')
    RETURNING id INTO v_msg;

    PERFORM apply_retention();

    SELECT count(*) INTO v_still FROM notification_outbox WHERE id = v_msg;
    IF v_still <> 1 THEN
        RAISE EXCEPTION 'TEST FAILED: an undelivered password reset was deleted';
    END IF;
    RAISE NOTICE 'PASS: a message nobody has received is never aged out';
END $$;

\echo ''
\echo '=== 9. An UNRESOLVED error fingerprint is never deleted ==='
-- An open fingerprint is a bug somebody still has to fix, however old.
DO $$
DECLARE v_still BIGINT;
BEGIN
    INSERT INTO error_events (fingerprint, message, severity, first_seen_at, last_seen_at)
    VALUES (repeat('c', 16), 'an old bug nobody fixed', 'error',
            now() - INTERVAL '400 days', now() - INTERVAL '400 days');

    PERFORM apply_retention();

    SELECT count(*) INTO v_still FROM error_events WHERE fingerprint = repeat('c', 16);
    IF v_still <> 1 THEN
        RAISE EXCEPTION 'TEST FAILED: an open error fingerprint was deleted';
    END IF;
    RAISE NOTICE 'PASS: a failure that is still happening is not aged away';
END $$;

\echo ''
\echo '=== 10. What HAS aged out is actually deleted ==='
-- And the converse of every test above: a retention job that deletes nothing
-- is a retention policy on paper.
DO $$
DECLARE v_user BIGINT; v_before BIGINT; v_after BIGINT;
BEGIN
    SELECT id INTO v_user FROM users WHERE email = 'retention-live@example.ng';

    -- A sent message carries its provider id and has NO body: the CHECK
    -- refuses any other shape, which is the outbox saying that a delivered
    -- message has already had its bearer token erased.
    INSERT INTO notification_outbox
      (user_id, kind, class, recipient, idempotency_key, status,
       sent_at, provider, provider_message_id, created_at)
    VALUES (v_user, 'transfer_sent', 'transactional', 'retention-live@example.ng',
            'retention-old-1', 'sent', now() - INTERVAL '400 days',
            'resend', 'msg_probe', now() - INTERVAL '400 days');

    SELECT count(*) INTO v_before FROM notification_outbox
     WHERE idempotency_key = 'retention-old-1';

    PERFORM apply_retention();

    SELECT count(*) INTO v_after FROM notification_outbox
     WHERE idempotency_key = 'retention-old-1';

    IF v_before <> 1 OR v_after <> 0 THEN
        RAISE EXCEPTION 'TEST FAILED: a delivered 400-day-old message survived (% -> %)',
              v_before, v_after;
    END IF;
    RAISE NOTICE 'PASS: what has aged out is really deleted, not merely described';
END $$;
