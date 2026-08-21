-- ===========================================================================
--  Xetral — Phase 7 gift card invariant tests
--  packages/ledger/sql/005_giftcards.test.sql
--
--  Every block here is a way somebody gets paid for a card they should not
--  have been paid for. That is the only reason this table has as many
--  constraints as it does.
-- ===========================================================================

\set QUIET on
\pset format unaligned
\pset tuples_only on

-- Resolve-or-create, for the same reason the card suite needs one: PLATFORM
-- accounts have one row per currency for the whole database, so an earlier
-- suite may already have created the one this file wants.
CREATE OR REPLACE FUNCTION gc_account(
    p_kind account_kind, p_owner BIGINT, p_currency TEXT, p_normal TEXT
) RETURNS BIGINT AS $fn$
DECLARE v_id BIGINT;
BEGIN
    SELECT id INTO v_id FROM accounts
     WHERE kind = p_kind AND currency = p_currency
       AND owner_id IS NOT DISTINCT FROM p_owner;
    IF v_id IS NOT NULL THEN RETURN v_id; END IF;

    INSERT INTO accounts (kind, owner_type, owner_id, currency, normal_balance)
    VALUES (p_kind,
            CASE WHEN p_owner IS NULL THEN NULL ELSE 'user' END,
            p_owner, p_currency, p_normal)
    RETURNING id INTO v_id;
    RETURN v_id;
END;
$fn$ LANGUAGE plpgsql;

-- A real, balanced approval entry, so the tests exercise the actual FK rather
-- than a NULL that happens to satisfy it.
CREATE OR REPLACE FUNCTION gc_entry(p_key TEXT, p_user BIGINT, p_minor BIGINT)
RETURNS BIGINT AS $fn$
DECLARE v_entry BIGINT;
BEGIN
    INSERT INTO journal_entries (idempotency_key, kind, description, occurred_at)
    VALUES (p_key, 'giftcard_purchase', 'test approval', now())
    RETURNING id INTO v_entry;

    INSERT INTO postings (journal_entry_id, account_id, amount_minor, currency)
    VALUES (v_entry, gc_account('customer_pending', p_user, 'NGN', 'credit'), p_minor, 'NGN'),
           (v_entry, gc_account('asset_giftcard_inventory', NULL, 'NGN', 'debit'), -p_minor, 'NGN');
    RETURN v_entry;
END;
$fn$ LANGUAGE plpgsql;

INSERT INTO users (email, status) VALUES
  ('gc-seller@example.ng', 'active'),
  ('gc-reviewer@example.ng', 'active'),
  ('gc-other@example.ng', 'active');

INSERT INTO giftcard_rate_cards
  (brand, country, card_type, face_currency, payout_currency,
   payout_rate_minor, min_face_minor, max_face_minor)
VALUES ('amazon', 'US', 'ecode', 'USD', 'NGN', 125000, 1000, 50000);

\echo '=== 1. A submission starts in the review queue ==='
DO $$
DECLARE v_user BIGINT; v_rate BIGINT; v_id BIGINT; v_status giftcard_status;
BEGIN
    SELECT id INTO v_user FROM users WHERE email = 'gc-seller@example.ng';
    SELECT id INTO v_rate FROM giftcard_rate_cards LIMIT 1;

    INSERT INTO giftcard_submissions
      (user_id, reference, idempotency_key, rate_card_id, face_amount_minor,
       face_currency, payout_amount_minor, payout_currency, card_sealed)
    VALUES (v_user, 'gc-1', 'gc-1-key', v_rate, 5000, 'USD', 6250000, 'NGN', 'v1:sealed')
    RETURNING id INTO v_id;

    SELECT status INTO v_status FROM giftcard_submissions WHERE id = v_id;
    IF v_status <> 'pending_review' THEN
        RAISE EXCEPTION 'TEST FAILED: a submission was not queued for review';
    END IF;
    RAISE NOTICE 'PASS: submission % waits for a human', v_id;
END $$;

