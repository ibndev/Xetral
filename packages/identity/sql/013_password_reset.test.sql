-- ===========================================================================
--  Xetral — password reset invariant tests
--  packages/identity/sql/013_password_reset.test.sql
--
--  NOT idempotent. Run against a freshly created database, in migration order.
-- ===========================================================================

\set QUIET on
\pset format unaligned
\pset tuples_only on

INSERT INTO users (email, status) VALUES ('reset-customer@example.ng', 'active');
INSERT INTO user_credentials (user_id, password_hash)
SELECT id, 'v1:original-hash' FROM users WHERE email = 'reset-customer@example.ng';

\echo '=== 1. A raw token cannot be stored ==='
-- The structural half of "only the hash is kept". A real reset token is
-- base64url and cannot match `^[0-9a-f]{64}$`, so a bug that stored the
-- plaintext hits the constraint rather than filling this table with live
-- account-takeover credentials.
DO $$
BEGIN
    INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
    VALUES ((SELECT id FROM users WHERE email = 'reset-customer@example.ng'),
            'Zm9yZ290LW15LXBhc3N3b3JkLXRva2Vu', now() + interval '30 minutes');
    RAISE EXCEPTION 'TEST FAILED: a raw token was stored';
EXCEPTION
    WHEN check_violation THEN
        RAISE NOTICE 'PASS: only a hash can reach the table';
END $$;

\echo ''
\echo '=== 2. A token that expires before it is issued is refused ==='
DO $$
BEGIN
    INSERT INTO password_reset_tokens (user_id, token_hash, issued_at, expires_at)
    VALUES ((SELECT id FROM users WHERE email = 'reset-customer@example.ng'),
            repeat('a', 64), now(), now() - interval '1 minute');
    RAISE EXCEPTION 'TEST FAILED: a token expiring before issue was stored';
EXCEPTION
    WHEN check_violation THEN
        RAISE NOTICE 'PASS: a token cannot expire before it exists';
END $$;

\echo ''
\echo '=== 3. A live token consumes, and takes the account with it ==='
-- The whole flow in one block: the password changes, the token is spent, and
-- every live session dies. Sessions are the part worth watching — finishing a
-- reset while an intruder is still signed in would make the recovery theatre.
DO $$
DECLARE v_user BIGINT; v_device BIGINT; v_outcome password_reset_outcome;
        v_hash TEXT; v_live INTEGER;
BEGIN
    SELECT id INTO v_user FROM users WHERE email = 'reset-customer@example.ng';

    INSERT INTO devices (user_id, fingerprint_hash, platform)
    VALUES (v_user, repeat('1', 64), 'ios') RETURNING id INTO v_device;
    INSERT INTO auth_sessions (user_id, device_id) VALUES (v_user, v_device);
    INSERT INTO auth_sessions (user_id, device_id) VALUES (v_user, v_device);

    INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
    VALUES (v_user, repeat('b', 64), now() + interval '30 minutes');

    SELECT out_outcome INTO v_outcome
      FROM consume_password_reset_token(repeat('b', 64), 'v1:new-hash');

    IF v_outcome <> 'consumed' THEN
        RAISE EXCEPTION 'TEST FAILED: expected consumed, got %', v_outcome;
    END IF;

    SELECT password_hash INTO v_hash FROM user_credentials WHERE user_id = v_user;
    IF v_hash <> 'v1:new-hash' THEN
        RAISE EXCEPTION 'TEST FAILED: the password was not changed, hash is %', v_hash;
    END IF;

    SELECT count(*) INTO v_live FROM auth_sessions
     WHERE user_id = v_user AND revoked_at IS NULL;
    IF v_live <> 0 THEN
        RAISE EXCEPTION 'TEST FAILED: % session(s) survived the reset', v_live;
    END IF;

    RAISE NOTICE 'PASS: a reset changes the password and ends every session';
END $$;

\echo ''
\echo '=== 4. The same token cannot be used twice ==='
-- The race this function exists for, in its simplest form. Two requests
-- carrying one stolen token must not both reset the password — the second
-- would lock the real customer out of the account they had just recovered.
DO $$
DECLARE v_outcome password_reset_outcome; v_hash TEXT;
BEGIN
    SELECT out_outcome INTO v_outcome
      FROM consume_password_reset_token(repeat('b', 64), 'v1:attacker-hash');

    IF v_outcome <> 'already_used' THEN
        RAISE EXCEPTION 'TEST FAILED: expected already_used, got %', v_outcome;
    END IF;

    SELECT password_hash INTO v_hash FROM user_credentials
     WHERE user_id = (SELECT id FROM users WHERE email = 'reset-customer@example.ng');
    IF v_hash <> 'v1:new-hash' THEN
        RAISE EXCEPTION 'TEST FAILED: a replayed token changed the password to %', v_hash;
    END IF;

    RAISE NOTICE 'PASS: a consumed token is refused and changes nothing';
END $$;

\echo ''
\echo '=== 5. A consumed token can never be un-consumed ==='
-- Append-only, same as refresh tokens. If `consumed_at` could be cleared,
-- "already used" would be a claim about the present rather than about history,
-- and one UPDATE would erase the evidence of a takeover.
DO $$
BEGIN
    UPDATE password_reset_tokens SET consumed_at = NULL WHERE token_hash = repeat('b', 64);
    RAISE EXCEPTION 'TEST FAILED: a consumed token was restored';
