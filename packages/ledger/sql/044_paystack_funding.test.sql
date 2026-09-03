-- ============================================================================
--  044 tests. Every block prints PASS or raises TEST FAILED.
-- ============================================================================

\set ON_ERROR_STOP on

-- ── 1. The rail is a setting, and it defaults to Paystack ───────────────────
DO $$
DECLARE v TEXT;
BEGIN
  SELECT value INTO v FROM platform_settings WHERE key = 'funding_provider';
  IF v IS DISTINCT FROM 'paystack' THEN
    RAISE EXCEPTION 'TEST FAILED 1: funding_provider is % rather than paystack', v;
  END IF;
  RAISE NOTICE 'PASS 1: naira funding defaults to Paystack';
END $$;

-- ── 2. It can be switched, and only to something meaningful ────────────────
--  TEXT rather than a boolean, because "not Paystack" will not always mean
--  Bitnob. A third rail should be a new value and an adapter, not an
--  inversion of a flag whose name has stopped describing what it does.
DO $$
DECLARE v TEXT;
BEGIN
  UPDATE platform_settings SET value = 'bitnob' WHERE key = 'funding_provider';
  SELECT value INTO v FROM platform_settings WHERE key = 'funding_provider';
  IF v <> 'bitnob' THEN
    RAISE EXCEPTION 'TEST FAILED 2: the rail could not be switched';
  END IF;
  UPDATE platform_settings SET value = 'paystack' WHERE key = 'funding_provider';
  RAISE NOTICE 'PASS 2: the rail can be switched without a deploy';
END $$;

-- ── 3. The credential slot exists, and there is only ONE ───────────────────
--  Paystack signs webhooks with the same key it authenticates calls with, so
--  a second "webhook secret" slot would be a box an operator fills with a
--  value nothing reads — the failure 026 exists to prevent.
DO $$
DECLARE n INT;
BEGIN
  SELECT count(*) INTO n FROM provider_credential_slots
   WHERE provider = 'paystack' AND in_use;
  IF n <> 1 THEN
    RAISE EXCEPTION 'TEST FAILED 3: expected exactly 1 live Paystack slot, found %', n;
  END IF;

  PERFORM 1 FROM provider_credential_slots
   WHERE provider = 'paystack' AND name = 'secret_key';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'TEST FAILED 3: the Paystack secret key slot is missing';
  END IF;
  RAISE NOTICE 'PASS 3: one Paystack credential, which is all Paystack has';
END $$;

-- ── 4. The sweep has somewhere to look ──────────────────────────────────────
--  `deposit-reconciliation` is the only thing that finds a webhook which never
--  arrived. It runs from `provider_account_id`, which cannot work for
--  Paystack: their transaction list is a CUSTOMER-level query. Without this
--  column the sweep would silently stop working for the DEFAULT provider —
--  a worker that runs, reports nothing and finds nothing.
DO $$
BEGIN
  PERFORM 1 FROM information_schema.columns
   WHERE table_name = 'virtual_accounts' AND column_name = 'provider_customer_ref';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'TEST FAILED 4: virtual_accounts has nowhere to record a '
                    'provider customer reference, so the Paystack sweep cannot run';
  END IF;
  RAISE NOTICE 'PASS 4: the reconciliation sweep has a customer reference to use';
END $$;

-- ── 5. It is NULLABLE, deliberately ─────────────────────────────────────────
--  Bitnob genuinely has nothing to put there. A NOT NULL column with an
--  invented value would make "this rail does not need one" indistinguishable
--  from "somebody forgot".
DO $$
DECLARE v TEXT;
BEGIN
  SELECT is_nullable INTO v FROM information_schema.columns
   WHERE table_name = 'virtual_accounts' AND column_name = 'provider_customer_ref';
  IF v <> 'YES' THEN
    RAISE EXCEPTION 'TEST FAILED 5: provider_customer_ref is NOT NULL, so a rail '
                    'that has no customer reference cannot say so';
  END IF;
  RAISE NOTICE 'PASS 5: a rail with no customer reference can leave it empty';
END $$;

-- ── 6. But an EMPTY STRING is refused ───────────────────────────────────────
--  Null means "this rail has none". Empty string means "somebody wrote
--  nothing", and the two must not be the same value.
DO $$
DECLARE v_user BIGINT;
BEGIN
  INSERT INTO users (email, full_name, status)
  VALUES ('p44-ref@example.test', 'Ref Tester', 'active') RETURNING id INTO v_user;

  BEGIN
    INSERT INTO virtual_accounts
      (user_id, provider, provider_account_id, provider_customer_ref,
       account_number, bank_name, account_name, currency, status)
    VALUES (v_user, 'paystack', 'dva_1', '  ',
            '9900112233', 'Wema Bank', 'REF TESTER', 'NGN', 'active');
    RAISE EXCEPTION 'TEST FAILED 6: a blank customer reference was accepted';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS 6: a blank customer reference is refused';
  END;
END $$;

-- ── 7. An account records WHO issued it ─────────────────────────────────────
--  A customer's number is permanent and their bank has it saved, so switching
--  the setting must not relabel accounts already out there.
DO $$
DECLARE v_user BIGINT; v TEXT;
BEGIN
  SELECT id INTO v_user FROM users WHERE email = 'p44-ref@example.test';

  INSERT INTO virtual_accounts
    (user_id, provider, provider_account_id, provider_customer_ref,
     account_number, bank_name, account_name, currency, status)
  VALUES (v_user, 'paystack', 'dva_1', 'CUS_abc',
          '9900112233', 'Wema Bank', 'REF TESTER', 'NGN', 'active');

  -- Switch the platform to the other rail. The row must not move.
  UPDATE platform_settings SET value = 'bitnob' WHERE key = 'funding_provider';

  SELECT provider INTO v FROM virtual_accounts WHERE account_number = '9900112233';
  IF v <> 'paystack' THEN
    RAISE EXCEPTION 'TEST FAILED 7: switching the setting changed who an existing '
                    'account belongs to (now %)', v;
  END IF;

  UPDATE platform_settings SET value = 'paystack' WHERE key = 'funding_provider';
  RAISE NOTICE 'PASS 7: an issued account stays with the rail that issued it';
END $$;