\echo ''
\echo '=== 2. An UNSEALED card cannot reach a row ==='
-- The card is a bearer instrument. This CHECK is what makes sealing
-- structural rather than a habit the next author might not share.
DO $$
DECLARE v_user BIGINT; v_rate BIGINT;
BEGIN
    SELECT id INTO v_user FROM users WHERE email = 'gc-seller@example.ng';
    SELECT id INTO v_rate FROM giftcard_rate_cards LIMIT 1;

    INSERT INTO giftcard_submissions
      (user_id, reference, idempotency_key, rate_card_id, face_amount_minor,
       face_currency, payout_amount_minor, payout_currency, card_sealed)
    VALUES (v_user, 'gc-plain', 'gc-plain-key', v_rate, 5000, 'USD', 6250000, 'NGN',
            'AMZN-1234-5678-9012');
    RAISE EXCEPTION 'TEST FAILED: a plaintext gift card code was stored';
EXCEPTION
    WHEN check_violation THEN
        RAISE NOTICE 'PASS: an unsealed card code is refused by the database';
END $$;

\echo ''
\echo '=== 3. Nobody approves their OWN submission ==='
DO $$
DECLARE v_user BIGINT; v_rate BIGINT; v_id BIGINT; v_entry BIGINT;
BEGIN
    SELECT id INTO v_user FROM users WHERE email = 'gc-seller@example.ng';
    SELECT id INTO v_rate FROM giftcard_rate_cards LIMIT 1;

    INSERT INTO giftcard_submissions
      (user_id, reference, idempotency_key, rate_card_id, face_amount_minor,
       face_currency, payout_amount_minor, payout_currency, card_sealed)
    VALUES (v_user, 'gc-self', 'gc-self-key', v_rate, 5000, 'USD', 6250000, 'NGN', 'v1:sealed')
    RETURNING id INTO v_id;

    v_entry := gc_entry('test:gc-self', v_user, 6250000);

    UPDATE giftcard_submissions
       SET status = 'approved', reviewed_by = v_user, reviewed_at = now(),
           hold_until = now() + interval '3 days', approval_entry_id = v_entry
     WHERE id = v_id;
    RAISE EXCEPTION 'TEST FAILED: a seller approved their own card';
EXCEPTION
    WHEN check_violation THEN
        RAISE NOTICE 'PASS: the simplest inside job is refused';
END $$;

\echo ''
\echo '=== 4. An approval with no reviewer is an AUTOMATIC payment ==='
-- The one thing this whole table exists to prevent.
DO $$
DECLARE v_user BIGINT; v_rate BIGINT; v_id BIGINT; v_entry BIGINT;
BEGIN
    SELECT id INTO v_user FROM users WHERE email = 'gc-seller@example.ng';
    SELECT id INTO v_rate FROM giftcard_rate_cards LIMIT 1;

    INSERT INTO giftcard_submissions
      (user_id, reference, idempotency_key, rate_card_id, face_amount_minor,
       face_currency, payout_amount_minor, payout_currency, card_sealed)
    VALUES (v_user, 'gc-auto', 'gc-auto-key', v_rate, 5000, 'USD', 6250000, 'NGN', 'v1:sealed')
    RETURNING id INTO v_id;

    v_entry := gc_entry('test:gc-auto', v_user, 6250000);

    UPDATE giftcard_submissions
       SET status = 'approved', hold_until = now() + interval '3 days',
           approval_entry_id = v_entry
     WHERE id = v_id;
    RAISE EXCEPTION 'TEST FAILED: a card was paid with no human approving it';
EXCEPTION
    WHEN check_violation THEN
        RAISE NOTICE 'PASS: no payout without a named reviewer';
END $$;

\echo ''
\echo '=== 4a. An approval with NO HOLD is an instantly spendable payout ==='
DO $$
DECLARE v_seller BIGINT; v_reviewer BIGINT; v_rate BIGINT; v_id BIGINT; v_entry BIGINT;
BEGIN
    SELECT id INTO v_seller FROM users WHERE email = 'gc-seller@example.ng';
    SELECT id INTO v_reviewer FROM users WHERE email = 'gc-reviewer@example.ng';
    SELECT id INTO v_rate FROM giftcard_rate_cards LIMIT 1;

    INSERT INTO giftcard_submissions
      (user_id, reference, idempotency_key, rate_card_id, face_amount_minor,
       face_currency, payout_amount_minor, payout_currency, card_sealed)
    VALUES (v_seller, 'gc-nohold', 'gc-nohold-key', v_rate, 5000, 'USD', 6250000, 'NGN', 'v1:sealed')
    RETURNING id INTO v_id;

    v_entry := gc_entry('test:gc-nohold', v_seller, 6250000);

    UPDATE giftcard_submissions
       SET status = 'approved', reviewed_by = v_reviewer, reviewed_at = now(),
           approval_entry_id = v_entry
     WHERE id = v_id;
    RAISE EXCEPTION 'TEST FAILED: an approval carried no hold period';
