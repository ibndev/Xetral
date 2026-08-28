-- ===========================================================================
--  Xetral — notification outbox invariant tests
--  packages/identity/sql/012_notifications.test.sql
--
--  NOT idempotent. Run against a freshly created database, in migration order.
--
--  Seeding and asserting are in SEPARATE DO blocks throughout. A DO block with
--  an EXCEPTION handler rolls back to its own start, so a block that seeds a
--  row and then expects a failure discards the seed on the way out and the
--  next block finds nothing — a test that passes because it tested nothing.
-- ===========================================================================

\set QUIET on
\pset format unaligned
\pset tuples_only on

INSERT INTO users (email, status) VALUES ('notify-customer@example.ng', 'active');

\echo '=== 1. A plaintext body cannot reach a row ==='
-- The structural half of "the outbox is not a list of live reset links". A
-- rendered password reset email contains a bearer token; the CHECK is what
-- makes sealing a property of the schema rather than a habit of the service.
DO $$
BEGIN
    INSERT INTO notification_outbox
        (user_id, kind, class, recipient, payload_sealed, idempotency_key)
    VALUES ((SELECT id FROM users WHERE email = 'notify-customer@example.ng'),
            'password_reset', 'security', 'notify-customer@example.ng',
            'Subject: reset your password https://xetral.com/r/abc123',
            'notify:plaintext');
    RAISE EXCEPTION 'TEST FAILED: an unsealed body was stored';
EXCEPTION
    WHEN check_violation THEN
        RAISE NOTICE 'PASS: a body must be sealed to be stored';
END $$;

\echo ''
\echo '=== 2. A pending notification must actually have a body ==='
DO $$
BEGIN
    INSERT INTO notification_outbox
        (user_id, kind, class, recipient, payload_sealed, idempotency_key)
    VALUES ((SELECT id FROM users WHERE email = 'notify-customer@example.ng'),
            'new_device', 'security', 'notify-customer@example.ng',
            NULL, 'notify:bodyless');
    RAISE EXCEPTION 'TEST FAILED: a pending notification with no body was stored';
EXCEPTION
    WHEN check_violation THEN
        RAISE NOTICE 'PASS: a pending notification carries something to send';
END $$;

\echo ''
\echo '=== 3. A real notification enqueues ==='
DO $$
BEGIN
    INSERT INTO notification_outbox
        (user_id, kind, class, recipient, payload_sealed, idempotency_key)
    VALUES ((SELECT id FROM users WHERE email = 'notify-customer@example.ng'),
            'password_reset', 'security', 'notify-customer@example.ng',
            'v1:c2VhbGVkLXJlc2V0LWxpbms', 'notify:reset-1');
    RAISE NOTICE 'PASS: a sealed notification enqueues';
END $$;

\echo ''
\echo '=== 4. Enqueueing the same message twice produces ONE row ==='
-- Two requests racing to tell a customer the same thing must not mail them
-- twice. This is the same guarantee the ledger gets from `idempotency_key`,
-- applied to messages instead of money.
DO $$
BEGIN
    INSERT INTO notification_outbox
        (user_id, kind, class, recipient, payload_sealed, idempotency_key)
    VALUES ((SELECT id FROM users WHERE email = 'notify-customer@example.ng'),
            'password_reset', 'security', 'notify-customer@example.ng',
            'v1:c2VhbGVkLXJlc2V0LWxpbms', 'notify:reset-1');
    RAISE EXCEPTION 'TEST FAILED: the same message enqueued twice';
EXCEPTION
    WHEN unique_violation THEN
        RAISE NOTICE 'PASS: enqueueing is idempotent';
END $$;

\echo ''
\echo '=== 5. A pending message cannot be RE-ADDRESSED ==='
-- The attack this closes. The row is written inside the transaction that owed
-- it; if the recipient could be edited afterwards, anyone with UPDATE could
-- point a live password reset at an address of their choosing and let our own
-- worker deliver it for them.
DO $$
BEGIN
    UPDATE notification_outbox
       SET recipient = 'attacker@example.com'
     WHERE idempotency_key = 'notify:reset-1';
    RAISE EXCEPTION 'TEST FAILED: a pending security email was re-addressed';
EXCEPTION
    WHEN check_violation THEN
        RAISE NOTICE 'PASS: a notification cannot be re-addressed';
END $$;

\echo ''
\echo '=== 6. A body may be ERASED but not REWRITTEN ==='
-- Erasing is how a sent message stops holding a secret. Rewriting would let a
-- pending message be swapped for a different one after the transaction that
-- authorised it had already committed.
DO $$
BEGIN
    UPDATE notification_outbox
       SET payload_sealed = 'v1:c29tZXRoaW5nLWVsc2U'
     WHERE idempotency_key = 'notify:reset-1';
    RAISE EXCEPTION 'TEST FAILED: a pending body was rewritten';
EXCEPTION
    WHEN check_violation THEN
        RAISE NOTICE 'PASS: a notification body is immutable';
END $$;

