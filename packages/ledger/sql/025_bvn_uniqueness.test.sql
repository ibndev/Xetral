-- ===========================================================================
--  Xetral — one person, one account
--  packages/ledger/sql/025_bvn_uniqueness.test.sql
-- ===========================================================================

\set QUIET on
\pset format unaligned
\pset tuples_only on

INSERT INTO users (email, status) VALUES
  ('p25-a@example.ng', 'active'),
  ('p25-b@example.ng', 'active'),
  ('p25-c@example.ng', 'active'),
  ('p25-staff@example.ng', 'active');

-- One fingerprint standing in for one person's BVN, and a second for another.
\set fp1 '''v1:''' || repeat('1', 64) || ''''
\set fp2 '''v1:''' || repeat('2', 64) || ''''

\echo '=== 1. A fingerprint that is not one cannot be stored ==='
-- The CHECK is what makes "computed by blindIndex()" structural rather than
-- customary: a value produced some other way cannot reach a row.
DO $$
DECLARE v_a BIGINT;
BEGIN
    SELECT id INTO v_a FROM users WHERE email = 'p25-a@example.ng';
    INSERT INTO kyc_submissions
      (user_id, full_name, date_of_birth, phone, bvn_sealed, bvn_last4, address,
       bvn_fingerprint)
    VALUES (v_a, 'Ada Obi', '1990-01-01', '+2348010000001', 'v1:x:y:z', '5667',
            'Lagos', '22334455667');
    RAISE EXCEPTION 'TEST FAILED: a raw BVN was stored as a fingerprint';
EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS: only a versioned HMAC can reach the fingerprint column';
END $$;

\echo '=== 2. A submission cannot exist WITHOUT one ==='
-- The silent-off failure this column is NOT NULL to prevent: one submission
-- written without a fingerprint slips past the unique index below, and nothing
-- anywhere fails.
DO $$
DECLARE v_a BIGINT;
BEGIN
    SELECT id INTO v_a FROM users WHERE email = 'p25-a@example.ng';
    INSERT INTO kyc_submissions
      (user_id, full_name, date_of_birth, phone, bvn_sealed, bvn_last4, address)
    VALUES (v_a, 'Ada Obi', '1990-01-01', '+2348010000001', 'v1:x:y:z', '5667', 'Lagos');
    RAISE EXCEPTION 'TEST FAILED: a submission was accepted with no fingerprint';
EXCEPTION WHEN not_null_violation THEN
    RAISE NOTICE 'PASS: every submission carries a fingerprint';
END $$;

\echo '=== 3. TWO PENDING submissions on one BVN are both ACCEPTED ==='
-- Deliberately. Refusing at submission would turn the form into a way to ask
-- "does the owner of this BVN bank here?" — which is worth something to
-- precisely one kind of caller. The reviewer decides, and sees the collision.
DO $$
DECLARE v_a BIGINT; v_b BIGINT;
BEGIN
    SELECT id INTO v_a FROM users WHERE email = 'p25-a@example.ng';
    SELECT id INTO v_b FROM users WHERE email = 'p25-b@example.ng';

    INSERT INTO kyc_submissions
      (user_id, full_name, date_of_birth, phone, bvn_sealed, bvn_last4, address,
       bvn_fingerprint)
    VALUES
      (v_a, 'Ada Obi',   '1990-01-01', '+2348010000001', 'v1:x:y:z', '5667', 'Lagos',
       'v1:' || repeat('1', 64)),
      (v_b, 'Ada O.',    '1990-01-01', '+2348010000002', 'v1:x:y:z', '5667', 'Lagos',
       'v1:' || repeat('1', 64));

    RAISE NOTICE 'PASS: a colliding submission is accepted, and reviewed';
END $$;

\echo '=== 4. The reviewer SEES the collision before they click ==='
DO $$
DECLARE v_a BIGINT; v_b BIGINT; v_staff BIGINT; v_row RECORD; v_id BIGINT;
BEGIN
    SELECT id INTO v_a FROM users WHERE email = 'p25-a@example.ng';
    SELECT id INTO v_b FROM users WHERE email = 'p25-b@example.ng';
    SELECT id INTO v_staff FROM users WHERE email = 'p25-staff@example.ng';

    -- Nothing to see yet: neither is approved.
    IF EXISTS (SELECT 1 FROM kyc_bvn_collisions WHERE pending_user_id = v_b) THEN
        RAISE EXCEPTION 'TEST FAILED: a collision was reported with nothing approved';
    END IF;

    SELECT id INTO v_id FROM kyc_submissions WHERE user_id = v_a AND status = 'pending';
    UPDATE kyc_submissions
       SET status = 'approved', reviewed_by = v_staff, reviewed_at = now()
     WHERE id = v_id;

    SELECT * INTO v_row FROM kyc_bvn_collisions WHERE pending_user_id = v_b;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'TEST FAILED: the pending duplicate was not reported';
    END IF;
    IF v_row.approved_user_id <> v_a THEN
        RAISE EXCEPTION 'TEST FAILED: the view names the wrong approved account';
    END IF;
    RAISE NOTICE 'PASS: a pending duplicate is reported, naming the account that holds it';