EXCEPTION
    WHEN check_violation THEN
        RAISE NOTICE 'PASS: an approved payout must be held';
END $$;

\echo ''
\echo '=== 5. A rejection must say why ==='
DO $$
DECLARE v_user BIGINT; v_rate BIGINT; v_id BIGINT;
BEGIN
    SELECT id INTO v_user FROM users WHERE email = 'gc-seller@example.ng';
    SELECT id INTO v_rate FROM giftcard_rate_cards LIMIT 1;

    INSERT INTO giftcard_submissions
      (user_id, reference, idempotency_key, rate_card_id, face_amount_minor,
       face_currency, payout_amount_minor, payout_currency, card_sealed)
    VALUES (v_user, 'gc-noreason', 'gc-noreason-key', v_rate, 5000, 'USD', 6250000, 'NGN', 'v1:sealed')
    RETURNING id INTO v_id;

    UPDATE giftcard_submissions SET status = 'rejected' WHERE id = v_id;
    RAISE EXCEPTION 'TEST FAILED: a card was rejected with no reason';
EXCEPTION
    WHEN check_violation THEN
        RAISE NOTICE 'PASS: a customer is always told why';
END $$;

\echo ''
\echo '=== 6. A REJECTED card cannot later be approved ==='
-- The pressure here is real: a customer complains, someone wants to fix it
-- quickly, and a second approval pays for a card already found to be bad.
DO $$
DECLARE v_seller BIGINT; v_reviewer BIGINT; v_rate BIGINT; v_id BIGINT; v_entry BIGINT;
BEGIN
    SELECT id INTO v_seller FROM users WHERE email = 'gc-seller@example.ng';
    SELECT id INTO v_reviewer FROM users WHERE email = 'gc-reviewer@example.ng';
    SELECT id INTO v_rate FROM giftcard_rate_cards LIMIT 1;

    INSERT INTO giftcard_submissions
      (user_id, reference, idempotency_key, rate_card_id, face_amount_minor,
       face_currency, payout_amount_minor, payout_currency, card_sealed)
    VALUES (v_seller, 'gc-flip', 'gc-flip-key', v_rate, 5000, 'USD', 6250000, 'NGN', 'v1:sealed')
    RETURNING id INTO v_id;

    UPDATE giftcard_submissions
       SET status = 'rejected', rejection_reason = 'already redeemed',
           reviewed_by = v_reviewer, reviewed_at = now()
     WHERE id = v_id;

    v_entry := gc_entry('test:gc-flip', v_seller, 6250000);
    UPDATE giftcard_submissions
       SET status = 'approved', hold_until = now() + interval '3 days',
           approval_entry_id = v_entry
     WHERE id = v_id;
    RAISE EXCEPTION 'TEST FAILED: a rejected card was approved';
EXCEPTION
    WHEN check_violation THEN
        RAISE NOTICE 'PASS: a rejection is final';
END $$;

\echo ''
\echo '=== 7. A hold cannot be released EARLY ==='
-- The clock is the database's. A worker with a skewed system clock releasing a
-- hold three days early is exactly how a fraudulent card gets cashed out.
DO $$
DECLARE v_seller BIGINT; v_reviewer BIGINT; v_rate BIGINT; v_id BIGINT;
        v_entry BIGINT; v_release BIGINT;
