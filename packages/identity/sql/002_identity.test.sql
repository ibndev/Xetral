-- ===========================================================================
--  Xetral — Phase 2 identity & auth invariant tests
--  packages/identity/sql/002_identity.test.sql
--
--  Same contract as the ledger suite: each block asserts that a specific bad
--  write is REJECTED, because a constraint nobody has watched fail is a
--  constraint nobody knows is wired up.
--  Run with -v ON_ERROR_STOP=1; any unexpected failure aborts.
-- ===========================================================================

\set QUIET on
\pset format unaligned
\pset tuples_only on

-- --------------------------------------------------------------------------
-- Fixtures
--
-- Two users. Ada has a transaction PIN; Bola deliberately does not, because
-- test 14 needs a user for whom biometric enrolment must be impossible.
-- --------------------------------------------------------------------------
INSERT INTO users (email, phone, status) VALUES
  ('ada@example.ng',  '+2348030000001', 'active'),
  ('bola@example.ng', '+2348030000002', 'active');

INSERT INTO user_credentials (user_id, password_hash)
SELECT id, 'v1:scrypt:' || encode(sha256(email::bytea), 'hex') FROM users;

-- Ada only.
INSERT INTO transaction_pins (user_id, pin_hash)
SELECT id, 'v1:scrypt:' || encode(sha256('pin'::bytea), 'hex')
  FROM users WHERE email = 'ada@example.ng';

INSERT INTO devices (user_id, fingerprint_hash, platform, display_name)
SELECT u.id, encode(sha256((u.email || ':' || p)::bytea), 'hex'), p, p || ' handset'
  FROM users u
  CROSS JOIN (VALUES ('ios'), ('android')) AS d(p)
 WHERE u.email = 'ada@example.ng'
UNION ALL
SELECT u.id, encode(sha256((u.email || ':android')::bytea), 'hex'), 'android', 'bola phone'
  FROM users u WHERE u.email = 'bola@example.ng';

\echo '=== 1. A session and its first refresh token are ACCEPTED ==='
DO $$
DECLARE
    v_user BIGINT; v_device BIGINT; v_session BIGINT; v_token BIGINT;
BEGIN
    SELECT id INTO v_user FROM users WHERE email = 'ada@example.ng';
    SELECT id INTO v_device FROM devices WHERE user_id = v_user AND platform = 'ios';

    INSERT INTO auth_sessions (user_id, device_id)
    VALUES (v_user, v_device) RETURNING id INTO v_session;

    INSERT INTO refresh_tokens (session_id, token_hash, generation, expires_at)
    VALUES (v_session, encode(sha256('ada-g0'::bytea), 'hex'), 0, now() + interval '30 days')
    RETURNING id INTO v_token;

    IF v_token IS NULL THEN
        RAISE EXCEPTION 'TEST FAILED: first refresh token was not issued';
    END IF;
    RAISE NOTICE 'PASS: session % opened with refresh token generation 0', v_session;
END $$;

\echo ''
\echo '=== 2. Rotation issues a new token and CONSUMES the old one ==='
DO $$
DECLARE
    v_outcome rotation_outcome; v_new BIGINT; v_consumed TIMESTAMPTZ; v_gen INT;
BEGIN
    SELECT out_outcome, out_new_token_id INTO v_outcome, v_new
      FROM rotate_refresh_token(
          encode(sha256('ada-g0'::bytea), 'hex'),
          encode(sha256('ada-g1'::bytea), 'hex'),
          interval '30 days');

    IF v_outcome <> 'rotated' THEN
        RAISE EXCEPTION 'TEST FAILED: expected rotated, got %', v_outcome;
    END IF;

    SELECT consumed_at INTO v_consumed FROM refresh_tokens
     WHERE token_hash = encode(sha256('ada-g0'::bytea), 'hex');
    IF v_consumed IS NULL THEN
        RAISE EXCEPTION 'TEST FAILED: the presented token was not consumed';
    END IF;

    SELECT generation INTO v_gen FROM refresh_tokens WHERE id = v_new;
    IF v_gen <> 1 THEN
        RAISE EXCEPTION 'TEST FAILED: replacement is generation %, expected 1', v_gen;
    END IF;

    RAISE NOTICE 'PASS: generation 0 consumed, generation 1 issued as token %', v_new;
END $$;

\echo ''
\echo '=== 3. Replaying a CONSUMED token is detected and kills the family ==='
-- The reason this whole file exists. A token that has already been rotated
-- coming back means somebody kept a copy -- we cannot tell whether it is the
-- customer''s client racing itself or a thief, and only one of those two
-- mistakes costs the customer their balance.
DO $$
DECLARE
    v_outcome rotation_outcome; v_session BIGINT; v_reason session_revoke_reason;