\echo ''
\echo '=== 7. Attempts cannot go backwards ==='
-- The attempt ceiling is the only thing that stops a permanently-refused
-- message being retried for ever. A counter that can be wound back is not a
-- ceiling.
DO $$
BEGIN
    UPDATE notification_outbox SET attempts = 3 WHERE idempotency_key = 'notify:reset-1';
    UPDATE notification_outbox SET attempts = 1 WHERE idempotency_key = 'notify:reset-1';
    RAISE EXCEPTION 'TEST FAILED: the attempt count was wound back';
EXCEPTION
    WHEN check_violation THEN
        RAISE NOTICE 'PASS: attempts only ever increase';
END $$;

\echo ''
\echo '=== 8. Marking sent requires a receipt AND erases the body ==='
DO $$
BEGIN
    UPDATE notification_outbox
       SET status = 'sent', sent_at = now()
     WHERE idempotency_key = 'notify:reset-1';
    RAISE EXCEPTION 'TEST FAILED: sent without a provider message id';
EXCEPTION
    WHEN check_violation THEN
        RAISE NOTICE 'PASS: a sent message must carry a provider receipt';
END $$;

DO $$
BEGIN
    UPDATE notification_outbox
       SET status = 'sent', sent_at = now(),
           provider = 'resend', provider_message_id = 'msg_1'
     WHERE idempotency_key = 'notify:reset-1';
    RAISE EXCEPTION 'TEST FAILED: sent while still holding the reset link';
EXCEPTION
    WHEN check_violation THEN
        RAISE NOTICE 'PASS: a delivered secret is erased, not retained';
END $$;

\echo ''
\echo '=== 9. A correct send is accepted ==='
DO $$
DECLARE v_status notification_status;
BEGIN
    UPDATE notification_outbox
       SET status = 'sent', sent_at = now(),
           provider = 'resend', provider_message_id = 'msg_1',
           payload_sealed = NULL
     WHERE idempotency_key = 'notify:reset-1';

    SELECT status INTO v_status FROM notification_outbox
     WHERE idempotency_key = 'notify:reset-1';
    IF v_status <> 'sent' THEN
        RAISE EXCEPTION 'TEST FAILED: expected sent, got %', v_status;
    END IF;
    RAISE NOTICE 'PASS: a send records a receipt and drops the body';
END $$;

\echo ''
\echo '=== 10. A sent message is FINAL ==='
-- Reopening one would let a delivered reset link be re-delivered, which is the
-- single thing the one-time token was designed to make impossible.
DO $$
BEGIN
    UPDATE notification_outbox
       SET status = 'pending', payload_sealed = 'v1:cmVzZW5k'
     WHERE idempotency_key = 'notify:reset-1';
    RAISE EXCEPTION 'TEST FAILED: a sent message was reopened';
EXCEPTION
    WHEN check_violation THEN
        RAISE NOTICE 'PASS: a sent message cannot be resent';
END $$;

\echo ''
\echo '=== 11. An abandoned message is final too ==='
DO $$
BEGIN
    INSERT INTO notification_outbox
        (user_id, kind, class, recipient, payload_sealed, idempotency_key, status, attempts)
    VALUES ((SELECT id FROM users WHERE email = 'notify-customer@example.ng'),
            'transfer_sent', 'transactional', 'notify-customer@example.ng',
            'v1:cmVjZWlwdA', 'notify:doomed', 'abandoned', 9);
    RAISE NOTICE 'PASS: a message can be abandoned';
END $$;

DO $$
BEGIN
    UPDATE notification_outbox SET status = 'pending' WHERE idempotency_key = 'notify:doomed';
    RAISE EXCEPTION 'TEST FAILED: an abandoned message was resurrected';
EXCEPTION
    WHEN check_violation THEN
        RAISE NOTICE 'PASS: abandonment is final';
END $$;

\echo ''
\echo '=== 12. A reset for an address with no account is still recordable ==='
-- `user_id` is nullable precisely so this row can exist. Requiring it would
-- mean the only way to rate-limit and audit a reset request for an unknown
-- address is to first reveal whether the address has an account.
DO $$
BEGIN
    INSERT INTO notification_outbox
        (user_id, kind, class, recipient, payload_sealed, idempotency_key)
    VALUES (NULL, 'password_reset', 'security', 'nobody@example.ng',
            'v1:bm90aGluZw', 'notify:unknown-address');
    RAISE NOTICE 'PASS: a request for an unknown address leaves a trace';
END $$;

\echo ''
\echo '=== 13. The backlog view separates security from the rest ==='
-- What operations is paged about. A queue of receipts is an annoyance; a queue
-- of password resets is customers locked out of their money right now.
DO $$
DECLARE v_security BIGINT;
BEGIN
    SELECT coalesce(sum(waiting), 0) INTO v_security
      FROM notification_backlog WHERE class = 'security';
    IF v_security < 1 THEN
        RAISE EXCEPTION 'TEST FAILED: expected pending security mail in the backlog, got %', v_security;
    END IF;
    RAISE NOTICE 'PASS: the backlog reports undelivered security mail';
END $$;

\echo ''
\echo 'notifications: all blocks passed'