BEGIN
    SELECT id INTO v_seller FROM users WHERE email = 'gc-other@example.ng';
    SELECT id INTO v_reviewer FROM users WHERE email = 'gc-reviewer@example.ng';
    SELECT id INTO v_rate FROM giftcard_rate_cards LIMIT 1;

    INSERT INTO giftcard_submissions
      (user_id, reference, idempotency_key, rate_card_id, face_amount_minor,
       face_currency, payout_amount_minor, payout_currency, card_sealed)
    VALUES (v_seller, 'gc-early', 'gc-early-key', v_rate, 5000, 'USD', 6250000, 'NGN', 'v1:sealed')
    RETURNING id INTO v_id;

    v_entry := gc_entry('test:gc-early', v_seller, 6250000);
    UPDATE giftcard_submissions
       SET status = 'approved', reviewed_by = v_reviewer, reviewed_at = now(),
           hold_until = now() + interval '3 days', approval_entry_id = v_entry
     WHERE id = v_id;

    v_release := gc_entry('test:gc-early-rel', v_seller, 1);
    UPDATE giftcard_submissions
       SET status = 'released', release_entry_id = v_release
     WHERE id = v_id;
    RAISE EXCEPTION 'TEST FAILED: a hold was released before it matured';
EXCEPTION
    WHEN check_violation THEN
        RAISE NOTICE 'PASS: the hold period is enforced by the database clock';
END $$;

\echo ''
\echo '=== 8. A RELEASED payout cannot be clawed back ==='
-- Once the money is spendable it may already be spent. Clawing back then would
-- overdraw a customer who did nothing wrong, and the overdraft guard would
-- refuse it anyway -- so the state machine says no first, with a reason.
DO $$
DECLARE v_seller BIGINT; v_reviewer BIGINT; v_rate BIGINT; v_id BIGINT;
        v_entry BIGINT; v_release BIGINT;
BEGIN
    SELECT id INTO v_seller FROM users WHERE email = 'gc-other@example.ng';
    SELECT id INTO v_reviewer FROM users WHERE email = 'gc-reviewer@example.ng';
    SELECT id INTO v_rate FROM giftcard_rate_cards LIMIT 1;

    INSERT INTO giftcard_submissions
      (user_id, reference, idempotency_key, rate_card_id, face_amount_minor,
       face_currency, payout_amount_minor, payout_currency, card_sealed)
    VALUES (v_seller, 'gc-late', 'gc-late-key', v_rate, 5000, 'USD', 6250000, 'NGN', 'v1:sealed')
    RETURNING id INTO v_id;

    v_entry := gc_entry('test:gc-late', v_seller, 6250000);
    -- A hold that matured in the past, so the release is legal.
    UPDATE giftcard_submissions
       SET status = 'approved', reviewed_by = v_reviewer, reviewed_at = now(),
           hold_until = now() - interval '1 minute', approval_entry_id = v_entry
     WHERE id = v_id;

    v_release := gc_entry('test:gc-late-rel', v_seller, 1);
    UPDATE giftcard_submissions
       SET status = 'released', release_entry_id = v_release
     WHERE id = v_id;

    UPDATE giftcard_submissions
       SET status = 'clawed_back', clawback_reason = 'issuer voided it'
     WHERE id = v_id;
    RAISE EXCEPTION 'TEST FAILED: a released payout was clawed back';
EXCEPTION
    WHEN check_violation THEN
        RAISE NOTICE 'PASS: a clawback is only possible while the money is still held';
END $$;

\echo ''
\echo '=== 9. The payout a reviewer approved is the payout that is paid ==='
DO $$
DECLARE v_user BIGINT; v_rate BIGINT; v_id BIGINT;
BEGIN
    SELECT id INTO v_user FROM users WHERE email = 'gc-seller@example.ng';
    SELECT id INTO v_rate FROM giftcard_rate_cards LIMIT 1;

    INSERT INTO giftcard_submissions
      (user_id, reference, idempotency_key, rate_card_id, face_amount_minor,
       face_currency, payout_amount_minor, payout_currency, card_sealed)
    VALUES (v_user, 'gc-price', 'gc-price-key', v_rate, 5000, 'USD', 6250000, 'NGN', 'v1:sealed')
    RETURNING id INTO v_id;

    UPDATE giftcard_submissions SET payout_amount_minor = 9999999 WHERE id = v_id;
    RAISE EXCEPTION 'TEST FAILED: the agreed payout was changed after the fact';
EXCEPTION
    WHEN check_violation THEN
        RAISE NOTICE 'PASS: price and card are frozen at submission';
END $$;

