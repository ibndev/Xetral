-- ============================================================================
--  043 tests. Every block prints PASS or raises TEST FAILED.
--
--  Prefixed `p43:` throughout. `001_ledger.test.sql` has used bare names like
--  `test:fx-1` since Phase 1, and an unprefixed key aborts a whole file on its
--  first block in CI order — Phase 10's finding 10, which cost a CI run.
-- ============================================================================

\set ON_ERROR_STOP on

-- Fixtures: a customer, an account tree and a funded wallet. Written out
-- rather than helper-driven, because `resolve_account()` does not exist and a
-- test that invents one tests nothing.
DO $$
DECLARE
  v_user   BIGINT;
  v_wallet BIGINT;
  v_pend   BIGINT;
  v_float  BIGINT;
  v_entry  BIGINT;
BEGIN
  INSERT INTO users (email, full_name, status)
  VALUES ('p43-payer@example.test', 'Payout Payer', 'active')
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

  -- Fund the wallet, or the overdraft guard refuses the reserve below.
  INSERT INTO journal_entries (idempotency_key, kind, description, occurred_at)
  VALUES ('p43:fund', 'wallet_funding', 'p43 fixture', now()) RETURNING id INTO v_entry;
  INSERT INTO postings (journal_entry_id, account_id, amount_minor, currency)
  VALUES (v_entry, v_float,  -1000000, 'NGN'),
         (v_entry, v_wallet,  1000000, 'NGN');

  -- The reserve the payout row will point at.
  INSERT INTO journal_entries (idempotency_key, kind, description, occurred_at)
  VALUES ('p43:reserve', 'wallet_withdrawal', 'p43 reserve', now()) RETURNING id INTO v_entry;
  INSERT INTO postings (journal_entry_id, account_id, amount_minor, currency)
  VALUES (v_entry, v_wallet, -500000, 'NGN'),
         (v_entry, v_pend,    500000, 'NGN');

  CREATE TEMP TABLE p43 (user_id BIGINT, reserve_entry BIGINT);
  INSERT INTO p43 VALUES (v_user, v_entry);
  RAISE NOTICE 'PASS 0: fixtures';
END $$;

-- ── 1. A payout can be recorded ─────────────────────────────────────────────
DO $$
DECLARE v RECORD;
BEGIN
  SELECT * INTO v FROM p43;
  INSERT INTO bank_payouts
    (user_id, reference, idempotency_key, country, bank_code, bank_name,
     account_number, account_name, currency, amount_minor, fee_minor,
     tax_minor, reserve_entry_id)
  VALUES (v.user_id, 'p43:ref-1', 'key-1', 'NG', '058', 'GTBank',
          '0123456789', 'ADEBAYO O ADEYEMI', 'NGN', 500000, 0, 0,
          v.reserve_entry);
  RAISE NOTICE 'PASS 1: a payout can be recorded';
END $$;

-- ── 2. The destination is IMMUTABLE ─────────────────────────────────────────
--  The reserve is already posted against the customer's balance by the time
--  this row exists, so an UPDATE that moved the account number would send
--  money the customer authorised to somebody they never named — and the
--  ledger would agree, because the amount matched.
DO $$
BEGIN
  BEGIN
    UPDATE bank_payouts SET account_number = '9999999999' WHERE reference = 'p43:ref-1';
    RAISE EXCEPTION 'TEST FAILED 2: the account number was changed after the reserve';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS 2a: the account number cannot be changed';
  END;

  BEGIN
    UPDATE bank_payouts SET amount_minor = 1 WHERE reference = 'p43:ref-1';
    RAISE EXCEPTION 'TEST FAILED 2: the amount was changed after the reserve';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS 2b: the amount cannot be changed';
  END;

  BEGIN
    -- The bank's own answer. Editing it would let a screen show one name
    -- while the money went somewhere the customer never confirmed.
    UPDATE bank_payouts SET account_name = 'SOMEBODY ELSE' WHERE reference = 'p43:ref-1';
    RAISE EXCEPTION 'TEST FAILED 2: the beneficiary name was changed';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS 2c: the beneficiary name cannot be changed';
  END;
END $$;

