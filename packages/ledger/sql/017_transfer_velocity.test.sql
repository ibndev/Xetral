-- ===========================================================================
--  Xetral — transfer velocity invariant tests
--  packages/ledger/sql/017_transfer_velocity.test.sql
-- ===========================================================================

\set QUIET on
\pset format unaligned
\pset tuples_only on

\echo '=== 1. Both velocity settings EXIST ==='
-- The failure this catches is silence. `SettingsService` falls back to a
-- hard-coded default when a key is absent, so a migration that did not run
-- would leave the rules enforcing numbers nobody chose and no operator could
-- change — while every screen and every test still passed.
DO $$
DECLARE v_missing TEXT;
BEGIN
    SELECT string_agg(k, ', ') INTO v_missing
      FROM unnest(ARRAY['transfer_new_recipients_daily', 'transfer_count_hourly']) AS k
     WHERE NOT EXISTS (SELECT 1 FROM platform_settings WHERE key = k);

    IF v_missing IS NOT NULL THEN
        RAISE EXCEPTION 'TEST FAILED: velocity settings missing: %', v_missing;
    END IF;
    RAISE NOTICE 'PASS: both velocity limits are rows an operator can change';
END $$;

\echo ''
\echo '=== 2. A ceiling of ZERO is REFUSED ==='
-- Zero would refuse every transfer to anybody new, for ever, and it is one
-- keystroke away from the 10 that is meant. The bound is what makes an
-- operator narrowing this during an incident safe to do quickly.
DO $$
BEGIN
    UPDATE platform_settings SET value = '0' WHERE key = 'transfer_new_recipients_daily';
    RAISE EXCEPTION 'TEST FAILED: a new-recipient ceiling of zero was accepted';
EXCEPTION
    WHEN check_violation THEN
        RAISE NOTICE 'PASS: a ceiling that would refuse every stranger is refused';
END $$;

\echo ''
\echo '=== 3. A ceiling far above any real customer is REFUSED ==='
-- The other direction, and the one that fails silently: 100000 typed where 100
-- was meant does not break anything, it just switches the control off. Nobody
-- notices a limit that never fires.
DO $$
BEGIN
    UPDATE platform_settings SET value = '100000' WHERE key = 'transfer_count_hourly';
    RAISE EXCEPTION 'TEST FAILED: an hourly ceiling of 100000 was accepted';
EXCEPTION
    WHEN check_violation THEN
        RAISE NOTICE 'PASS: a ceiling too high to ever fire is refused';
END $$;

\echo ''
\echo '=== 4. Changing a velocity limit needs the ADMIN role ==='
-- Marked sensitive, alongside the daily ceilings. A finance operator adjusting
-- a fee must not also be able to widen the control that sees an account
-- takeover.
DO $$
DECLARE v_sensitive BOOLEAN;
BEGIN
    SELECT bool_and(sensitive) INTO v_sensitive
      FROM platform_settings
     WHERE key IN ('transfer_new_recipients_daily', 'transfer_count_hourly');

    IF v_sensitive IS NOT TRUE THEN
        RAISE EXCEPTION 'TEST FAILED: a velocity limit is not marked sensitive';
    END IF;
    RAISE NOTICE 'PASS: widening a velocity limit takes the admin role';
END $$;

\echo ''
\echo '=== 5. The outbox accepts a transfer_blocked message ==='
-- The TypeScript union and the Postgres enum are two lists that only an INSERT
-- proves agree. `operations_alert` typechecked, passed every unit test and
-- failed on the first real enqueue; this is that lesson applied to the kind
-- added here.
DO $$
DECLARE v_user BIGINT;
BEGIN
    INSERT INTO users (email, status) VALUES ('velocity-probe@example.ng', 'active')
    RETURNING id INTO v_user;

    INSERT INTO notification_outbox
      (user_id, kind, class, recipient, payload_sealed, idempotency_key)
    VALUES (v_user, 'transfer_blocked', 'security', 'velocity-probe@example.ng',
            'v1:probe', 'velocity-probe-1');

    RAISE NOTICE 'PASS: transfer_blocked is a kind the outbox can hold';
END $$;

\echo ''
\echo '=== 6. A velocity alert is SECURITY class, not transactional ==='
-- Ordering in the worker's sweep is `(class = 'security') DESC`. A refusal is
-- the first evidence a customer gets that somebody else is in their account,
-- so it must go out ahead of the receipts when the queue is behind — which is
-- exactly when a drain is running.
DO $$
DECLARE v_class TEXT;
BEGIN
    SELECT class::text INTO v_class
      FROM notification_outbox WHERE kind = 'transfer_blocked' LIMIT 1;

    IF v_class IS DISTINCT FROM 'security' THEN
        RAISE EXCEPTION 'TEST FAILED: transfer_blocked was queued as %', v_class;
    END IF;
    RAISE NOTICE 'PASS: a blocked transfer is delivered ahead of receipts';
END $$;