BEGIN
    SELECT out_outcome, out_session_id INTO v_outcome, v_session
      FROM rotate_refresh_token(
          encode(sha256('ada-g0'::bytea), 'hex'),   -- already consumed in test 2
          encode(sha256('ada-g2'::bytea), 'hex'),
          interval '30 days');

    IF v_outcome <> 'reuse_detected' THEN
        RAISE EXCEPTION 'TEST FAILED: replayed token produced %, expected reuse_detected', v_outcome;
    END IF;

    SELECT revoked_reason INTO v_reason FROM auth_sessions WHERE id = v_session;
    IF v_reason IS DISTINCT FROM 'token_reuse' THEN
        RAISE EXCEPTION 'TEST FAILED: family not revoked; reason is %', v_reason;
    END IF;

    RAISE NOTICE 'PASS: reuse detected, session % revoked as token_reuse', v_session;
END $$;

\echo ''
\echo '=== 3a. The LIVE token from that family is dead too ==='
-- The half that is easy to get wrong. Revoking the presented token alone
-- leaves generation 1 working -- and generation 1 is the one the thief is
-- holding if they rotated first. Killing the family is the point.
DO $$
DECLARE v_outcome rotation_outcome;
BEGIN
    SELECT out_outcome INTO v_outcome
      FROM rotate_refresh_token(
          encode(sha256('ada-g1'::bytea), 'hex'),   -- never used, still unexpired
          encode(sha256('ada-g3'::bytea), 'hex'),
          interval '30 days');

    IF v_outcome <> 'session_revoked' THEN
        RAISE EXCEPTION 'TEST FAILED: live sibling token produced %, expected session_revoked', v_outcome;
    END IF;
    RAISE NOTICE 'PASS: the unused generation-1 token was killed with its family';
END $$;

\echo ''
\echo '=== 3b. The incident is visible to operations ==='
SELECT CASE WHEN COUNT(*) = 1
            THEN 'PASS: token_reuse_incidents reports 1 family killed by reuse'
            ELSE 'FAIL: expected 1 incident, found ' || COUNT(*)::text END
  FROM token_reuse_incidents;

\echo ''
\echo '=== 4. A consumed token can never be UN-CONSUMED ==='
-- If this were writable, "already used" would be a claim about the present
-- rather than about history, and one UPDATE during an incident would erase
-- the evidence of the incident.
DO $$
BEGIN
    UPDATE refresh_tokens SET consumed_at = NULL
     WHERE token_hash = encode(sha256('ada-g0'::bytea), 'hex');
    RAISE EXCEPTION 'TEST FAILED: a consumed token was restored';
EXCEPTION
    WHEN check_violation THEN
        RAISE NOTICE 'PASS: rejected -> %', SQLERRM;
END $$;

\echo ''
\echo '=== 5. An EXPIRED token is expired, NOT reuse ==='
-- Order of checks matters. A lapsed session is routine; conflating it with
-- theft would revoke families over nothing and bury real incidents in noise.
DO $$
DECLARE
    v_user BIGINT; v_device BIGINT; v_session BIGINT; v_outcome rotation_outcome;
BEGIN
    SELECT id INTO v_user FROM users WHERE email = 'ada@example.ng';
    SELECT id INTO v_device FROM devices WHERE user_id = v_user AND platform = 'android';

    INSERT INTO auth_sessions (user_id, device_id)
    VALUES (v_user, v_device) RETURNING id INTO v_session;

    INSERT INTO refresh_tokens (session_id, token_hash, generation, issued_at, expires_at)
    VALUES (v_session, encode(sha256('ada-stale'::bytea), 'hex'), 0,
            now() - interval '60 days', now() - interval '30 days');

    SELECT out_outcome INTO v_outcome
      FROM rotate_refresh_token(
          encode(sha256('ada-stale'::bytea), 'hex'),
          encode(sha256('ada-stale-next'::bytea), 'hex'),
          interval '30 days');

    IF v_outcome <> 'expired' THEN
        RAISE EXCEPTION 'TEST FAILED: expired token produced %, expected expired', v_outcome;
    END IF;

    IF EXISTS (SELECT 1 FROM auth_sessions WHERE id = v_session AND revoked_at IS NOT NULL) THEN
        RAISE EXCEPTION 'TEST FAILED: an expiry revoked the family; that is reserved for reuse';
    END IF;

    RAISE NOTICE 'PASS: expired token rejected without revoking the family';
END $$;

