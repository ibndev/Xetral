-- ============================================================================
--  065 invariants — push devices and broadcasts
--
--  Run against a database with every migration applied, in order. Not
--  idempotent: it inserts its own fixtures.
-- ============================================================================

\set ON_ERROR_STOP on

BEGIN;

-- Two customers, one in Nigeria and one in Ghana, and a member of staff to
-- send from.
INSERT INTO users (email, phone, status, country, full_name)
VALUES ('p65-ng@example.ng', '+2348065000001', 'active', 'NG', 'Push NG'),
       ('p65-gh@example.gh', '+233240650001',  'active', 'GH', 'Push GH'),
       ('p65-staff@example.ng', '+2348065000003', 'active', 'NG', 'Push Staff');

-- Both customers have agreed to marketing, so the audience question is about
-- the DEVICE rather than about consent except where a block says otherwise.
INSERT INTO consent_records (user_id, kind, document_id, granted, source)
SELECT u.id, 'marketing_email', d.id, TRUE, 'settings'
  FROM users u
  CROSS JOIN LATERAL (
      SELECT id FROM consent_documents
       WHERE kind = 'marketing_email' AND retired_at IS NULL
       LIMIT 1
  ) d
 WHERE u.email IN ('p65-ng@example.ng', 'p65-gh@example.gh');

-- ---------------------------------------------------------------------------
--  1 — a token must look like one the push service issued
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_user BIGINT;
BEGIN
    SELECT id INTO v_user FROM users WHERE email = 'p65-ng@example.ng';
    BEGIN
        INSERT INTO push_devices (user_id, token, platform)
        VALUES (v_user, 'not-a-push-token', 'android');
        RAISE EXCEPTION 'TEST FAILED: a token of any shape was accepted';
    EXCEPTION WHEN check_violation THEN
        RAISE NOTICE 'PASS 1: a token that is not an Expo push token is refused';
    END;
END $$;

-- ---------------------------------------------------------------------------
--  2 — one token belongs to one account, and signing in on a shared handset
--      MOVES it rather than duplicating it
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_ng BIGINT; v_gh BIGINT; v_owner BIGINT; v_rows INT;
BEGIN
    SELECT id INTO v_ng FROM users WHERE email = 'p65-ng@example.ng';
    SELECT id INTO v_gh FROM users WHERE email = 'p65-gh@example.gh';

    INSERT INTO push_devices (user_id, token, platform)
    VALUES (v_ng, 'ExponentPushToken[shared-handset]', 'android');

    -- The second customer signs in on the same handset.
    INSERT INTO push_devices (user_id, token, platform)
    VALUES (v_gh, 'ExponentPushToken[shared-handset]', 'android')
    ON CONFLICT (token) DO UPDATE
       SET user_id = EXCLUDED.user_id,
           revoked_at = NULL,
           last_seen_at = now();

    SELECT count(*) INTO v_rows FROM push_devices
     WHERE token = 'ExponentPushToken[shared-handset]';
    IF v_rows <> 1 THEN
        RAISE EXCEPTION 'TEST FAILED: one token produced % rows', v_rows;
    END IF;

    SELECT user_id INTO v_owner FROM push_devices
     WHERE token = 'ExponentPushToken[shared-handset]';
    IF v_owner <> v_gh THEN
        RAISE EXCEPTION 'TEST FAILED: the handset still points at the previous '
                        'account, so one customer would get another''s alerts';
    END IF;

    RAISE NOTICE 'PASS 2: a token moves to the account that signed in last';
END $$;

-- ---------------------------------------------------------------------------
--  3 — a revoked device is not in the audience, and an ACTIVE one is
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_ng BIGINT; v_seen INT;
BEGIN
    SELECT id INTO v_ng FROM users WHERE email = 'p65-ng@example.ng';

    INSERT INTO push_devices (user_id, token, platform)
    VALUES (v_ng, 'ExponentPushToken[ng-live]', 'ios'),
           (v_ng, 'ExponentPushToken[ng-gone]', 'ios');
    UPDATE push_devices SET revoked_at = now()
     WHERE token = 'ExponentPushToken[ng-gone]';

    SELECT count(*) INTO v_seen FROM push_audience
     WHERE token = 'ExponentPushToken[ng-live]';
    IF v_seen <> 1 THEN
        RAISE EXCEPTION 'TEST FAILED: a live handset is not in the audience';
    END IF;

    SELECT count(*) INTO v_seen FROM push_audience
     WHERE token = 'ExponentPushToken[ng-gone]';
    IF v_seen <> 0 THEN
        RAISE EXCEPTION 'TEST FAILED: a revoked handset is still in the audience';
    END IF;

    RAISE NOTICE 'PASS 3: the audience is live handsets only';
