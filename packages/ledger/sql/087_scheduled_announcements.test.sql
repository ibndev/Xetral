-- ============================================================================
--  087 invariants — a scheduled announcement, and calling one back
-- ============================================================================
\set ON_ERROR_STOP on

BEGIN;

DO $$
DECLARE
    v_staff  BIGINT;
    v_later  BIGINT;
    v_now    BIGINT;
    v_waiting BIGINT;
BEGIN
    INSERT INTO users (email, status, country) VALUES ('p87-staff@example.ng', 'active', 'NG')
    RETURNING id INTO v_staff;

    -- 1. A broadcast written without a time is due now.
    INSERT INTO push_broadcasts (title, body, created_by)
    VALUES ('p87 now', 'due immediately', v_staff) RETURNING id INTO v_now;
    IF (SELECT send_at > now() FROM push_broadcasts WHERE id = v_now) THEN
        RAISE EXCEPTION 'TEST FAILED: an unscheduled broadcast is not due now';
    END IF;

    -- 2. A scheduled one is not stuck while it waits.
    SELECT waiting INTO v_waiting FROM push_broadcasts_stuck;
    INSERT INTO push_broadcasts (title, body, created_by, send_at)
    VALUES ('p87 later', 'tonight at eleven', v_staff, now() + interval '6 hours')
    RETURNING id INTO v_later;
    IF (SELECT waiting FROM push_broadcasts_stuck) <> v_waiting THEN
        RAISE EXCEPTION 'TEST FAILED: a broadcast scheduled for later counts as stuck';
    END IF;

    -- 3. Backdated and far-future times are refused.
    BEGIN
        INSERT INTO push_broadcasts (title, body, created_by, send_at)
        VALUES ('p87 past', 'backdated', v_staff, now() - interval '1 day');
        RAISE EXCEPTION 'TEST FAILED: a backdated broadcast was accepted';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
    BEGIN
        INSERT INTO push_broadcasts (title, body, created_by, send_at)
        VALUES ('p87 far', 'next season', v_staff, now() + interval '60 days');
        RAISE EXCEPTION 'TEST FAILED: a broadcast two months out was accepted';
    EXCEPTION WHEN check_violation THEN NULL;
    END;

    -- 4. The time is immutable.
    BEGIN
        UPDATE push_broadcasts SET send_at = now() + interval '1 hour' WHERE id = v_later;
        RAISE EXCEPTION 'TEST FAILED: a scheduled time was moved';
    EXCEPTION WHEN raise_exception THEN
        IF SQLERRM LIKE 'TEST FAILED%' THEN RAISE; END IF;
    END;

    -- 5. A due broadcast cannot be cancelled; a waiting one can, once.
    BEGIN
        UPDATE push_broadcasts SET cancelled_at = now() WHERE id = v_now;
        RAISE EXCEPTION 'TEST FAILED: a due broadcast was cancelled';
    EXCEPTION WHEN raise_exception THEN
        IF SQLERRM LIKE 'TEST FAILED%' THEN RAISE; END IF;
    END;
    UPDATE push_broadcasts SET cancelled_at = now() WHERE id = v_later;
    BEGIN
        UPDATE push_broadcasts SET sent_at = now() WHERE id = v_later;
        RAISE EXCEPTION 'TEST FAILED: a cancelled broadcast was sent';
    EXCEPTION WHEN raise_exception OR check_violation THEN
        IF SQLERRM LIKE 'TEST FAILED%' THEN RAISE; END IF;
    END;

    RAISE NOTICE 'PASS: scheduled broadcasts wait, cannot be moved, and cancel only while waiting';
END $$;

ROLLBACK;
