-- ============================================================================
--  085 invariants — a verified tier rests on a reviewed identity
-- ============================================================================
\set ON_ERROR_STOP on

INSERT INTO users (email, status) VALUES
  ('p85-plain@example.ng', 'active'),
  ('p85-reviewed@example.ng', 'active'),
  ('p85-reviewer@example.ng', 'active');

-- 1. Tier 1 with no approved submission is refused.
DO $$
DECLARE v_u BIGINT;
BEGIN
    SELECT id INTO v_u FROM users WHERE email = 'p85-plain@example.ng';
    UPDATE users SET kyc_tier = 1 WHERE id = v_u;
    RAISE EXCEPTION 'TEST FAILED: tier 1 was granted with no reviewed identity';
EXCEPTION WHEN restrict_violation THEN
    RAISE NOTICE 'PASS: a verified tier needs a reviewed identity';
END $$;

-- 2. With an approved submission (which carries a BVN), it is allowed.
INSERT INTO kyc_submissions
  (user_id, full_name, date_of_birth, phone, bvn_sealed, bvn_last4, bvn_fingerprint,
   address, status, reviewed_by, reviewed_at)
SELECT r.id, 'Adaeze Okonkwo', '1990-01-01', '+2348031234567', 'v1:p85-sealed', '1234',
       'v1:' || repeat('8', 64), '1 Test Street, Lagos', 'approved', s.id, now()
  FROM users r, users s
 WHERE r.email = 'p85-reviewed@example.ng' AND s.email = 'p85-reviewer@example.ng';

DO $$
DECLARE v_u BIGINT;
BEGIN
    SELECT id INTO v_u FROM users WHERE email = 'p85-reviewed@example.ng';
    UPDATE users SET kyc_tier = 1 WHERE id = v_u;
    RAISE NOTICE 'PASS: a reviewed identity may be verified';
END $$;

-- 3. Going down is never refused.
DO $$
DECLARE v_u BIGINT;
BEGIN
    SELECT id INTO v_u FROM users WHERE email = 'p85-reviewed@example.ng';
    UPDATE users SET kyc_tier = 0 WHERE id = v_u;
    RAISE NOTICE 'PASS: a tier can always be taken away';
END $$;

-- 4. Nobody is left verified without one.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM users u WHERE u.kyc_tier >= 1
                AND NOT EXISTS (SELECT 1 FROM kyc_submissions k
                                 WHERE k.user_id = u.id AND k.status = 'approved')) THEN
        RAISE EXCEPTION 'TEST FAILED: an account is verified with no reviewed identity';
    END IF;
    RAISE NOTICE 'PASS: every verified account has a reviewed identity';
END $$;
