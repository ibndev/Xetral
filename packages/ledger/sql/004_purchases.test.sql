-- ===========================================================================
--  Xetral — Phase 6 purchase invariant tests
--  packages/ledger/sql/004_purchases.test.sql
-- ===========================================================================

\set QUIET on
\pset format unaligned
\pset tuples_only on

INSERT INTO users (email, status) VALUES ('buyer@example.ng', 'active');

\echo '=== 1. A purchase starts reserved ==='
DO $$
DECLARE v_user BIGINT; v_id BIGINT; v_status purchase_status;
BEGIN
    SELECT id INTO v_user FROM users WHERE email = 'buyer@example.ng';
    INSERT INTO purchases (user_id, reference, idempotency_key, provider, service,
                           item_code, target, amount_minor, currency)
    VALUES (v_user, 'ref-1', 'ref-1-key', 'vtpass', 'data', 'mtn:1gb', '08030000000', 50000, 'NGN')
    RETURNING id INTO v_id;

    SELECT status INTO v_status FROM purchases WHERE id = v_id;
    IF v_status <> 'reserved' THEN
        RAISE EXCEPTION 'TEST FAILED: expected reserved, got %', v_status;
    END IF;
    RAISE NOTICE 'PASS: purchase % starts reserved', v_id;
END $$;

\echo ''
\echo '=== 2. One reference means one purchase ==='
-- The whole idempotency story. A retried request must not become a second
-- charge.
DO $$
DECLARE v_user BIGINT;
BEGIN
    SELECT id INTO v_user FROM users WHERE email = 'buyer@example.ng';
    INSERT INTO purchases (user_id, reference, idempotency_key, provider, service,
                           item_code, target, amount_minor, currency)
    -- A DIFFERENT customer key, so this block isolates the reference
    -- constraint. Reusing both would pass on either one and prove neither.
    VALUES (v_user, 'ref-1', 'ref-1-other-key', 'vtpass', 'data', 'mtn:1gb', '08030000000', 50000, 'NGN');
    RAISE EXCEPTION 'TEST FAILED: a reference was reused';
EXCEPTION
    WHEN unique_violation THEN
        RAISE NOTICE 'PASS: duplicate reference rejected';
END $$;

\echo ''
\echo '=== 2a. A customer key is unique PER CUSTOMER, not globally ==='
-- Two customers counting from one will collide. The first insert is the same
-- key as block 1 under a DIFFERENT user and must succeed; the second repeats it
-- under the ORIGINAL user and must not.
DO $$
DECLARE v_user BIGINT; v_other BIGINT;
BEGIN
    SELECT id INTO v_user FROM users WHERE email = 'buyer@example.ng';
    INSERT INTO users (email, status) VALUES ('buyer2@example.ng', 'active')
    RETURNING id INTO v_other;

    INSERT INTO purchases (user_id, reference, idempotency_key, provider, service,
                           item_code, target, amount_minor, currency)
    VALUES (v_other, 'ref-2', 'ref-1-key', 'vtpass', 'data', 'mtn:1gb', '08030000001', 50000, 'NGN');

    BEGIN
        INSERT INTO purchases (user_id, reference, idempotency_key, provider, service,
                               item_code, target, amount_minor, currency)
        VALUES (v_user, 'ref-3', 'ref-1-key', 'vtpass', 'data', 'mtn:1gb', '08030000000', 50000, 'NGN');
        RAISE EXCEPTION 'TEST FAILED: a customer reused their own key';
    EXCEPTION
        WHEN unique_violation THEN
            RAISE NOTICE 'PASS: one customer key, one purchase — and it does not block anyone else';
    END;
END $$;

\echo ''
\echo '=== 3. An outcome is FINAL ==='
DO $$
DECLARE v_user BIGINT; v_id BIGINT;
BEGIN
    SELECT id INTO v_user FROM users WHERE email = 'buyer@example.ng';
    INSERT INTO purchases (user_id, reference, idempotency_key, provider, service,
                           item_code, target, amount_minor, currency)
    VALUES (v_user, 'ref-final', 'ref-final-key', 'vtpass', 'airtime', 'mtn', '08030000000', 50000, 'NGN')
    RETURNING id INTO v_id;

    UPDATE purchases SET status = 'delivered', provider_reference = 'vt_1' WHERE id = v_id;

    -- Reopening would let a delivered token be handed out twice.
    UPDATE purchases SET status = 'failed', failure_reason = 'changed my mind' WHERE id = v_id;
    RAISE EXCEPTION 'TEST FAILED: a settled purchase was reopened';
EXCEPTION
    WHEN check_violation THEN
        RAISE NOTICE 'PASS: rejected -> %', SQLERRM;
END $$;

\echo ''
\echo '=== 4. A delivered purchase must name the provider transaction ==='
-- Without it there is nothing to reconcile against, and "delivered" is a claim
-- rather than a fact.
DO $$
DECLARE v_user BIGINT; v_id BIGINT;
BEGIN
    SELECT id INTO v_user FROM users WHERE email = 'buyer@example.ng';
    INSERT INTO purchases (user_id, reference, idempotency_key, provider, service,
                           item_code, target, amount_minor, currency)
    VALUES (v_user, 'ref-noref', 'ref-noref-key', 'airalo', 'esim', 'ng-1gb', 'NG', 450, 'USD')
    RETURNING id INTO v_id;

    UPDATE purchases SET status = 'delivered' WHERE id = v_id;
    RAISE EXCEPTION 'TEST FAILED: delivered with no provider reference';