END $$;

-- ---------------------------------------------------------------------------
--  4 — NO MARKETING GRANT MEANS NOT IN THE AUDIENCE, which is the whole
--      reason this view exists rather than a JOIN written twice
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_user BIGINT; v_doc BIGINT; v_seen INT;
BEGIN
    INSERT INTO users (email, phone, status, country, full_name)
    VALUES ('p65-quiet@example.ng', '+2348065000004', 'active', 'NG', 'No Thanks')
    RETURNING id INTO v_user;

    INSERT INTO push_devices (user_id, token, platform)
    VALUES (v_user, 'ExponentPushToken[quiet]', 'android');

    -- Never granted at all.
    SELECT count(*) INTO v_seen FROM push_audience WHERE user_id = v_user;
    IF v_seen <> 0 THEN
        RAISE EXCEPTION 'TEST FAILED: a customer who never opted in is in the '
                        'audience — the consent would be a checkbox';
    END IF;

    -- Granted, then withdrawn. A withdrawal is a NEW ROW, never an edit, so
    -- this is also the assertion that `customer_consents` is being read as the
    -- current position rather than as "has ever granted".
    SELECT id INTO v_doc FROM consent_documents
     WHERE kind = 'marketing_email' AND retired_at IS NULL LIMIT 1;
    INSERT INTO consent_records (user_id, kind, document_id, granted, source)
    VALUES (v_user, 'marketing_email', v_doc, TRUE, 'settings');

    SELECT count(*) INTO v_seen FROM push_audience WHERE user_id = v_user;
    IF v_seen <> 1 THEN
        RAISE EXCEPTION 'TEST FAILED: a customer who opted in is not reachable';
    END IF;

    INSERT INTO consent_records (user_id, kind, document_id, granted, source)
    VALUES (v_user, 'marketing_email', v_doc, FALSE, 'settings');

    SELECT count(*) INTO v_seen FROM push_audience WHERE user_id = v_user;
    IF v_seen <> 0 THEN
        RAISE EXCEPTION 'TEST FAILED: a withdrawn grant still reaches the '
                        'handset — unsubscribing did nothing';
    END IF;

    RAISE NOTICE 'PASS 4: the audience is gated on a LIVE marketing grant, '
                 'both directions';
END $$;

-- ---------------------------------------------------------------------------
--  5 — a frozen customer is not in the audience
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_gh BIGINT; v_seen INT;
BEGIN
    SELECT id INTO v_gh FROM users WHERE email = 'p65-gh@example.gh';
    UPDATE users SET status = 'frozen' WHERE id = v_gh;

    SELECT count(*) INTO v_seen FROM push_audience WHERE user_id = v_gh;
    IF v_seen <> 0 THEN
        RAISE EXCEPTION 'TEST FAILED: a frozen account is still being messaged';
    END IF;

    UPDATE users SET status = 'active' WHERE id = v_gh;
    RAISE NOTICE 'PASS 5: a frozen account is out of the audience';
END $$;

-- ---------------------------------------------------------------------------
--  6 — the words and the audience of a broadcast are immutable
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_staff BIGINT; v_id BIGINT;
BEGIN
    SELECT id INTO v_staff FROM users WHERE email = 'p65-staff@example.ng';

    INSERT INTO push_broadcasts (title, body, created_by)
    VALUES ('Scheduled maintenance', 'Xetral will be briefly unavailable tonight.', v_staff)
    RETURNING id INTO v_id;

    BEGIN
        UPDATE push_broadcasts SET body = 'Something else entirely' WHERE id = v_id;
        RAISE EXCEPTION 'TEST FAILED: a broadcast''s words were rewritten after '
                        'it was written';
    EXCEPTION WHEN raise_exception THEN
        IF SQLERRM LIKE 'TEST FAILED%' THEN RAISE; END IF;
        RAISE NOTICE 'PASS 6: what was sent is what was sent';
    END;
END $$;

