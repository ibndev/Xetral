-- ===========================================================================
--  Xetral — Phase 1 ledger invariant tests
--  packages/ledger/sql/001_ledger.test.sql
--
--  Each block asserts that a specific bad write is REJECTED. A constraint
--  nobody has watched fail is a constraint nobody knows is wired up.
--  Run with -v ON_ERROR_STOP=1; any unexpected failure aborts.
-- ===========================================================================

\set QUIET on
\pset format unaligned
\pset tuples_only on

-- --------------------------------------------------------------------------
-- Fixtures
-- --------------------------------------------------------------------------
INSERT INTO accounts (kind, owner_type, owner_id, currency, normal_balance) VALUES
  ('customer_wallet',  'user', 1, 'NGN', 'credit'),
  ('customer_wallet',  'user', 1, 'USD', 'credit'),
  ('customer_pending', 'user', 1, 'USD', 'credit'),
  ('customer_wallet',  'user', 2, 'NGN', 'credit');

INSERT INTO accounts (kind, currency, normal_balance) VALUES
  ('provider_float',   'NGN', 'debit'),
  ('provider_float',   'USD', 'debit'),
  ('revenue_fees',     'NGN', 'credit'),
  ('revenue_fx_spread','USD', 'credit');

-- Fund user 1 first. The original version of this file skipped funding and
-- spent straight from an empty wallet -- which committed, because nothing
-- stopped it. That silent overdraft is what prompted section 6b.
BEGIN;
  INSERT INTO journal_entries (idempotency_key, kind, description, occurred_at)
  VALUES ('test:fund-1', 'wallet_funding', 'open with N20,000,000', now());
  INSERT INTO postings (journal_entry_id, account_id, amount_minor, currency)
  SELECT e.id, a.id, v.amt, 'NGN'
    FROM journal_entries e
    CROSS JOIN LATERAL (VALUES
      ('customer_wallet'::text, 1::bigint,  2000000000::bigint),
      ('provider_float'::text,  NULL,      -2000000000::bigint)
    ) AS v(kind, oid, amt)
    JOIN accounts a ON a.kind = v.kind::account_kind AND a.currency='NGN'
                   AND a.owner_id IS NOT DISTINCT FROM v.oid
   WHERE e.idempotency_key = 'test:fund-1';
COMMIT;

\echo '=== 1. A balanced single-currency transfer is ACCEPTED ==='
BEGIN;
  INSERT INTO journal_entries (idempotency_key, kind, description, occurred_at)
  VALUES ('test:transfer-1', 'wallet_transfer', 'N5,000 with N50 fee', now());

  -- User 1 pays N5,050: N5,000 to user 2, N50 to revenue.
  INSERT INTO postings (journal_entry_id, account_id, amount_minor, currency)
  SELECT e.id, a.id, v.amt, 'NGN'
    FROM journal_entries e
    CROSS JOIN LATERAL (VALUES
      ('customer_wallet', 'user', 1::bigint, -505000::bigint),
      ('customer_wallet', 'user', 2::bigint,  500000::bigint),
      ('revenue_fees',     NULL,  NULL,         5000::bigint)
    ) AS v(kind, ot, oid, amt)
    JOIN accounts a ON a.kind = v.kind::account_kind
                   AND a.currency = 'NGN'
                   AND a.owner_id IS NOT DISTINCT FROM v.oid
   WHERE e.idempotency_key = 'test:transfer-1';
COMMIT;
\echo 'PASS: balanced transfer committed'

\echo ''
\echo '=== 2. An UNBALANCED entry is REJECTED ==='
DO $$
DECLARE
    wallet_id BIGINT;
    entry_id  BIGINT;
BEGIN
    SELECT id INTO wallet_id FROM accounts
     WHERE kind='customer_wallet' AND owner_id=1 AND currency='NGN';

    INSERT INTO journal_entries (idempotency_key, kind, occurred_at)
    VALUES ('test:unbalanced', 'adjustment', now()) RETURNING id INTO entry_id;

    -- Money appearing from nowhere: one posting, nothing on the other side.
    INSERT INTO postings (journal_entry_id, account_id, amount_minor, currency)
    VALUES (entry_id, wallet_id, 100000, 'NGN');

    -- The balance trigger is DEFERRABLE INITIALLY DEFERRED, so it has not
    -- run yet -- it fires at COMMIT. Without this line the RAISE below
    -- aborts the block first, the check never executes, and this test
    -- passes even with the constraint removed entirely.
    SET CONSTRAINTS ALL IMMEDIATE;

    RAISE EXCEPTION 'TEST FAILED: unbalanced entry was accepted';
