-- ===========================================================================
--  Xetral — staff second factor invariant tests
--  packages/identity/sql/014_staff_totp.test.sql
--
--  NOT idempotent. Run against a freshly created database, in migration order.
-- ===========================================================================

\set QUIET on
\pset format unaligned
\pset tuples_only on

INSERT INTO users (email, status) VALUES ('totp-operator@example.ng', 'active');
INSERT INTO users (email, status) VALUES ('totp-second@example.ng', 'active');

\echo '=== 1. A plaintext secret cannot be stored ==='
-- This column holds the ONE recoverable credential in the identity schema —
-- everything else is a one-way hash — so it is the column where a plaintext
-- write does the most damage.
DO $$
BEGIN
    INSERT INTO staff_totp (user_id, secret_sealed)
    VALUES ((SELECT id FROM users WHERE email = 'totp-operator@example.ng'),
            'JBSWY3DPEHPK3PXP');
    RAISE EXCEPTION 'TEST FAILED: a plaintext TOTP secret was stored';
EXCEPTION
    WHEN check_violation THEN
        RAISE NOTICE 'PASS: a second-factor secret must be sealed';
END $$;

\echo ''
\echo '=== 2. A sealed secret enrols, unconfirmed ==='
DO $$
DECLARE v_confirmed TIMESTAMPTZ;
BEGIN
    INSERT INTO staff_totp (user_id, secret_sealed)
    VALUES ((SELECT id FROM users WHERE email = 'totp-operator@example.ng'),
            'v1:c2VhbGVkLXNlY3JldA');

    SELECT confirmed_at INTO v_confirmed FROM staff_totp
     WHERE user_id = (SELECT id FROM users WHERE email = 'totp-operator@example.ng');
    IF v_confirmed IS NOT NULL THEN
        RAISE EXCEPTION 'TEST FAILED: enrolment confirmed itself';
    END IF;
    RAISE NOTICE 'PASS: enrolment starts unconfirmed';
END $$;

\echo ''
\echo '=== 3. An UNCONFIRMED secret can still be replaced ==='
-- The operator who scanned the wrong thing, or scanned nothing. Refusing here
-- would lock somebody out of the admin surface by their own half-finished
-- enrolment — discovered during whatever incident made them open it.
DO $$
BEGIN
    UPDATE staff_totp SET secret_sealed = 'v1:YS1zZWNvbmQtdHJ5'
     WHERE user_id = (SELECT id FROM users WHERE email = 'totp-operator@example.ng');
    RAISE NOTICE 'PASS: an unconfirmed enrolment can be restarted';
END $$;

\echo ''
\echo '=== 4. Confirming works ==='
DO $$
BEGIN
    UPDATE staff_totp SET confirmed_at = now()
     WHERE user_id = (SELECT id FROM users WHERE email = 'totp-operator@example.ng');
    RAISE NOTICE 'PASS: a proved enrolment is confirmed';
END $$;

\echo ''
\echo '=== 5. A CONFIRMED secret cannot be swapped ==='
-- The quiet, complete attack: somebody holding a stolen staff session
-- re-enrols the second factor onto their own authenticator, and from then on
-- holds both factors while the real operator holds neither. Nothing in the
-- audit log looks unusual, because changing phones is a thing operators do.
DO $$
BEGIN
    UPDATE staff_totp SET secret_sealed = 'v1:YXR0YWNrZXJzLXNlY3JldA'
     WHERE user_id = (SELECT id FROM users WHERE email = 'totp-operator@example.ng');
    RAISE EXCEPTION 'TEST FAILED: a confirmed second factor was swapped';
EXCEPTION
    WHEN check_violation THEN
        RAISE NOTICE 'PASS: a confirmed second factor cannot be re-enrolled in place';
END $$;

\echo ''
\echo '=== 6. A confirmed secret cannot be UN-confirmed ==='
-- The same attack through a second door: un-confirm, then swap.
DO $$
BEGIN
    UPDATE staff_totp SET confirmed_at = NULL
     WHERE user_id = (SELECT id FROM users WHERE email = 'totp-operator@example.ng');
    RAISE EXCEPTION 'TEST FAILED: a confirmed second factor was un-confirmed';
EXCEPTION
    WHEN check_violation THEN
        RAISE NOTICE 'PASS: confirmation is one-way';
END $$;