-- ---------------------------------------------------------------------------
--  7 — a sent broadcast cannot be sent again
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_staff BIGINT; v_id BIGINT;
BEGIN
    SELECT id INTO v_staff FROM users WHERE email = 'p65-staff@example.ng';

    INSERT INTO push_broadcasts (title, body, created_by)
    VALUES ('A new corridor', 'You can now send money to Kenya.', v_staff)
    RETURNING id INTO v_id;

    UPDATE push_broadcasts
       SET sent_at = now(), devices = 3, accepted = 3
     WHERE id = v_id;

    BEGIN
        UPDATE push_broadcasts SET accepted = 4 WHERE id = v_id;
        RAISE EXCEPTION 'TEST FAILED: a broadcast already sent was written to '
                        'again, which is how one announcement becomes two';
    EXCEPTION WHEN raise_exception THEN
        IF SQLERRM LIKE 'TEST FAILED%' THEN RAISE; END IF;
        RAISE NOTICE 'PASS 7: a broadcast is drained exactly once';
    END;
END $$;

-- ---------------------------------------------------------------------------
--  8 — a broadcast cannot be deleted
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_staff BIGINT; v_id BIGINT;
BEGIN
    SELECT id INTO v_staff FROM users WHERE email = 'p65-staff@example.ng';
    INSERT INTO push_broadcasts (title, body, created_by)
    VALUES ('Rates updated', 'Our naira to cedi rate has improved.', v_staff)
    RETURNING id INTO v_id;

    BEGIN
        DELETE FROM push_broadcasts WHERE id = v_id;
        RAISE EXCEPTION 'TEST FAILED: the record of what customers were told '
                        'was deleted';
    EXCEPTION WHEN raise_exception THEN
        IF SQLERRM LIKE 'TEST FAILED%' THEN RAISE; END IF;
        RAISE NOTICE 'PASS 8: what this business said is kept';
    END;
END $$;

-- ---------------------------------------------------------------------------
--  9 — counts that do not add up are refused
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_staff BIGINT; v_id BIGINT;
BEGIN
    SELECT id INTO v_staff FROM users WHERE email = 'p65-staff@example.ng';
    INSERT INTO push_broadcasts (title, body, created_by)
    VALUES ('A report that lies', 'Nothing to see here.', v_staff)
    RETURNING id INTO v_id;

    BEGIN
        UPDATE push_broadcasts
           SET sent_at = now(), devices = 2, accepted = 5
         WHERE id = v_id;
        RAISE EXCEPTION 'TEST FAILED: more handsets accepted than were tried';
    EXCEPTION WHEN check_violation THEN
        RAISE NOTICE 'PASS 9: a report that does not add up is refused';
    END;
END $$;

-- ---------------------------------------------------------------------------
--  10 — an unwritten broadcast is what `push_broadcasts_stuck` counts
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_waiting BIGINT;
BEGIN
    SELECT waiting INTO v_waiting FROM push_broadcasts_stuck;
    IF v_waiting < 1 THEN
        RAISE EXCEPTION 'TEST FAILED: a broadcast nothing has drained is '
                        'invisible, which is the silent failure this view '
                        'exists for';
    END IF;
    RAISE NOTICE 'PASS 10: a broadcast nobody drained is visible';
END $$;

-- ---------------------------------------------------------------------------
--  11 — a live token is never purged, however old; a revoked one ages out
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_user BIGINT; v_live INT;
BEGIN
    SELECT id INTO v_user FROM users WHERE email = 'p65-ng@example.ng';

    INSERT INTO push_devices (user_id, token, platform, created_at, last_seen_at)
    VALUES (v_user, 'ExponentPushToken[ancient-live]', 'ios',
            now() - interval '5 years', now() - interval '5 years');
    INSERT INTO push_devices (user_id, token, platform, created_at, revoked_at)
    VALUES (v_user, 'ExponentPushToken[ancient-gone]', 'ios',
            now() - interval '5 years', now() - interval '5 years');

    PERFORM apply_retention();

    SELECT count(*) INTO v_live FROM push_devices
     WHERE token = 'ExponentPushToken[ancient-live]';
    IF v_live <> 1 THEN
        RAISE EXCEPTION 'TEST FAILED: a handset still in somebody''s pocket was '
                        'deleted, so that customer is now unreachable';
    END IF;

    SELECT count(*) INTO v_live FROM push_devices
     WHERE token = 'ExponentPushToken[ancient-gone]';
    IF v_live <> 0 THEN
        RAISE EXCEPTION 'TEST FAILED: a token revoked five years ago is still '
                        'held';
    END IF;

    RAISE NOTICE 'PASS 11: the window is measured from revocation, not creation';
END $$;

ROLLBACK;