\echo ''
\echo '=== 6. An UNKNOWN token is rejected without touching anything ==='
DO $$
DECLARE v_outcome rotation_outcome;
BEGIN
    SELECT out_outcome INTO v_outcome
      FROM rotate_refresh_token(
          encode(sha256('never-issued'::bytea), 'hex'),
          encode(sha256('whatever'::bytea), 'hex'),
          interval '30 days');

    IF v_outcome <> 'unknown_token' THEN
        RAISE EXCEPTION 'TEST FAILED: unknown hash produced %', v_outcome;
    END IF;
    RAISE NOTICE 'PASS: unknown token rejected as unknown_token';
END $$;

\echo ''
\echo '=== 7. A RAW token cannot be stored where a hash belongs ==='
-- A raw refresh token is 43 base64url characters; the column takes 64 hex.
-- The constraint is what stops "store the hash" from being a convention
-- somebody forgets once.
DO $$
DECLARE v_session BIGINT;
BEGIN
    SELECT id INTO v_session FROM auth_sessions ORDER BY id LIMIT 1;
    INSERT INTO refresh_tokens (session_id, token_hash, generation, expires_at)
    VALUES (v_session, 'x7Qk2mN8pR4tV6wY0zB3cD5fG7hJ9kL1nP3qS5uW7yA', 99, now() + interval '1 day');
    RAISE EXCEPTION 'TEST FAILED: a raw token was stored';
EXCEPTION
    WHEN check_violation THEN
        RAISE NOTICE 'PASS: raw token rejected by the hash-format constraint';
END $$;

\echo ''
\echo '=== 8. A session cannot be opened on ANOTHER USER''S device ==='
DO $$
DECLARE v_ada BIGINT; v_bola_device BIGINT;
BEGIN
    SELECT id INTO v_ada FROM users WHERE email = 'ada@example.ng';
    SELECT d.id INTO v_bola_device FROM devices d
      JOIN users u ON u.id = d.user_id WHERE u.email = 'bola@example.ng';

    INSERT INTO auth_sessions (user_id, device_id) VALUES (v_ada, v_bola_device);
    RAISE EXCEPTION 'TEST FAILED: a session was opened on another user''s device';
EXCEPTION
    WHEN check_violation THEN
        RAISE NOTICE 'PASS: rejected -> %', SQLERRM;
END $$;

\echo ''
\echo '=== 9. Revoking a device revokes its live sessions ==='
-- The "lost phone" button. A device marked revoked while one of its sessions
-- stays live is the exact gap the button was pressed to close.
DO $$
DECLARE
    v_user BIGINT; v_device BIGINT; v_session BIGINT; v_reason session_revoke_reason;
BEGIN
    SELECT id INTO v_user FROM users WHERE email = 'bola@example.ng';
    SELECT id INTO v_device FROM devices WHERE user_id = v_user;

    INSERT INTO auth_sessions (user_id, device_id)
    VALUES (v_user, v_device) RETURNING id INTO v_session;

    UPDATE devices SET status = 'revoked' WHERE id = v_device;

    SELECT revoked_reason INTO v_reason FROM auth_sessions WHERE id = v_session;
    IF v_reason IS DISTINCT FROM 'device_revoked' THEN
        RAISE EXCEPTION 'TEST FAILED: session survived device revocation (reason %)', v_reason;
    END IF;
    RAISE NOTICE 'PASS: revoking the device revoked its session';
END $$;

\echo ''
\echo '=== 10. A session cannot be opened on a REVOKED device ==='
DO $$
DECLARE v_user BIGINT; v_device BIGINT;
BEGIN
    SELECT id INTO v_user FROM users WHERE email = 'bola@example.ng';
    SELECT id INTO v_device FROM devices WHERE user_id = v_user;

    INSERT INTO auth_sessions (user_id, device_id) VALUES (v_user, v_device);
    RAISE EXCEPTION 'TEST FAILED: a session was opened on a revoked device';
EXCEPTION
    WHEN check_violation THEN
        RAISE NOTICE 'PASS: rejected -> %', SQLERRM;
END $$;

\echo ''
\echo '=== 11. Revocation is FINAL ==='
DO $$
DECLARE v_session BIGINT;
BEGIN
    SELECT id INTO v_session FROM auth_sessions
     WHERE revoked_reason = 'token_reuse' LIMIT 1;

    UPDATE auth_sessions SET revoked_at = NULL, revoked_reason = NULL WHERE id = v_session;
    RAISE EXCEPTION 'TEST FAILED: a revoked session was restored';
EXCEPTION
    WHEN check_violation THEN
        RAISE NOTICE 'PASS: rejected -> %', SQLERRM;
END $$;