-- ── 3. The state machine only goes forward ──────────────────────────────────
DO $$
DECLARE v RECORD; v_settle BIGINT;
BEGIN
  SELECT * INTO v FROM p43;
  INSERT INTO journal_entries (idempotency_key, kind, description, occurred_at)
  VALUES ('p43:settle', 'wallet_withdrawal', 'p43 settle', now()) RETURNING id INTO v_settle;
  INSERT INTO postings (journal_entry_id, account_id, amount_minor, currency)
  SELECT v_settle, id, CASE WHEN kind = 'customer_pending' THEN -500000 ELSE 500000 END, 'NGN'
    FROM accounts
   WHERE (kind = 'customer_pending' AND owner_id = v.user_id AND currency = 'NGN')
      OR (kind = 'provider_float' AND owner_id IS NULL AND currency = 'NGN');

  UPDATE bank_payouts
     SET status = 'sent', provider_payout_id = 'po_1', settle_entry_id = v_settle
   WHERE reference = 'p43:ref-1';
  RAISE NOTICE 'PASS 3a: reserved -> sent';

  BEGIN
    UPDATE bank_payouts SET status = 'reserved' WHERE reference = 'p43:ref-1';
    RAISE EXCEPTION 'TEST FAILED 3: a sent payout went back to reserved — money '
                    'that has left cannot become money that is held';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS 3b: sent cannot go back to reserved';
  END;

  UPDATE bank_payouts SET status = 'completed' WHERE reference = 'p43:ref-1';

  BEGIN
    UPDATE bank_payouts SET status = 'failed', failure_reason = 'x'
     WHERE reference = 'p43:ref-1';
    RAISE EXCEPTION 'TEST FAILED 3: a completed payout was reopened';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS 3c: completed is final';
  END;
END $$;

-- ── 4. A failure must SAY WHY ───────────────────────────────────────────────
--  A failed payout with no reason is one a customer cannot be told anything
--  about, and the adapter therefore invents "the provider did not say" rather
--  than sending NULL — this is the constraint that forces that.
DO $$
DECLARE v RECORD;
BEGIN
  SELECT * INTO v FROM p43;
  INSERT INTO bank_payouts
    (user_id, reference, idempotency_key, country, bank_code, bank_name,
     account_number, account_name, currency, amount_minor, reserve_entry_id)
  VALUES (v.user_id, 'p43:ref-2', 'key-2', 'NG', '058', 'GTBank',
          '0123456789', 'A B', 'NGN', 1000, v.reserve_entry);

  BEGIN
    UPDATE bank_payouts SET status = 'failed' WHERE reference = 'p43:ref-2';
    RAISE EXCEPTION 'TEST FAILED 4: a payout failed without saying why';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS 4: a failed payout must carry a reason';
  END;
END $$;

-- ── 5. A payout can never be deleted ────────────────────────────────────────
DO $$
BEGIN
  BEGIN
    DELETE FROM bank_payouts WHERE reference = 'p43:ref-2';
    RAISE EXCEPTION 'TEST FAILED 5: a payout was deleted';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS 5: payouts are append-only';
  END;
END $$;

-- ── 6. A customer key is unique PER CUSTOMER, not globally ──────────────────
--  Two customers WILL send the same key; a client counting from one is enough.
DO $$
DECLARE v RECORD; v_other BIGINT;
BEGIN
  SELECT * INTO v FROM p43;
  INSERT INTO users (email, full_name, status)
  VALUES ('p43-other@example.test', 'Other Payer', 'active') RETURNING id INTO v_other;

  INSERT INTO bank_payouts
    (user_id, reference, idempotency_key, country, bank_code, bank_name,
     account_number, account_name, currency, amount_minor, reserve_entry_id)
  VALUES (v_other, 'p43:ref-3', 'key-1', 'NG', '058', 'GTBank',
          '0123456789', 'A B', 'NGN', 1000, v.reserve_entry);
  RAISE NOTICE 'PASS 6a: two customers may use the same idempotency key';

  BEGIN
    INSERT INTO bank_payouts
      (user_id, reference, idempotency_key, country, bank_code, bank_name,
       account_number, account_name, currency, amount_minor, reserve_entry_id)
    VALUES (v.user_id, 'p43:ref-4', 'key-1', 'NG', '058', 'GTBank',
            '0123456789', 'A B', 'NGN', 1000, v.reserve_entry);
    RAISE EXCEPTION 'TEST FAILED 6: one customer reused a key and got a second payout';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'PASS 6b: one customer cannot reuse a key';
  END;