END $$;

\echo '=== 5. The view carries NO BVN and NO fingerprint ==='
-- A queue listing that carried either would put the identifying value into a
-- browser tab, a log line and a screenshot every time somebody glanced at it —
-- the lesson 005 records about gift card codes.
DO $$
DECLARE v_col TEXT;
BEGIN
    FOR v_col IN
        SELECT column_name FROM information_schema.columns
         WHERE table_name = 'kyc_bvn_collisions'
    LOOP
        IF v_col ILIKE '%bvn%' OR v_col ILIKE '%fingerprint%' THEN
            RAISE EXCEPTION 'TEST FAILED: the collision view exposes %', v_col;
        END IF;
    END LOOP;
    RAISE NOTICE 'PASS: the reviewer sees that there is a collision, not what it is';
END $$;

\echo '=== 6. A SECOND APPROVAL on one BVN is REFUSED ==='
-- The control. Every per-customer limit in this platform — the daily ceiling,
-- the new-recipient count, the hourly velocity — is only a limit at all if a
-- person cannot cheaply become several customers.
DO $$
DECLARE v_b BIGINT; v_staff BIGINT; v_id BIGINT;
BEGIN
    SELECT id INTO v_b FROM users WHERE email = 'p25-b@example.ng';
    SELECT id INTO v_staff FROM users WHERE email = 'p25-staff@example.ng';
    SELECT id INTO v_id FROM kyc_submissions WHERE user_id = v_b AND status = 'pending';

    UPDATE kyc_submissions
       SET status = 'approved', reviewed_by = v_staff, reviewed_at = now()
     WHERE id = v_id;
    RAISE EXCEPTION 'TEST FAILED: two accounts were approved on one BVN';
EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'PASS: one BVN verifies one account';
END $$;

\echo '=== 7. A REJECTED submission does not block a resubmission ==='
-- A customer rejected for a blurred photograph must be able to try again. A
-- unique index covering rejected rows would refuse them for ever, which is why
-- it is partial on `approved`.
DO $$
DECLARE v_c BIGINT; v_staff BIGINT; v_id BIGINT;
BEGIN
    SELECT id INTO v_c     FROM users WHERE email = 'p25-c@example.ng';
    SELECT id INTO v_staff FROM users WHERE email = 'p25-staff@example.ng';

    INSERT INTO kyc_submissions
      (user_id, full_name, date_of_birth, phone, bvn_sealed, bvn_last4, address,
       bvn_fingerprint)
    VALUES (v_c, 'Chidi Eze', '1988-05-05', '+2348010000003', 'v1:x:y:z', '9988',
            'Abuja', 'v1:' || repeat('2', 64))
    RETURNING id INTO v_id;

    UPDATE kyc_submissions
       SET status = 'rejected', reviewed_by = v_staff, reviewed_at = now(),
           rejection_reason = 'the photograph was unreadable'
     WHERE id = v_id;

    INSERT INTO kyc_submissions
      (user_id, full_name, date_of_birth, phone, bvn_sealed, bvn_last4, address,
       bvn_fingerprint)
    VALUES (v_c, 'Chidi Eze', '1988-05-05', '+2348010000003', 'v1:x:y:z', '9988',
            'Abuja', 'v1:' || repeat('2', 64))
    RETURNING id INTO v_id;

    UPDATE kyc_submissions
       SET status = 'approved', reviewed_by = v_staff, reviewed_at = now()
     WHERE id = v_id;

    RAISE NOTICE 'PASS: a rejected attempt does not lock a customer out for ever';
END $$;

\echo '=== 8. ONE key version is in use ==='
-- More than one means a rotation is half-finished, and while it is the unique
-- index cannot see across the boundary: two accounts on one BVN would both be
-- approvable. That is a real gap, so it fails the build rather than waiting to
-- be noticed.
DO $$
DECLARE v_versions INT;
BEGIN
    SELECT count(*) INTO v_versions FROM kyc_blind_index_versions;
    IF v_versions > 1 THEN
        RAISE EXCEPTION
            'TEST FAILED: % blind index versions are in use; the duplicate-BVN '
            'rule is not enforced across the boundary. Run '
            'scripts/backfill-bvn-fingerprint.mjs --all', v_versions;
    END IF;
    RAISE NOTICE 'PASS: one blind index version, so the rule sees every row';
END $$;
