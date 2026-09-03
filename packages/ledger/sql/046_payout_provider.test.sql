-- ============================================================================
--  046 tests. Every block prints PASS or raises TEST FAILED.
-- ============================================================================

\set ON_ERROR_STOP on

-- ── 1. The payout rail is a setting, and it defaults to Paystack ───────────
--  Paystack is the default because it is the rail the shipped deployment
--  already holds a credential for. Defaulting to Bitnob is what produced the
--  bug: a port whose every method refused, and a Send screen reporting that
--  the bank list could not be loaded.
DO $$
DECLARE v TEXT;
BEGIN
  SELECT value INTO v FROM platform_settings WHERE key = 'payout_provider';
  IF v IS DISTINCT FROM 'paystack' THEN
    RAISE EXCEPTION 'TEST FAILED 1: payout_provider is % rather than paystack', v;
  END IF;
  RAISE NOTICE 'PASS 1: bank payouts default to Paystack';
END $$;

-- ── 2. It is SEPARATE from funding_provider ────────────────────────────────
--  Money in and money out are different approvals: a business can be live for
--  dedicated accounts and not yet for transfers. One setting covering both
--  would make enabling either mean claiming both.
DO $$
DECLARE n INT;
BEGIN
  SELECT count(*) INTO n
    FROM platform_settings
   WHERE key IN ('funding_provider', 'payout_provider');
  IF n <> 2 THEN
    RAISE EXCEPTION 'TEST FAILED 2: expected two independent rail settings, found %', n;
  END IF;

  UPDATE platform_settings SET value = 'bitnob' WHERE key = 'payout_provider';
  IF (SELECT value FROM platform_settings WHERE key = 'funding_provider') <> 'paystack' THEN
    RAISE EXCEPTION 'TEST FAILED 2: switching the payout rail moved the funding rail';
  END IF;
  UPDATE platform_settings SET value = 'paystack' WHERE key = 'payout_provider';

  RAISE NOTICE 'PASS 2: the two rails are switched independently';
END $$;

-- ── 3. A payout records WHO SENT IT ────────────────────────────────────────
--  A provider-side payout id is opaque and only its issuer can resolve it, so
--  a row without a provider is a payout that becomes unreadable the moment a
--  second rail exists — and an unreadable payout is one nothing can settle or
--  reverse.
DO $$
DECLARE v RECORD;
BEGIN
  SELECT id AS user_id INTO v FROM users ORDER BY id LIMIT 1;

  INSERT INTO journal_entries (kind, idempotency_key, description, occurred_at)
  VALUES ('wallet_withdrawal', 'p46:reserve-1', 'reserve', now())
  RETURNING id INTO v;

  INSERT INTO bank_payouts
    (user_id, reference, idempotency_key, country, bank_code, bank_name,
     account_number, account_name, currency, amount_minor, reserve_entry_id)
  VALUES ((SELECT id FROM users ORDER BY id LIMIT 1),
          'p46:ref-1', 'p46-key-1', 'NG', '058', 'GTBank',
          '0123456789', 'A B', 'NGN', 1000, v.id);

  IF (SELECT provider FROM bank_payouts WHERE reference = 'p46:ref-1') <> 'bitnob' THEN
    RAISE EXCEPTION 'TEST FAILED 3: a payout row does not record its issuer';
  END IF;
  RAISE NOTICE 'PASS 3: a payout records which rail sent it';
END $$;

-- ── 4. And the issuer cannot be changed afterwards ─────────────────────────
--  The same rule 043 applies to the destination. Changing it would make
--  `status()` ask the wrong provider about a payout, so the answer to "did
--  this leave?" would come from a rail that never saw it.
DO $$
BEGIN
  BEGIN
    UPDATE bank_payouts SET provider = 'paystack' WHERE reference = 'p46:ref-1';
    RAISE EXCEPTION 'TEST FAILED 4: a payout''s issuer could be rewritten';
  EXCEPTION WHEN OTHERS THEN
    IF position('provider cannot change' in SQLERRM) = 0 THEN
      RAISE EXCEPTION 'TEST FAILED 4: wrong refusal: %', SQLERRM;
    END IF;
  END;
  RAISE NOTICE 'PASS 4: a payout''s issuer is immutable';
END $$;

-- ── 5. The default did not relabel rows that predate the column ────────────
--  Every payout written before this migration was sent by the only adapter
--  there was. A default of 'paystack' would describe real money as having
--  left through a rail that had not been built when it did.
DO $$
DECLARE n INT;
BEGIN
  SELECT count(*) INTO n FROM bank_payouts WHERE provider = 'paystack';
  IF n > 0 THEN
    RAISE EXCEPTION
      'TEST FAILED 5: % payouts are attributed to a rail that did not exist when they were sent', n;
  END IF;
  RAISE NOTICE 'PASS 5: existing payouts keep the rail that actually sent them';
END $$;