END $$;

-- ── 7. The tax cannot exceed the fee ────────────────────────────────────────
--  Remitting more tax than was charged means remitting money nobody paid.
DO $$
DECLARE v RECORD;
BEGIN
  SELECT * INTO v FROM p43;
  BEGIN
    INSERT INTO bank_payouts
      (user_id, reference, idempotency_key, country, bank_code, bank_name,
       account_number, account_name, currency, amount_minor, fee_minor,
       tax_minor, reserve_entry_id)
    VALUES (v.user_id, 'p43:ref-5', 'key-5', 'NG', '058', 'GTBank',
            '0123456789', 'A B', 'NGN', 1000, 10, 50, v.reserve_entry);
    RAISE EXCEPTION 'TEST FAILED 7: more tax than fee was recorded';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS 7: the tax cannot exceed the fee';
  END;
END $$;

-- ── 8. An account number has to look like one ───────────────────────────────
DO $$
DECLARE v RECORD;
BEGIN
  SELECT * INTO v FROM p43;
  BEGIN
    INSERT INTO bank_payouts
      (user_id, reference, idempotency_key, country, bank_code, bank_name,
       account_number, account_name, currency, amount_minor, reserve_entry_id)
    VALUES (v.user_id, 'p43:ref-6', 'key-6', 'NG', '058', 'GTBank',
            '012-345-678', 'A B', 'NGN', 1000, v.reserve_entry);
    RAISE EXCEPTION 'TEST FAILED 8: a non-numeric account number was stored';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS 8: an account number must be digits';
  END;
END $$;

-- ── 9. The stuck view sees what nothing else can ────────────────────────────
--  A payout held in `reserved` is invisible to every other check: the ledger
--  balances, `ledger_drift` reports nothing, and the customer's balance is
--  simply down.
DO $$
DECLARE n INT;
BEGIN
  UPDATE bank_payouts SET created_at = now() - INTERVAL '3 hours'
   WHERE reference = 'p43:ref-2';

  SELECT COUNT(*) INTO n FROM bank_payouts_stuck WHERE id IN (
    SELECT id FROM bank_payouts WHERE reference = 'p43:ref-2');
  IF n <> 1 THEN
    RAISE EXCEPTION 'TEST FAILED 9: a payout held for three hours is not in the queue';
  END IF;

  -- And a fresh one is NOT, or the queue is noise on its first day.
  SELECT COUNT(*) INTO n FROM bank_payouts_stuck WHERE id IN (
    SELECT id FROM bank_payouts WHERE reference = 'p43:ref-3');
  IF n <> 0 THEN
    RAISE EXCEPTION 'TEST FAILED 9: a payout reserved moments ago is already flagged';
  END IF;

  RAISE NOTICE 'PASS 9: the stuck queue sees a held payout and ignores a fresh one';
END $$;

-- ── 10. The overview carries it ─────────────────────────────────────────────
--  036's whole argument: an incomplete list that looks complete is trusted,
--  and that is worse than no overview.
DO $$
DECLARE n INT;
BEGIN
  SELECT COUNT(*) INTO n FROM admin_work_queue WHERE queue = 'bank_payouts_stuck';
  IF n <> 1 THEN
    RAISE EXCEPTION 'TEST FAILED 10: the work queue does not carry bank payouts';
  END IF;
  RAISE NOTICE 'PASS 10: the overview carries the payout queue';
END $$;

-- ── 11. The kill switch exists and is ON ────────────────────────────────────
DO $$
DECLARE v TEXT;
BEGIN
  SELECT value INTO v FROM platform_settings WHERE key = 'payouts_enabled';
  IF v IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION 'TEST FAILED 11: payouts_enabled is % rather than true', v;
  END IF;
  RAISE NOTICE 'PASS 11: the payout kill switch ships on';
END $$;