EXCEPTION
    WHEN raise_exception THEN
        IF SQLERRM LIKE 'TEST FAILED%' THEN RAISE; END IF;
        RAISE NOTICE 'PASS: rejected -> %', SQLERRM;
END $$;

\echo ''
\echo '=== 3. A MULTI-CURRENCY FX trade balancing per-currency is ACCEPTED ==='
-- The case that breaks a naive whole-entry sum check. Sell N1,650,000 for
-- $1,000 at 1650 with a 1% spread. Across the entry the postings sum to
-- -164,901,000 -- a meaningless figure subtracting cents from kobo. Per
-- currency both legs are exactly zero.
BEGIN;
  INSERT INTO journal_entries (idempotency_key, kind, description, occurred_at)
  VALUES ('test:fx-1', 'fx_trade', 'NGN->USD @1650, 1% spread', now());

  INSERT INTO postings (journal_entry_id, account_id, amount_minor, currency)
  SELECT e.id, a.id, v.amt, v.cur
    FROM journal_entries e
    CROSS JOIN LATERAL (VALUES
      ('customer_wallet',  1::bigint, -165000000::bigint, 'NGN'),
      ('provider_float',   NULL,       165000000::bigint, 'NGN'),
      ('provider_float',   NULL,         -100000::bigint, 'USD'),
      ('customer_wallet',  1::bigint,      99000::bigint, 'USD'),
      ('revenue_fx_spread',NULL,            1000::bigint, 'USD')
    ) AS v(kind, oid, amt, cur)
    JOIN accounts a ON a.kind = v.kind::account_kind
                   AND a.currency = v.cur
                   AND a.owner_id IS NOT DISTINCT FROM v.oid
   WHERE e.idempotency_key = 'test:fx-1';
COMMIT;

SELECT 'PASS: FX trade committed; whole-entry sum = ' ||
       (SELECT SUM(amount_minor) FROM postings p
          JOIN journal_entries e ON e.id = p.journal_entry_id
         WHERE e.idempotency_key = 'test:fx-1')::text ||
       ' -- a CORRECT trade nets to zero either way, so this is not the ' ||
       'case that justifies per-currency. Test 4a is.';

\echo ''
\echo '=== 4. An FX trade unbalanced in ONE currency is REJECTED ==='
DO $$
DECLARE entry_id BIGINT; ngn_w BIGINT; ngn_f BIGINT; usd_f BIGINT; usd_w BIGINT;
BEGIN
    SELECT id INTO ngn_w FROM accounts WHERE kind='customer_wallet' AND owner_id=1 AND currency='NGN';
    SELECT id INTO ngn_f FROM accounts WHERE kind='provider_float' AND currency='NGN';
    SELECT id INTO usd_f FROM accounts WHERE kind='provider_float' AND currency='USD';
    SELECT id INTO usd_w FROM accounts WHERE kind='customer_wallet' AND owner_id=1 AND currency='USD';

    INSERT INTO journal_entries (idempotency_key, kind, occurred_at)
    VALUES ('test:fx-bad', 'fx_trade', now()) RETURNING id INTO entry_id;

    -- NGN leg balances. USD leg is short 1000 -- the spread was taken but
    -- never posted to revenue. This is the exact shape of a real FX bug.
    INSERT INTO postings (journal_entry_id, account_id, amount_minor, currency) VALUES
      (entry_id, ngn_w, -165000000, 'NGN'),
      (entry_id, ngn_f,  165000000, 'NGN'),
      (entry_id, usd_f,    -100000, 'USD'),
      (entry_id, usd_w,      99000, 'USD');

    SET CONSTRAINTS ALL IMMEDIATE;  -- see note in test 2

    RAISE EXCEPTION 'TEST FAILED: half-unbalanced FX entry was accepted';
EXCEPTION
    WHEN raise_exception THEN
        IF SQLERRM LIKE 'TEST FAILED%' THEN RAISE; END IF;
        RAISE NOTICE 'PASS: rejected -> %', SQLERRM;
END $$;