EXCEPTION
    WHEN check_violation THEN
        RAISE NOTICE 'PASS: rejected -> delivered requires a provider reference';
END $$;

\echo ''
\echo '=== 5. A failed purchase must say why ==='
DO $$
DECLARE v_user BIGINT; v_id BIGINT;
BEGIN
    SELECT id INTO v_user FROM users WHERE email = 'buyer@example.ng';
    INSERT INTO purchases (user_id, reference, idempotency_key, provider, service,
                           item_code, target, amount_minor, currency)
    VALUES (v_user, 'ref-noreason', 'ref-noreason-key', 'twilio', 'number', '+1500', 'US', 300, 'USD')
    RETURNING id INTO v_id;

    UPDATE purchases SET status = 'failed' WHERE id = v_id;
    RAISE EXCEPTION 'TEST FAILED: failed with no reason';
EXCEPTION
    WHEN check_violation THEN
        RAISE NOTICE 'PASS: rejected -> a failure must carry a reason';
END $$;

\echo ''
\echo '=== 6. A delivery payload must be SEALED, never stored in the clear ==='
-- An electricity token is a bearer instrument: whoever holds it before it is
-- used can spend it. A CHECK makes the sealing structural rather than a habit.
DO $$
DECLARE v_user BIGINT; v_id BIGINT;
BEGIN
    SELECT id INTO v_user FROM users WHERE email = 'buyer@example.ng';
    INSERT INTO purchases (user_id, reference, idempotency_key, provider, service,
                           item_code, target, amount_minor, currency)
    VALUES (v_user, 'ref-token', 'ref-token-key', 'vtpass', 'utility', 'ikeja:prepaid', '0123', 500000, 'NGN')
    RETURNING id INTO v_id;

    UPDATE purchases
       SET status = 'delivered', provider_reference = 'vt_2',
           delivery_sealed = '{"token":"1234-5678-9012-3456"}'
     WHERE id = v_id;
    RAISE EXCEPTION 'TEST FAILED: a raw delivery payload was stored';
EXCEPTION
    WHEN check_violation THEN
        RAISE NOTICE 'PASS: unsealed delivery payload rejected';
END $$;

\echo ''
\echo '=== 7. The amount and owner are immutable ==='
DO $$
DECLARE v_user BIGINT; v_id BIGINT;
BEGIN
    SELECT id INTO v_user FROM users WHERE email = 'buyer@example.ng';
    SELECT id INTO v_id FROM purchases WHERE reference = 'ref-1';

    UPDATE purchases SET amount_minor = 1 WHERE id = v_id;
    RAISE EXCEPTION 'TEST FAILED: a reserved amount was edited';
EXCEPTION
    WHEN check_violation THEN
        RAISE NOTICE 'PASS: rejected -> %', SQLERRM;
END $$;

\echo ''
\echo '=== 8. A zero or negative purchase is REJECTED ==='
DO $$
DECLARE v_user BIGINT;
BEGIN
    SELECT id INTO v_user FROM users WHERE email = 'buyer@example.ng';
    INSERT INTO purchases (user_id, reference, idempotency_key, provider, service,
                           item_code, target, amount_minor, currency)
    VALUES (v_user, 'ref-zero', 'ref-zero-key', 'vtpass', 'airtime', 'mtn', '0803', 0, 'NGN');
    RAISE EXCEPTION 'TEST FAILED: a zero-amount purchase was accepted';
EXCEPTION
    WHEN check_violation THEN
        RAISE NOTICE 'PASS: zero-amount purchase rejected';
END $$;

\echo ''
\echo '=== 9. An unknown service is REJECTED ==='
DO $$
DECLARE v_user BIGINT;
BEGIN
    SELECT id INTO v_user FROM users WHERE email = 'buyer@example.ng';
    INSERT INTO purchases (user_id, reference, idempotency_key, provider, service,
                           item_code, target, amount_minor, currency)
    VALUES (v_user, 'ref-bogus', 'ref-bogus-key', 'vtpass', 'crypto_mining', 'x', 'y', 100, 'NGN');
    RAISE EXCEPTION 'TEST FAILED: an unknown service was accepted';
EXCEPTION
    WHEN check_violation THEN
        RAISE NOTICE 'PASS: unknown service rejected';
END $$;

\echo ''
\echo '=== 10. Held purchases are visible to reconciliation ==='
-- An assertion, not a report. `pending_purchases` is the ONLY thing standing
-- between a provider that never answered and a customer's money sitting held
-- for ever, so a view that silently returned nothing would be the failure this
-- block exists to catch — and a bare SELECT printing '0' cannot fail a build.
DO $$
DECLARE v_reserved BIGINT; v_finished BIGINT;
BEGIN
    SELECT COUNT(*) INTO v_reserved FROM pending_purchases;
    IF v_reserved = 0 THEN
        RAISE EXCEPTION 'TEST FAILED: reserved purchases are invisible to reconciliation';
    END IF;

    -- And it must show ONLY those. A queue that also lists settled purchases
    -- sends somebody to ask a provider about money that is already spent.
    SELECT COUNT(*) INTO v_finished
      FROM pending_purchases pp
      JOIN purchases p ON p.id = pp.purchase_id
     WHERE p.status <> 'reserved';
    IF v_finished <> 0 THEN
        RAISE EXCEPTION 'TEST FAILED: % finished purchases appear in the queue', v_finished;
    END IF;

    RAISE NOTICE 'PASS: % reserved purchases queued, and nothing else', v_reserved;
END $$;