\echo ''
\echo '=== 10. A published rate card is never edited ==='
-- Editing one in place silently rewrites the price of every past trade, which
-- is noticed only when a customer produces a screenshot.
DO $$
DECLARE v_rate BIGINT;
BEGIN
    SELECT id INTO v_rate FROM giftcard_rate_cards LIMIT 1;
    UPDATE giftcard_rate_cards SET payout_rate_minor = 100000 WHERE id = v_rate;
    RAISE EXCEPTION 'TEST FAILED: a published rate was edited';
EXCEPTION
    WHEN check_violation THEN
        RAISE NOTICE 'PASS: rate cards are retired and replaced, never rewritten';
END $$;

\echo ''
\echo '=== 11. One live grant per (user, role) ==='
DO $$
DECLARE v_reviewer BIGINT;
BEGIN
    SELECT id INTO v_reviewer FROM users WHERE email = 'gc-reviewer@example.ng';
    INSERT INTO staff_roles (user_id, role) VALUES (v_reviewer, 'giftcard_reviewer');
    INSERT INTO staff_roles (user_id, role) VALUES (v_reviewer, 'giftcard_reviewer');
    RAISE EXCEPTION 'TEST FAILED: a role was granted twice';
EXCEPTION
    WHEN exclusion_violation THEN
        RAISE NOTICE 'PASS: one live grant per role, and revoked ones stay as history';
END $$;

\echo ''
\echo '=== 12. A customer key is unique PER CUSTOMER, the reference globally ==='
DO $$
DECLARE v_seller BIGINT; v_other BIGINT; v_rate BIGINT;
BEGIN
    SELECT id INTO v_seller FROM users WHERE email = 'gc-seller@example.ng';
    SELECT id INTO v_other  FROM users WHERE email = 'gc-other@example.ng';
    SELECT id INTO v_rate FROM giftcard_rate_cards LIMIT 1;

    -- The same customer key under a DIFFERENT user must be accepted.
    INSERT INTO giftcard_submissions
      (user_id, reference, idempotency_key, rate_card_id, face_amount_minor,
       face_currency, payout_amount_minor, payout_currency, card_sealed)
    VALUES (v_other, 'gc-2', 'gc-1-key', v_rate, 5000, 'USD', 6250000, 'NGN', 'v1:sealed');

    BEGIN
        INSERT INTO giftcard_submissions
          (user_id, reference, idempotency_key, rate_card_id, face_amount_minor,
           face_currency, payout_amount_minor, payout_currency, card_sealed)
        VALUES (v_seller, 'gc-3', 'gc-1-key', v_rate, 5000, 'USD', 6250000, 'NGN', 'v1:sealed');
        RAISE EXCEPTION 'TEST FAILED: a customer reused their own key';
    EXCEPTION
        WHEN unique_violation THEN
            RAISE NOTICE 'PASS: one customer key, one submission, and nobody else is blocked';
    END;
END $$;

\echo ''
\echo '=== 13. The queue shows what is waiting, and only that ==='
DO $$
DECLARE v_waiting BIGINT; v_settled BIGINT;
BEGIN
    SELECT COUNT(*) INTO v_waiting FROM giftcard_review_queue;
    IF v_waiting = 0 THEN
        RAISE EXCEPTION 'TEST FAILED: submissions awaiting review are invisible';
    END IF;

    SELECT COUNT(*) INTO v_settled
      FROM giftcard_review_queue q
      JOIN giftcard_submissions s ON s.id = q.submission_id
     WHERE s.status <> 'pending_review';
    IF v_settled <> 0 THEN
        RAISE EXCEPTION 'TEST FAILED: % reviewed submissions are still queued', v_settled;
    END IF;

    RAISE NOTICE 'PASS: % submissions waiting on a human, and nothing else', v_waiting;
END $$;

\echo ''
\echo '=== 13a. The whole legal lifecycle, end to end ==='
-- Every other block asserts a refusal. This one asserts that the permitted
-- path actually works: without it, a schema that rejected EVERYTHING would
-- pass this suite.
DO $$
DECLARE v_seller BIGINT; v_reviewer BIGINT; v_rate BIGINT; v_id BIGINT;
        v_entry BIGINT; v_release BIGINT; v_status giftcard_status; v_due BIGINT;