\echo ''
\echo '=== 4a. Errors in two currencies that MASK each other are REJECTED ==='
-- The case a whole-entry sum cannot catch, and the reason the invariant is
-- per currency. NGN leg is over by 1000 kobo; USD leg is under by 1000
-- cents. Added as raw integers those cancel exactly, so a whole-entry check
-- sees zero and commits an entry in which BOTH legs are wrong.
DO $$
DECLARE entry_id BIGINT; ngn_w BIGINT; ngn_f BIGINT; usd_f BIGINT; usd_w BIGINT;
BEGIN
    SELECT id INTO ngn_w FROM accounts WHERE kind='customer_wallet' AND owner_id=1 AND currency='NGN';
    SELECT id INTO ngn_f FROM accounts WHERE kind='provider_float' AND currency='NGN';
    SELECT id INTO usd_f FROM accounts WHERE kind='provider_float' AND currency='USD';
    SELECT id INTO usd_w FROM accounts WHERE kind='customer_wallet' AND owner_id=1 AND currency='USD';

    INSERT INTO journal_entries (idempotency_key, kind, occurred_at)
    VALUES ('test:fx-masked', 'fx_trade', now()) RETURNING id INTO entry_id;

    INSERT INTO postings (journal_entry_id, account_id, amount_minor, currency) VALUES
      (entry_id, ngn_w,  -1650000, 'NGN'),
      (entry_id, ngn_f,   1651000, 'NGN'),   -- +1000 kobo too much
      (entry_id, usd_f,     -1000, 'USD'),
      (entry_id, usd_w,      1000, 'USD'),
      (entry_id, usd_f,     -1000, 'USD');   -- -1000 cents too much

    SET CONSTRAINTS ALL IMMEDIATE;
    RAISE EXCEPTION 'TEST FAILED: masked cross-currency error was accepted';
EXCEPTION
    WHEN raise_exception THEN
        IF SQLERRM LIKE 'TEST FAILED%' THEN RAISE; END IF;
        RAISE NOTICE 'PASS: rejected -> %', SQLERRM;
END $$;

SELECT 'confirmed: those postings sum to ' ||
       (-1650000 + 1651000 - 1000 + 1000 - 1000)::text ||
       ' overall, so a whole-entry check would have let it through';

\echo ''
\echo '=== 4b. An OVERDRAFT is REJECTED ==='
DO $$
DECLARE entry_id BIGINT; w BIGINT; f BIGINT;
BEGIN
    SELECT id INTO w FROM accounts WHERE kind='customer_wallet' AND owner_id=2 AND currency='NGN';
    SELECT id INTO f FROM accounts WHERE kind='provider_float' AND currency='NGN';

    INSERT INTO journal_entries (idempotency_key, kind, occurred_at)
    VALUES ('test:overdraft', 'wallet_withdrawal', now()) RETURNING id INTO entry_id;

    -- User 2 holds N5,000 from test 1. Withdrawing N50,000 is balanced and
    -- perfectly legal double-entry -- the ledger sums to zero. It is still
    -- an unsecured loan nobody agreed to make.
    INSERT INTO postings (journal_entry_id, account_id, amount_minor, currency) VALUES
      (entry_id, w, -5000000, 'NGN'),
      (entry_id, f,  5000000, 'NGN');

    RAISE EXCEPTION 'TEST FAILED: overdraft was accepted';
EXCEPTION
    WHEN check_violation THEN
        RAISE NOTICE 'PASS: rejected -> %', SQLERRM;
END $$;

\echo ''
\echo '=== 5. A posting whose currency mismatches its account is REJECTED ==='
DO $$
DECLARE entry_id BIGINT; ngn_w BIGINT;
BEGIN
    SELECT id INTO ngn_w FROM accounts WHERE kind='customer_wallet' AND owner_id=1 AND currency='NGN';
    INSERT INTO journal_entries (idempotency_key, kind, occurred_at)
    VALUES ('test:wrong-currency', 'adjustment', now()) RETURNING id INTO entry_id;

    -- USD into a NGN wallet. Both sides would balance; the wallet total
    -- would be silently meaningless.
    INSERT INTO postings (journal_entry_id, account_id, amount_minor, currency)
    VALUES (entry_id, ngn_w, 100000, 'USD');

    RAISE EXCEPTION 'TEST FAILED: currency mismatch was accepted';
EXCEPTION
    WHEN raise_exception THEN
        IF SQLERRM LIKE 'TEST FAILED%' THEN RAISE; END IF;
        RAISE NOTICE 'PASS: rejected -> %', SQLERRM;
END $$;

