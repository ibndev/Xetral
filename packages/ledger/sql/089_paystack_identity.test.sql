-- ============================================================================
--  089 invariants — naira accounts on the assigned rail alone, and the record
--  of identifying a customer to it
-- ============================================================================
\set ON_ERROR_STOP on

-- 0. Fixtures: three customers. Fingerprints are digests of this suite's own
--    names, so they cannot collide with another suite's on the shared database.
DO $$
BEGIN
  INSERT INTO users (email, full_name, status) VALUES
    ('p89-a@example.test', 'Ada Obi', 'active'),
    ('p89-b@example.test', 'Bola Ade', 'active'),
    ('p89-c@example.test', 'Chidi Eze', 'active');
  RAISE NOTICE 'PASS 0: fixtures';
END $$;

-- 1. The fallback is off, and off by default.
DO $$
DECLARE v_default TEXT;
BEGIN
  IF EXISTS (SELECT 1 FROM provider_routing_policy WHERE account_fallback) THEN
    RAISE EXCEPTION 'TEST FAILED: account_fallback is still on after 089';
  END IF;
  SELECT column_default INTO v_default FROM information_schema.columns
   WHERE table_name = 'provider_routing_policy' AND column_name = 'account_fallback';
  IF v_default IS DISTINCT FROM 'false' THEN
    RAISE EXCEPTION 'TEST FAILED: account_fallback defaults to %, not false', v_default;
  END IF;
  RAISE NOTICE 'PASS 1: a refused account request goes to no other rail unless an operator says so';
END $$;

-- 2. A raw BVN cannot be stored as a fingerprint.
DO $$
BEGIN
  INSERT INTO account_identity_checks
    (user_id, provider, bvn_fingerprint, bvn_last4, bank_code, account_last4)
  SELECT id, 'paystack', '22233344455', '4455', '058', '6789'
    FROM users WHERE email = 'p89-a@example.test';
  RAISE EXCEPTION 'TEST FAILED: a raw BVN reached a row';
EXCEPTION WHEN check_violation THEN
  RAISE NOTICE 'PASS 2: only a keyed fingerprint is stored';
END $$;

-- 3. One BVN, one customer — a second customer is refused while the first's
--    check stands.
DO $$
BEGIN
  INSERT INTO account_identity_checks
    (user_id, provider, bvn_fingerprint, bvn_last4, bank_code, account_last4)
  SELECT id, 'paystack', 'v1:' || encode(sha256('p89-a'::bytea), 'hex'), '4455', '058', '6789'
    FROM users WHERE email = 'p89-a@example.test';

  BEGIN
    INSERT INTO account_identity_checks
      (user_id, provider, bvn_fingerprint, bvn_last4, bank_code, account_last4)
    SELECT id, 'paystack', 'v1:' || encode(sha256('p89-a'::bytea), 'hex'), '4455', '044', '1111'
      FROM users WHERE email = 'p89-b@example.test';
    RAISE EXCEPTION 'TEST FAILED: one BVN was sent for two customers';
  EXCEPTION WHEN unique_violation THEN
    IF SQLERRM NOT LIKE '%another customer%' THEN
      RAISE EXCEPTION 'TEST FAILED: refused for the wrong reason: %', SQLERRM;
    END IF;
  END;
  RAISE NOTICE 'PASS 3: a BVN standing for one customer is refused for another';
END $$;

-- 4. The same customer may try again with the same BVN — a mistyped bank is
--    not a second person.
DO $$
BEGIN
  INSERT INTO account_identity_checks
    (user_id, provider, bvn_fingerprint, bvn_last4, bank_code, account_last4)
  SELECT id, 'paystack', 'v1:' || encode(sha256('p89-a'::bytea), 'hex'), '4455', '057', '6789'
    FROM users WHERE email = 'p89-a@example.test';
  RAISE NOTICE 'PASS 4: a customer may resubmit their own BVN';
END $$;

-- 5. A failed check does not hold a BVN: somebody typing another person's BVN
--    against the wrong account must not lock its owner out.
DO $$
BEGIN
  UPDATE account_identity_checks SET status = 'failed', reason = 'no match', resolved_at = now()
   WHERE user_id = (SELECT id FROM users WHERE email = 'p89-a@example.test');
  INSERT INTO account_identity_checks
    (user_id, provider, bvn_fingerprint, bvn_last4, bank_code, account_last4)
  SELECT id, 'paystack', 'v1:' || encode(sha256('p89-a'::bytea), 'hex'), '4455', '044', '1111'
    FROM users WHERE email = 'p89-b@example.test';
  RAISE NOTICE 'PASS 5: only a check that did not fail stands for a customer';