\echo ''
\echo '=== 7. Removing it entirely IS allowed ==='
-- Replacing a lost phone has to be possible. It is a DELETE — an admin action
-- against another person''s account, audited as one — rather than something an
-- operator can do to themselves with the session they are holding.
DO $$
DECLARE v_user BIGINT;
BEGIN
    SELECT id INTO v_user FROM users WHERE email = 'totp-second@example.ng';
    INSERT INTO staff_totp (user_id, secret_sealed, confirmed_at)
    VALUES (v_user, 'v1:dG8tYmUtcmVtb3ZlZA', now());

    DELETE FROM staff_totp WHERE user_id = v_user;
    IF EXISTS (SELECT 1 FROM staff_totp WHERE user_id = v_user) THEN
        RAISE EXCEPTION 'TEST FAILED: the row survived deletion';
    END IF;
    RAISE NOTICE 'PASS: an administrator can remove a lost second factor';
END $$;

\echo ''
\echo '=== 8. A code can be spent once ==='
DO $$
DECLARE v_user BIGINT;
BEGIN
    SELECT id INTO v_user FROM users WHERE email = 'totp-operator@example.ng';
    INSERT INTO staff_totp_used_steps (user_id, time_step) VALUES (v_user, 56000000);
    RAISE NOTICE 'PASS: spending a code records the step';
END $$;

\echo ''
\echo '=== 9. The SAME code cannot be spent twice ==='
-- The guard that matters. A TOTP code stays valid for 90 seconds, which is
-- ample time to read six digits off somebody''s screen during a call. Verifying
-- and stopping there leaves it usable for the rest of that window by everyone
-- else who saw it.
DO $$
DECLARE v_user BIGINT;
BEGIN
    SELECT id INTO v_user FROM users WHERE email = 'totp-operator@example.ng';
    INSERT INTO staff_totp_used_steps (user_id, time_step) VALUES (v_user, 56000000);
    RAISE EXCEPTION 'TEST FAILED: a one-time code was accepted twice';
EXCEPTION
    WHEN unique_violation THEN
        RAISE NOTICE 'PASS: a spent code is refused';
END $$;

\echo ''
\echo '=== 10. Two operators do not share a code space ==='
-- Keyed on (user, step), not on step alone. A shared key would mean the first
-- operator to sign in each half-minute locked out everyone else — which would
-- present as an intermittent, unreproducible authentication fault.
DO $$
DECLARE v_other BIGINT;
BEGIN
    SELECT id INTO v_other FROM users WHERE email = 'totp-second@example.ng';
    INSERT INTO staff_totp_used_steps (user_id, time_step) VALUES (v_other, 56000000);
    RAISE NOTICE 'PASS: the replay guard is per operator';
END $$;

\echo ''
\echo '=== 11. A spent code can never be un-spent ==='
DO $$
BEGIN
    DELETE FROM staff_totp_used_steps WHERE time_step = 56000000;
    RAISE EXCEPTION 'TEST FAILED: the record of a spent code was deleted';
EXCEPTION
    WHEN restrict_violation THEN
        RAISE NOTICE 'PASS: the record of a spent code is permanent';
END $$;

DO $$
BEGIN
    UPDATE staff_totp_used_steps SET time_step = time_step + 1 WHERE time_step = 56000000;
    RAISE EXCEPTION 'TEST FAILED: a spent code was moved to another step';
EXCEPTION
    WHEN restrict_violation THEN
        RAISE NOTICE 'PASS: a spent step cannot be re-pointed';
END $$;

\echo ''
\echo '=== 12. The audit view names staff with no second factor ==='
-- A view rather than a report somebody writes each quarter, because the answer
-- changes every time a role is granted.
DO $$
DECLARE v_user BIGINT; v_naked BIGINT; v_protected BIGINT;
BEGIN
    -- An operator with a role and NO second factor.
    SELECT id INTO v_naked FROM users WHERE email = 'totp-second@example.ng';
    INSERT INTO staff_roles (user_id, role, granted_by)
    VALUES (v_naked, 'support', v_naked);

    -- And one with both.
    SELECT id INTO v_protected FROM users WHERE email = 'totp-operator@example.ng';
    INSERT INTO staff_roles (user_id, role, granted_by)
    VALUES (v_protected, 'compliance', v_protected);

    IF NOT EXISTS (SELECT 1 FROM staff_without_second_factor WHERE user_id = v_naked) THEN
        RAISE EXCEPTION 'TEST FAILED: an unprotected operator is missing from the view';
    END IF;
    IF EXISTS (SELECT 1 FROM staff_without_second_factor WHERE user_id = v_protected) THEN
        RAISE EXCEPTION 'TEST FAILED: a protected operator was reported as unprotected';
    END IF;
    RAISE NOTICE 'PASS: the view names exactly the operators without a second factor';
END $$;

\echo ''
\echo 'staff second factor: all blocks passed'
