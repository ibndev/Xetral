-- ============================================================================
--  088 invariants — a payout whose reserve moved nothing is not held money
-- ============================================================================
\set ON_ERROR_STOP on

-- 0. Fixtures: one real reserved payout, one hollow one, same customer.
DO $$
DECLARE
  v_user   BIGINT;
  v_wallet BIGINT;
  v_pend   BIGINT;
  v_float  BIGINT;
  v_entry  BIGINT;
  v_hollow BIGINT;
BEGIN
  INSERT INTO users (email, full_name, status)
  VALUES ('p88-payer@example.test', 'Hollow Payer', 'active')
  RETURNING id INTO v_user;

  INSERT INTO accounts (kind, owner_id, currency, normal_balance)
  VALUES ('customer_wallet', v_user, 'NGN', 'credit') RETURNING id INTO v_wallet;
  INSERT INTO accounts (kind, owner_id, currency, normal_balance)
  VALUES ('customer_pending', v_user, 'NGN', 'credit') RETURNING id INTO v_pend;

  SELECT id INTO v_float FROM accounts
   WHERE kind = 'provider_float' AND currency = 'NGN' AND owner_id IS NULL;
  IF v_float IS NULL THEN
    INSERT INTO accounts (kind, owner_id, currency, normal_balance)
    VALUES ('provider_float', NULL, 'NGN', 'debit') RETURNING id INTO v_float;
  END IF;

  INSERT INTO journal_entries (idempotency_key, kind, description, occurred_at)
  VALUES ('p88:fund', 'wallet_funding', 'p88 fixture', now()) RETURNING id INTO v_entry;
  INSERT INTO postings (journal_entry_id, account_id, amount_minor, currency)
  VALUES (v_entry, v_float, -100000, 'NGN'), (v_entry, v_wallet, 100000, 'NGN');

  INSERT INTO journal_entries (idempotency_key, kind, description, occurred_at)
  VALUES ('p88:reserve-real', 'wallet_withdrawal', 'p88 real', now()) RETURNING id INTO v_entry;
  INSERT INTO postings (journal_entry_id, account_id, amount_minor, currency)
  VALUES (v_entry, v_wallet, -50000, 'NGN'), (v_entry, v_pend, 50000, 'NGN');

  -- Exactly what 080's suite writes: an entry and no postings.
  INSERT INTO journal_entries (idempotency_key, kind, description, occurred_at)
  VALUES ('p88:reserve-hollow', 'wallet_withdrawal', 'p88 hollow', now()) RETURNING id INTO v_hollow;

  INSERT INTO bank_payouts
    (user_id, reference, idempotency_key, country, bank_code, bank_name,
     account_number, account_name, currency, amount_minor, reserve_entry_id)
  VALUES (v_user, 'p88-real', 'p88-key-real', 'NG', '058', 'GTBank', '0123456789',
          'A Person', 'NGN', 50000, v_entry),
         (v_user, 'p88-hollow', 'p88-key-hollow', 'NG', '058', 'GTBank', '0123456789',
          'A Person', 'NGN', 1000, v_hollow);
  RAISE NOTICE 'PASS 0: fixtures';
END $$;

-- 1. The recovery queue offers the real payout and not the hollow one.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM money_awaiting_recovery m JOIN bank_payouts p ON p.uuid = m.subject_uuid
                  WHERE p.reference = 'p88-real') THEN
    RAISE EXCEPTION 'TEST FAILED 1: a real held payout is missing from recovery';
  END IF;
  IF EXISTS (SELECT 1 FROM money_awaiting_recovery m JOIN bank_payouts p ON p.uuid = m.subject_uuid
              WHERE p.reference = 'p88-hollow') THEN
    RAISE EXCEPTION 'TEST FAILED 1: a payout that held nothing is offered for recovery';
  END IF;
  RAISE NOTICE 'PASS 1: only a payout that held money is money awaiting recovery';
END $$;

-- 2. Closing fails the hollow one with a reason and leaves the real one held.
DO $$
DECLARE n INTEGER;
BEGIN
  n := fail_hollow_payouts();
  IF n < 1 THEN RAISE EXCEPTION 'TEST FAILED 2: nothing was closed'; END IF;
  IF (SELECT status::text FROM bank_payouts WHERE reference = 'p88-hollow') <> 'failed'
     OR (SELECT failure_reason FROM bank_payouts WHERE reference = 'p88-hollow') NOT LIKE 'not a real payout%' THEN
    RAISE EXCEPTION 'TEST FAILED 2: the hollow payout was not failed with its reason';
  END IF;
  IF (SELECT status::text FROM bank_payouts WHERE reference = 'p88-real') <> 'reserved' THEN
    RAISE EXCEPTION 'TEST FAILED 2: a real held payout was touched';
  END IF;
  IF fail_hollow_payouts() <> 0 THEN
    RAISE EXCEPTION 'TEST FAILED 2: a second run closed something again';
  END IF;
  RAISE NOTICE 'PASS 2: a hollow payout is failed, a real one is left alone, and it runs twice';
END $$;

-- 3. Nothing was posted: closing a hollow payout moves no money.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM journal_entries WHERE reverses_id =
              (SELECT reserve_entry_id FROM bank_payouts WHERE reference = 'p88-hollow')) THEN
    RAISE EXCEPTION 'TEST FAILED 3: a reversal was posted for an entry that moved nothing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM hollow_payouts WHERE reference = 'p88-hollow' AND status = 'failed') THEN
    RAISE EXCEPTION 'TEST FAILED 3: the record does not keep the closed row';
  END IF;
  RAISE NOTICE 'PASS 3: closed without a posting, and still on the record';
END $$;