END $$;

-- 6. A BVN on another customer's PENDING KYC submission is refused too.
DO $$
BEGIN
  INSERT INTO kyc_submissions
    (user_id, full_name, date_of_birth, phone, bvn_sealed, bvn_last4, address, bvn_fingerprint)
  SELECT id, 'Chidi Eze', '1990-01-01', '+2348010000089', 'v1:x:y:z', '9999', 'Lagos',
         'v1:' || encode(sha256('p89-c'::bytea), 'hex')
    FROM users WHERE email = 'p89-c@example.test';

  BEGIN
    INSERT INTO account_identity_checks
      (user_id, provider, bvn_fingerprint, bvn_last4, bank_code, account_last4)
    SELECT id, 'paystack', 'v1:' || encode(sha256('p89-c'::bytea), 'hex'), '9999', '058', '2222'
      FROM users WHERE email = 'p89-a@example.test';
    RAISE EXCEPTION 'TEST FAILED: a BVN on another customer''s KYC was sent to a rail';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  RAISE NOTICE 'PASS 6: the check reads kyc_submissions as well';
END $$;

-- 7. An outcome is set once, and what was sent never changes.
DO $$
DECLARE v_id BIGINT;
BEGIN
  SELECT id INTO v_id FROM account_identity_checks
   WHERE user_id = (SELECT id FROM users WHERE email = 'p89-b@example.test');
  UPDATE account_identity_checks SET status = 'validated', resolved_at = now() WHERE id = v_id;

  BEGIN
    UPDATE account_identity_checks SET status = 'failed' WHERE id = v_id;
    RAISE EXCEPTION 'TEST FAILED: a validated check was re-decided';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  BEGIN
    UPDATE account_identity_checks SET bank_code = '999' WHERE id = v_id;
    RAISE EXCEPTION 'TEST FAILED: what was sent was edited';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  BEGIN
    DELETE FROM account_identity_checks WHERE id = v_id;
    RAISE EXCEPTION 'TEST FAILED: an identity check was deleted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  RAISE NOTICE 'PASS 7: outcomes are final and the record is append-only';
END $$;

-- 8. A resolution carries its time.
DO $$
BEGIN
  INSERT INTO account_identity_checks
    (user_id, provider, bvn_fingerprint, bvn_last4, bank_code, account_last4, status)
  SELECT id, 'paystack', 'v1:' || encode(sha256('p89-d'::bytea), 'hex'), '1234', '058', '3333', 'failed'
    FROM users WHERE email = 'p89-c@example.test';
  RAISE EXCEPTION 'TEST FAILED: an outcome was recorded with no time';
EXCEPTION WHEN check_violation THEN
  RAISE NOTICE 'PASS 8: an outcome is dated';
END $$;

-- 9. The notice naming Paystack is live — and exactly one privacy notice is.
--    PROPERTIES, not a version: a later republish legitimately moves it (075).
DO $$
BEGIN
  IF (SELECT count(*) FROM consent_documents WHERE kind = 'privacy' AND retired_at IS NULL) <> 1 THEN
    RAISE EXCEPTION 'TEST FAILED: not exactly one live privacy notice';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM consent_documents
                  WHERE kind = 'privacy' AND retired_at IS NULL AND version >= '2026-09-30') THEN
    RAISE EXCEPTION 'TEST FAILED: the live privacy notice predates naming Paystack as a BVN recipient';
  END IF;
  IF EXISTS (SELECT 1 FROM consent_documents
              WHERE kind = 'privacy' AND retired_at IS NULL AND version < '2026-09-30') THEN
    RAISE EXCEPTION 'TEST FAILED: an older privacy notice is still live';
  END IF;
  RAISE NOTICE 'PASS 9: the notice says it before the first BVN leaves';
END $$;

-- 10. Decided for retention, and the diagnostics rows 089 answered are gone.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM retention_decisions WHERE table_name = 'account_identity_checks') THEN
    RAISE EXCEPTION 'TEST FAILED: account_identity_checks has no retention decision';
  END IF;
  IF EXISTS (SELECT 1 FROM account_refusals
              WHERE currency = 'NGN' AND rail = 'paystack'
                AND lower(reason) LIKE '%not been identified%') THEN
    RAISE EXCEPTION 'TEST FAILED: a refusal 089 answered is still on the diagnostics screen';
  END IF;
  RAISE NOTICE 'PASS 10: retention decided, stale refusals cleared';
END $$;