EXCEPTION
    WHEN check_violation THEN
        RAISE NOTICE 'PASS: consumption is permanent';
END $$;

\echo ''
\echo '=== 6. A token cannot be moved to another account ==='
-- Re-pointing a live token at a different user would turn a reset request for
-- one customer into account access to another.
DO $$
BEGIN
    UPDATE password_reset_tokens SET user_id = user_id + 1
     WHERE token_hash = repeat('b', 64);
    RAISE EXCEPTION 'TEST FAILED: a reset token was re-assigned';
EXCEPTION
    WHEN check_violation THEN
        RAISE NOTICE 'PASS: a reset token belongs to one account for ever';
END $$;

\echo ''
\echo '=== 7. Expiry is reported as expiry, not as reuse ==='
-- The ORDER of the two checks, asserted. An expired-but-unused token is
-- somebody who took too long over their email; reporting that as reuse would
-- bury real incidents in noise.
DO $$
DECLARE v_user BIGINT; v_outcome password_reset_outcome;
BEGIN
    SELECT id INTO v_user FROM users WHERE email = 'reset-customer@example.ng';

    INSERT INTO password_reset_tokens (user_id, token_hash, issued_at, expires_at)
    VALUES (v_user, repeat('c', 64), now() - interval '2 hours', now() - interval '1 hour');

    SELECT out_outcome INTO v_outcome
      FROM consume_password_reset_token(repeat('c', 64), 'v1:should-not-apply');

    IF v_outcome <> 'expired' THEN
        RAISE EXCEPTION 'TEST FAILED: expected expired, got %', v_outcome;
    END IF;
    RAISE NOTICE 'PASS: a lapsed token is expired, not theft';
END $$;

\echo ''
\echo '=== 8. An unknown token says so, and touches nothing ==='
DO $$
DECLARE v_outcome password_reset_outcome; v_user BIGINT;
BEGIN
    SELECT out_outcome, out_user_id INTO v_outcome, v_user
      FROM consume_password_reset_token(repeat('d', 64), 'v1:nope');

    IF v_outcome <> 'unknown_token' THEN
        RAISE EXCEPTION 'TEST FAILED: expected unknown_token, got %', v_outcome;
    END IF;
    IF v_user IS NOT NULL THEN
        RAISE EXCEPTION 'TEST FAILED: an unknown token named a user';
    END IF;
    RAISE NOTICE 'PASS: an unknown token resolves to nobody';
END $$;

\echo ''
\echo '=== 9. Using one token kills every OTHER outstanding token ==='
-- Issuing deliberately does NOT invalidate earlier tokens — an attacker
-- spamming "forgot password" at a victim would otherwise invalidate the email
-- the victim is actually reading. But once one is USED, the rest are surplus
-- credentials to an account that has just been recovered.
DO $$
DECLARE v_user BIGINT; v_outcome password_reset_outcome; v_live INTEGER;
BEGIN
    SELECT id INTO v_user FROM users WHERE email = 'reset-customer@example.ng';

    INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
    VALUES (v_user, repeat('e', 64), now() + interval '30 minutes');
    INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
    VALUES (v_user, repeat('f', 64), now() + interval '30 minutes');

    -- Both live at once: issuing did not invalidate the first.
    -- "Live" means unconsumed AND unexpired. Counting unconsumed alone picks
    -- up the deliberately-expired token block 7 left behind, which is not a
    -- credential anybody can use.
    SELECT count(*) INTO v_live FROM password_reset_tokens
     WHERE user_id = v_user AND consumed_at IS NULL AND expires_at > now();
    IF v_live <> 2 THEN
        RAISE EXCEPTION 'TEST FAILED: expected 2 live tokens before use, got %', v_live;
    END IF;

    SELECT out_outcome INTO v_outcome
      FROM consume_password_reset_token(repeat('e', 64), 'v1:final-hash');
    IF v_outcome <> 'consumed' THEN
        RAISE EXCEPTION 'TEST FAILED: expected consumed, got %', v_outcome;
    END IF;

    SELECT count(*) INTO v_live FROM password_reset_tokens
     WHERE user_id = v_user AND consumed_at IS NULL AND expires_at > now();
    IF v_live <> 0 THEN
        RAISE EXCEPTION 'TEST FAILED: % token(s) still live after a reset', v_live;
    END IF;

    RAISE NOTICE 'PASS: using one reset token spends them all';
END $$;

\echo ''
\echo '=== 10. The revocation reason distinguishes a reset from a change ==='
-- Collapsing the two would hide every account-takeover recovery among routine
-- password updates, which is precisely the population an investigator wants to
-- be able to select.
DO $$
DECLARE v_reason session_revoke_reason;
BEGIN
    SELECT revoked_reason INTO v_reason FROM auth_sessions
     WHERE user_id = (SELECT id FROM users WHERE email = 'reset-customer@example.ng')
       AND revoked_reason IS NOT NULL
     LIMIT 1;

    IF v_reason <> 'password_reset' THEN
        RAISE EXCEPTION 'TEST FAILED: expected password_reset, got %', v_reason;
    END IF;
    RAISE NOTICE 'PASS: a reset is recorded as a reset';
END $$;

\echo ''
\echo 'password reset: all blocks passed'