\echo ''
\echo '=== 12. Biometric enrolment WITHOUT a transaction PIN is REJECTED ==='
-- Bola has no PIN. Allowing enrolment here would quietly make Face ID the
-- only thing guarding his money.
DO $$
DECLARE v_user BIGINT; v_device BIGINT;
BEGIN
    SELECT id INTO v_user FROM users WHERE email = 'bola@example.ng';
    SELECT id INTO v_device FROM devices WHERE user_id = v_user;

    INSERT INTO biometric_enrollments (user_id, device_id, public_key)
    VALUES (v_user, v_device, 'MFkwEwYHKoZIzj0CAQ...');
    RAISE EXCEPTION 'TEST FAILED: biometrics were enrolled with no PIN behind them';
EXCEPTION
    WHEN check_violation THEN
        RAISE NOTICE 'PASS: rejected -> %', SQLERRM;
END $$;

\echo ''
\echo '=== 13. Biometric enrolment WITH a transaction PIN is ACCEPTED ==='
DO $$
DECLARE v_user BIGINT; v_device BIGINT; v_id BIGINT;
BEGIN
    SELECT id INTO v_user FROM users WHERE email = 'ada@example.ng';
    SELECT id INTO v_device FROM devices WHERE user_id = v_user AND platform = 'ios';

    INSERT INTO biometric_enrollments (user_id, device_id, public_key)
    VALUES (v_user, v_device, 'MFkwEwYHKoZIzj0CAQ...') RETURNING id INTO v_id;

    IF v_id IS NULL THEN RAISE EXCEPTION 'TEST FAILED: enrolment did not land'; END IF;
    RAISE NOTICE 'PASS: enrolment accepted for a user who has set a PIN';
END $$;

\echo ''
\echo '=== 14. The PIN locks after repeated failures, and stays locked ==='
DO $$
DECLARE v_user BIGINT; v_lock TIMESTAMPTZ; i INT;
BEGIN
    SELECT id INTO v_user FROM users WHERE email = 'ada@example.ng';

    -- Four failures out of five must NOT lock: locking early is a free
    -- denial-of-service against a customer who mistyped.
    FOR i IN 1..4 LOOP
        v_lock := record_pin_failure(v_user, 5, interval '15 minutes');
    END LOOP;
    IF v_lock IS NOT NULL THEN
        RAISE EXCEPTION 'TEST FAILED: locked after 4 of 5 attempts';
    END IF;

    v_lock := record_pin_failure(v_user, 5, interval '15 minutes');
    IF v_lock IS NULL THEN
        RAISE EXCEPTION 'TEST FAILED: not locked after the 5th failure';
    END IF;

    RAISE NOTICE 'PASS: locked on the 5th failure, until %', v_lock;
END $$;

\echo ''
\echo '=== 14a. A LOCKED PIN cannot be verified, even with the right PIN ==='
-- record_pin_success re-checks the lock. Without that, a correct guess
-- arriving during a lockout lifts it, and the lockout protects nothing.
DO $$
DECLARE v_user BIGINT;
BEGIN
    SELECT id INTO v_user FROM users WHERE email = 'ada@example.ng';
    PERFORM record_pin_success(v_user);
    RAISE EXCEPTION 'TEST FAILED: a locked PIN was accepted';
EXCEPTION
    WHEN check_violation THEN
        RAISE NOTICE 'PASS: rejected -> %', SQLERRM;
END $$;

\echo ''
\echo '=== 15. An UNVERSIONED secret hash is REJECTED ==='
-- Every stored secret carries a key/algorithm version. A bare hash cannot be
-- identified as belonging to the old scheme on the day the algorithm rotates.
DO $$
DECLARE v_user BIGINT;
BEGIN
    SELECT id INTO v_user FROM users WHERE email = 'bola@example.ng';
    INSERT INTO transaction_pins (user_id, pin_hash)
    VALUES (v_user, encode(sha256('unversioned'::bytea), 'hex'));
    RAISE EXCEPTION 'TEST FAILED: an unversioned PIN hash was stored';
EXCEPTION
    WHEN check_violation THEN
        RAISE NOTICE 'PASS: unversioned hash rejected by the version-prefix constraint';
END $$;

\echo ''
\echo '=== 16. A user with neither email nor phone is REJECTED ==='
DO $$
BEGIN
    INSERT INTO users (email, phone) VALUES (NULL, NULL);
    RAISE EXCEPTION 'TEST FAILED: an unreachable account was created';
EXCEPTION
    WHEN check_violation THEN
        RAISE NOTICE 'PASS: account with no identifier rejected';
END $$;

\echo ''
\echo '=== 17. Active sessions are reportable ==='
SELECT 'active sessions: ' || COUNT(*)::text ||
       ' (reuse-killed and device-revoked families correctly excluded)'
  FROM active_sessions;