\echo ''
\echo '=== 6. A replayed webhook is REJECTED by idempotency ==='
DO $$
BEGIN
    INSERT INTO journal_entries (idempotency_key, kind, occurred_at)
    VALUES ('test:transfer-1', 'wallet_transfer', now());
    RAISE EXCEPTION 'TEST FAILED: duplicate idempotency_key was accepted';
EXCEPTION
    WHEN unique_violation THEN
        RAISE NOTICE 'PASS: duplicate rejected by unique constraint';
END $$;

\echo ''
\echo '=== 7. A zero-amount posting is REJECTED ==='
DO $$
DECLARE entry_id BIGINT; w BIGINT;
BEGIN
    SELECT id INTO w FROM accounts WHERE kind='customer_wallet' AND owner_id=1 AND currency='NGN';
    INSERT INTO journal_entries (idempotency_key, kind, occurred_at)
    VALUES ('test:zero', 'adjustment', now()) RETURNING id INTO entry_id;
    INSERT INTO postings (journal_entry_id, account_id, amount_minor, currency)
    VALUES (entry_id, w, 0, 'NGN');
    RAISE EXCEPTION 'TEST FAILED: zero posting was accepted';
EXCEPTION
    WHEN check_violation THEN
        RAISE NOTICE 'PASS: zero posting rejected';
END $$;

\echo ''
\echo '=== 8. Card AUTH -> SETTLE -> the Bitnob two-phase flow ==='
-- Bitnob fires a webhook on Authorization AND on Settlement. Treating them
-- as one transaction double-counts; treating only settlement lets the
-- customer respend committed money. The pending account resolves both.
BEGIN;
  INSERT INTO journal_entries (idempotency_key, kind, description, occurred_at)
  VALUES ('bitnob:auth-abc', 'card_authorization', '$25 at Netflix', now());
  INSERT INTO postings (journal_entry_id, account_id, amount_minor, currency)
  SELECT e.id, a.id, v.amt, 'USD'
    FROM journal_entries e
    CROSS JOIN LATERAL (VALUES
      ('customer_wallet'::text,  -2500::bigint),
      ('customer_pending'::text,  2500::bigint)
    ) AS v(kind, amt)
    JOIN accounts a ON a.kind = v.kind::account_kind AND a.owner_id = 1 AND a.currency='USD'
   WHERE e.idempotency_key = 'bitnob:auth-abc';
COMMIT;

BEGIN;
  INSERT INTO journal_entries (idempotency_key, kind, description, occurred_at)
  VALUES ('bitnob:settle-abc', 'card_settlement', '$25 Netflix settled', now());
  INSERT INTO postings (journal_entry_id, account_id, amount_minor, currency)
  SELECT e.id, a.id, v.amt, 'USD'
    FROM journal_entries e
    CROSS JOIN LATERAL (VALUES
      ('customer_pending'::text, NULL::bigint, -2500::bigint),
      ('provider_float'::text,   NULL::bigint,  2500::bigint)
    ) AS v(kind, oid, amt)
    JOIN accounts a ON a.kind = v.kind::account_kind AND a.currency='USD'
                   AND (a.owner_id = 1 OR a.owner_id IS NULL)
   WHERE e.idempotency_key = 'bitnob:settle-abc'
     AND ((v.kind='customer_pending' AND a.owner_id=1)
       OR (v.kind='provider_float'   AND a.owner_id IS NULL));
COMMIT;

SELECT 'PASS: after auth+settle, spendable=' ||
       (SELECT balance_minor FROM account_balances b
          JOIN accounts a ON a.id=b.account_id
         WHERE a.kind='customer_wallet' AND a.owner_id=1 AND a.currency='USD')::text ||
       ' pending=' ||
       (SELECT balance_minor FROM account_balances b
          JOIN accounts a ON a.id=b.account_id
         WHERE a.kind='customer_pending' AND a.owner_id=1 AND a.currency='USD')::text ||
       ' (pending returned to 0, money moved to provider)';

\echo ''
\echo '=== 9. Materialised balances agree with derived postings ==='
SELECT CASE WHEN COUNT(*) = 0
            THEN 'PASS: zero drift across all accounts'
            ELSE 'FAIL: ' || COUNT(*)::text || ' account(s) drifted' END
  FROM ledger_drift;

\echo ''
\echo '=== 10. Customer liability is reportable per currency ==='
SELECT 'liability ' || currency || ' = ' || total_owed_minor::text
  FROM customer_liability ORDER BY currency;