BEGIN
    SELECT id INTO v_seller FROM users WHERE email = 'gc-other@example.ng';
    SELECT id INTO v_reviewer FROM users WHERE email = 'gc-reviewer@example.ng';
    SELECT id INTO v_rate FROM giftcard_rate_cards LIMIT 1;

    INSERT INTO giftcard_submissions
      (user_id, reference, idempotency_key, rate_card_id, face_amount_minor,
       face_currency, payout_amount_minor, payout_currency, card_sealed)
    VALUES (v_seller, 'gc-happy', 'gc-happy-key', v_rate, 5000, 'USD', 6250000, 'NGN', 'v1:sealed')
    RETURNING id INTO v_id;

    v_entry := gc_entry('test:gc-happy', v_seller, 6250000);
    UPDATE giftcard_submissions
       SET status = 'approved', reviewed_by = v_reviewer, reviewed_at = now(),
           hold_until = now() - interval '1 minute', approval_entry_id = v_entry
     WHERE id = v_id;

    SELECT COUNT(*) INTO v_due FROM giftcard_holds_due WHERE submission_id = v_id;
    IF v_due <> 1 THEN
        RAISE EXCEPTION 'TEST FAILED: a matured hold is invisible to the release worker';
    END IF;

    v_release := gc_entry('test:gc-happy-rel', v_seller, 1);
    UPDATE giftcard_submissions
       SET status = 'released', release_entry_id = v_release
     WHERE id = v_id;

    SELECT status INTO v_status FROM giftcard_submissions WHERE id = v_id;
    IF v_status <> 'released' THEN
        RAISE EXCEPTION 'TEST FAILED: a matured hold could not be released';
    END IF;

    SELECT COUNT(*) INTO v_due FROM giftcard_holds_due WHERE submission_id = v_id;
    IF v_due <> 0 THEN
        RAISE EXCEPTION 'TEST FAILED: a released hold is still queued for release';
    END IF;

    RAISE NOTICE 'PASS: submitted, reviewed, held, released -- and off the queue';
END $$;

\echo ''
\echo '=== 13b. A clawback WHILE HELD returns the money ==='
DO $$
DECLARE v_seller BIGINT; v_reviewer BIGINT; v_rate BIGINT; v_id BIGINT;
        v_entry BIGINT; v_status giftcard_status;
BEGIN
    SELECT id INTO v_seller FROM users WHERE email = 'gc-other@example.ng';
    SELECT id INTO v_reviewer FROM users WHERE email = 'gc-reviewer@example.ng';
    SELECT id INTO v_rate FROM giftcard_rate_cards LIMIT 1;

    INSERT INTO giftcard_submissions
      (user_id, reference, idempotency_key, rate_card_id, face_amount_minor,
       face_currency, payout_amount_minor, payout_currency, card_sealed)
    VALUES (v_seller, 'gc-claw', 'gc-claw-key', v_rate, 5000, 'USD', 6250000, 'NGN', 'v1:sealed')
    RETURNING id INTO v_id;

    v_entry := gc_entry('test:gc-claw', v_seller, 6250000);
    UPDATE giftcard_submissions
       SET status = 'approved', reviewed_by = v_reviewer, reviewed_at = now(),
           hold_until = now() + interval '3 days', approval_entry_id = v_entry
     WHERE id = v_id;

    UPDATE giftcard_submissions
       SET status = 'clawed_back', clawback_reason = 'issuer voided the card'
     WHERE id = v_id;

    SELECT status INTO v_status FROM giftcard_submissions WHERE id = v_id;
    IF v_status <> 'clawed_back' THEN
        RAISE EXCEPTION 'TEST FAILED: a held payout could not be clawed back';
    END IF;
    RAISE NOTICE 'PASS: a card found bad during its hold is recoverable';
END $$;

\echo ''
\echo '=== 14. A matured hold appears for release; an immature one does not ==='
DO $$
DECLARE v_early BIGINT; v_due BIGINT;
BEGIN
    SELECT COUNT(*) INTO v_early
      FROM giftcard_holds_due d
      JOIN giftcard_submissions s ON s.id = d.submission_id
     WHERE s.hold_until > now();
    IF v_early <> 0 THEN
        RAISE EXCEPTION 'TEST FAILED: % immature holds were offered for release', v_early;
    END IF;

    SELECT COUNT(*) INTO v_due FROM giftcard_holds_due;
    RAISE NOTICE 'PASS: % matured hold(s) queued for release, no early ones', v_due;
END $$;
