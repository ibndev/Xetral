-- ===========================================================================
--  Xetral — Phase 10 FX invariant tests
--  packages/ledger/sql/008_fx.test.sql
--
--  The interesting blocks here are the ones about the PER-CURRENCY balance
--  rule. An FX entry is the first flow that spans two currencies in one entry,
--  and it is exactly the case Phase 1's finding 1 was written about: a
--  whole-entry check would add kobo to cents and let two independent errors
--  cancel each other out.
-- ===========================================================================

\set QUIET on
\pset format unaligned
\pset tuples_only on

-- Idempotency keys here are prefixed `p10:` rather than `test:`.
-- 001_ledger.test.sql has used `test:fx-1` for its own FX balance test since
-- Phase 1, and these files share one invariant database in CI order -- so the
-- unprefixed name collided and this whole file aborted on its first block.
-- The same shared-database lesson as the ledger suites' synthetic owner ids.

CREATE OR REPLACE FUNCTION fx_account(
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

INSERT INTO users (email, status) VALUES
  ('fx-a@example.ng', 'active'),
  ('fx-b@example.ng', 'active');

INSERT INTO fx_spread_policies (base_currency, quote_currency, spread_basis_points)
VALUES ('NGN', 'USD', 150);

-- Give the customer naira to sell.
DO $$
DECLARE v_user BIGINT; v_entry BIGINT;
BEGIN
    SELECT id INTO v_user FROM users WHERE email = 'fx-a@example.ng';
    INSERT INTO journal_entries (idempotency_key, kind, description, occurred_at)
    VALUES ('p10:fx-seed', 'wallet_funding', 'seed', now()) RETURNING id INTO v_entry;
    INSERT INTO postings (journal_entry_id, account_id, amount_minor, currency)
    VALUES (v_entry, fx_account('customer_wallet', v_user, 'NGN', 'credit'), 200000000, 'NGN'),
           (v_entry, fx_account('provider_float', NULL, 'NGN', 'debit'), -200000000, 'NGN');
END $$;

\echo '=== 1. A correct FX entry balances PER CURRENCY and commits ==='
-- ₦1,650,250 sold; we keep 1.5% as spread; the customer receives $1,000.00.
DO $$
DECLARE v_user BIGINT; v_entry BIGINT; v_policy BIGINT;
BEGIN
    SELECT id INTO v_user FROM users WHERE email = 'fx-a@example.ng';
    SELECT id INTO v_policy FROM fx_spread_policies LIMIT 1;

    INSERT INTO journal_entries (idempotency_key, kind, description, occurred_at)
    VALUES ('p10:fx-1', 'fx_trade', 'NGN -> USD', now()) RETURNING id INTO v_entry;

    INSERT INTO postings (journal_entry_id, account_id, amount_minor, currency)
    VALUES
      -- NGN side: what the customer paid, split between the provider and us.
      (v_entry, fx_account('customer_wallet', v_user, 'NGN', 'credit'), -165025000, 'NGN'),
      (v_entry, fx_account('provider_float', NULL, 'NGN', 'debit'),      162549625, 'NGN'),
      (v_entry, fx_account('revenue_fx_spread', NULL, 'NGN', 'credit'),    2475375, 'NGN'),
      -- USD side: what they received.
      (v_entry, fx_account('provider_float', NULL, 'USD', 'debit'),       -100000, 'USD'),
      (v_entry, fx_account('customer_wallet', v_user, 'USD', 'credit'),    100000, 'USD');

    INSERT INTO fx_trades
      (user_id, reference, idempotency_key, base_currency, base_minor,
       quote_currency, quote_minor, rate_numerator, rate_denominator,
       spread_minor, spread_policy_id, entry_id)
    VALUES (v_user, 'fx-ref-1', 'fx-key-1', 'NGN', 165025000, 'USD', 100000,
            100000, 165025000, 2475375, v_policy, v_entry);

    RAISE NOTICE 'PASS: a two-currency entry balances per currency and commits';
END $$;

\echo ''
\echo '=== 2. TWO ERRORS IN DIFFERENT CURRENCIES DO NOT CANCEL ==='
-- The whole reason the invariant is per currency. This entry is off by
-- +1,000 kobo and -1,000 cents: a whole-entry sum is ZERO and it would commit,
-- crediting a customer with ten dollars that came from nowhere.
DO $$
DECLARE v_user BIGINT; v_entry BIGINT; v_seed BIGINT;
BEGIN
    -- A DIFFERENT customer, funded here. Block 1 spent most of fx-a's naira,
    -- and running this against them made the block fail on the OVERDRAFT
    -- guard instead — passing while never reaching the check it names. Caught
    -- only because the handler asserts which error it caught.
    SELECT id INTO v_user FROM users WHERE email = 'fx-b@example.ng';

    INSERT INTO journal_entries (idempotency_key, kind, description, occurred_at)
    VALUES ('p10:fx-cancel-seed', 'wallet_funding', 'seed', now()) RETURNING id INTO v_seed;
    INSERT INTO postings (journal_entry_id, account_id, amount_minor, currency)
    VALUES (v_seed, fx_account('customer_wallet', v_user, 'NGN', 'credit'), 200000000, 'NGN'),
           (v_seed, fx_account('provider_float', NULL, 'NGN', 'debit'), -200000000, 'NGN');

    INSERT INTO journal_entries (idempotency_key, kind, description, occurred_at)
    VALUES ('p10:fx-cancel', 'fx_trade', 'two wrongs', now()) RETURNING id INTO v_entry;

    INSERT INTO postings (journal_entry_id, account_id, amount_minor, currency)
    VALUES
      (v_entry, fx_account('customer_wallet', v_user, 'NGN', 'credit'), -165025000, 'NGN'),
      (v_entry, fx_account('provider_float', NULL, 'NGN', 'debit'),      165026000, 'NGN'),
      (v_entry, fx_account('provider_float', NULL, 'USD', 'debit'),        -101000, 'USD'),
      (v_entry, fx_account('customer_wallet', v_user, 'USD', 'credit'),     100000, 'USD');

    -- Deferred to COMMIT, so it must be forced to fire here. A test that
    -- simply aborted would pass even with the constraint deleted.
    SET CONSTRAINTS ALL IMMEDIATE;
    RAISE EXCEPTION 'TEST FAILED: kobo and cents cancelled each other out';
EXCEPTION
    WHEN OTHERS THEN
        -- Assert on WHICH failure. A bare `WHEN OTHERS` would pass on any
        -- error at all -- a typo in an account name, a missing column -- and
        -- report that the invariant held when it had never been reached.
        IF SQLERRM LIKE '%TEST FAILED%' THEN RAISE; END IF;
        IF SQLERRM NOT LIKE '%unbalanced journal entry%' THEN
            RAISE EXCEPTION 'TEST FAILED: expected an unbalanced-entry error, got: %', SQLERRM;
        END IF;
        RAISE NOTICE 'PASS: per-currency balance caught two errors a whole-entry sum would miss (%)',
            SQLERRM;
END $$;

\echo ''
\echo '=== 3. A trade cannot convert a currency into itself ==='
DO $$
DECLARE v_user BIGINT; v_policy BIGINT; v_entry BIGINT;
BEGIN
    SELECT id INTO v_user FROM users WHERE email = 'fx-a@example.ng';
    SELECT id INTO v_policy FROM fx_spread_policies LIMIT 1;
    SELECT id INTO v_entry FROM journal_entries WHERE idempotency_key = 'p10:fx-1';

    INSERT INTO fx_trades
      (user_id, reference, idempotency_key, base_currency, base_minor,
       quote_currency, quote_minor, rate_numerator, rate_denominator,
       spread_minor, spread_policy_id, entry_id)
    VALUES (v_user, 'fx-ref-same', 'fx-key-same', 'NGN', 1000, 'NGN', 1000,
            1, 1, 0, v_policy, v_entry);
    RAISE EXCEPTION 'TEST FAILED: a trade converted NGN to NGN';
EXCEPTION
    WHEN check_violation THEN
        RAISE NOTICE 'PASS: converting a currency into itself is not a trade';
END $$;

\echo ''
\echo '=== 4. A remittance goes to somebody ELSE ==='
-- Sending to yourself is a conversion. Modelling it as a remittance would make
-- the two indistinguishable in reporting.
DO $$
DECLARE v_user BIGINT; v_policy BIGINT; v_entry BIGINT;
BEGIN
    SELECT id INTO v_user FROM users WHERE email = 'fx-a@example.ng';
    SELECT id INTO v_policy FROM fx_spread_policies LIMIT 1;
    SELECT id INTO v_entry FROM journal_entries WHERE idempotency_key = 'p10:fx-1';

    INSERT INTO fx_trades
      (user_id, reference, idempotency_key, base_currency, base_minor,
       quote_currency, quote_minor, rate_numerator, rate_denominator,
       spread_minor, spread_policy_id, entry_id, recipient_user_id)
    VALUES (v_user, 'fx-ref-self', 'fx-key-self', 'NGN', 1000, 'USD', 1,
            1, 1000, 0, v_policy, v_entry, v_user);
    RAISE EXCEPTION 'TEST FAILED: a customer remitted to themselves';
EXCEPTION
    WHEN check_violation THEN
        RAISE NOTICE 'PASS: a remittance has a different recipient';
END $$;

\echo ''
\echo '=== 5. A trade is IMMUTABLE ==='
-- It records an entry that has already been written. Changing it would make
-- the two disagree, and the ledger is the one that is right.
DO $$
DECLARE v_id BIGINT;
BEGIN
    SELECT id INTO v_id FROM fx_trades WHERE reference = 'fx-ref-1';
    UPDATE fx_trades SET quote_minor = 999999 WHERE id = v_id;
    RAISE EXCEPTION 'TEST FAILED: a completed trade was rewritten';
EXCEPTION
    WHEN check_violation THEN
        RAISE NOTICE 'PASS: a trade records what was posted and never changes';
END $$;

\echo ''
\echo '=== 6. A customer key is unique PER CUSTOMER ==='
DO $$
DECLARE v_user BIGINT; v_other BIGINT; v_policy BIGINT; v_entry BIGINT;
BEGIN
    SELECT id INTO v_user  FROM users WHERE email = 'fx-a@example.ng';
    SELECT id INTO v_other FROM users WHERE email = 'fx-b@example.ng';
    SELECT id INTO v_policy FROM fx_spread_policies LIMIT 1;
    SELECT id INTO v_entry FROM journal_entries WHERE idempotency_key = 'p10:fx-1';

    -- The same key under a DIFFERENT customer must be accepted.
    INSERT INTO fx_trades
      (user_id, reference, idempotency_key, base_currency, base_minor,
       quote_currency, quote_minor, rate_numerator, rate_denominator,
       spread_minor, spread_policy_id, entry_id)
    VALUES (v_other, 'fx-ref-2', 'fx-key-1', 'NGN', 1000, 'USD', 1,
            1, 1000, 0, v_policy, v_entry);

    BEGIN
        INSERT INTO fx_trades
          (user_id, reference, idempotency_key, base_currency, base_minor,
           quote_currency, quote_minor, rate_numerator, rate_denominator,
           spread_minor, spread_policy_id, entry_id)
        VALUES (v_user, 'fx-ref-3', 'fx-key-1', 'NGN', 1000, 'USD', 1,
                1, 1000, 0, v_policy, v_entry);
        RAISE EXCEPTION 'TEST FAILED: a customer reused their own key';
    EXCEPTION
        WHEN unique_violation THEN
            RAISE NOTICE 'PASS: one customer key, one trade, nobody else blocked';
    END;
END $$;

\echo ''
\echo '=== 7. A published spread is never edited ==='
DO $$
DECLARE v_id BIGINT;
BEGIN
    SELECT id INTO v_id FROM fx_spread_policies LIMIT 1;
    UPDATE fx_spread_policies SET spread_basis_points = 900 WHERE id = v_id;
    RAISE EXCEPTION 'TEST FAILED: a published spread was edited';
EXCEPTION
    WHEN check_violation THEN
        RAISE NOTICE 'PASS: spreads are retired and republished, never rewritten';
END $$;

\echo ''
\echo '=== 8. One live policy per pair ==='
DO $$
BEGIN
    INSERT INTO fx_spread_policies (base_currency, quote_currency, spread_basis_points)
    VALUES ('NGN', 'USD', 200);
    RAISE EXCEPTION 'TEST FAILED: two live spreads for one pair';
EXCEPTION
    WHEN unique_violation THEN
        RAISE NOTICE 'PASS: one live spread per pair — a quote is never ambiguous';
END $$;

\echo ''
\echo '=== 8a. But the REVERSE pair is a different policy ==='
-- NGN->USD and USD->NGN are priced separately, as any dealer prices them.
DO $$
BEGIN
    INSERT INTO fx_spread_policies (base_currency, quote_currency, spread_basis_points)
    VALUES ('USD', 'NGN', 175);
    RAISE NOTICE 'PASS: each direction of a pair carries its own spread';
END $$;

\echo ''
\echo '=== 9. A spread cannot exceed 100%% ==='
DO $$
BEGIN
    INSERT INTO fx_spread_policies (base_currency, quote_currency, spread_basis_points)
    VALUES ('GBP', 'NGN', 10001);
    RAISE EXCEPTION 'TEST FAILED: a spread over 100%% was accepted';
EXCEPTION
    WHEN check_violation THEN
        RAISE NOTICE 'PASS: basis points stay within a sane range';
END $$;

\echo ''
\echo '=== 10. The customer really received the dollars ==='
-- Everything above asserts a refusal. A schema that rejected everything would
-- pass all of them.
DO $$
DECLARE v_user BIGINT; v_ngn BIGINT; v_usd BIGINT; v_ngn_bal BIGINT; v_usd_bal BIGINT;
BEGIN
    SELECT id INTO v_user FROM users WHERE email = 'fx-a@example.ng';
    v_ngn := fx_account('customer_wallet', v_user, 'NGN', 'credit');
    v_usd := fx_account('customer_wallet', v_user, 'USD', 'credit');

    SELECT balance_minor INTO v_ngn_bal FROM account_balances WHERE account_id = v_ngn;
    SELECT balance_minor INTO v_usd_bal FROM account_balances WHERE account_id = v_usd;

    -- Seeded 200,000,000 kobo, sold 165,025,000.
    IF v_ngn_bal <> 34975000 THEN
        RAISE EXCEPTION 'TEST FAILED: NGN balance is % rather than 34975000', v_ngn_bal;
    END IF;
    IF v_usd_bal <> 100000 THEN
        RAISE EXCEPTION 'TEST FAILED: USD balance is % rather than 100000', v_usd_bal;
    END IF;

    RAISE NOTICE 'PASS: ₦1,650,250.00 became $1,000.00 and both balances agree';
END $$;

\echo ''
\echo '=== 11. Our spread landed in revenue, in the base currency ==='
DO $$
DECLARE v_spread BIGINT; v_balance BIGINT;
BEGIN
    v_spread := fx_account('revenue_fx_spread', NULL, 'NGN', 'credit');
    SELECT balance_minor INTO v_balance FROM account_balances WHERE account_id = v_spread;

    IF v_balance <> 2475375 THEN
        RAISE EXCEPTION 'TEST FAILED: spread revenue is % rather than 2475375', v_balance;
    END IF;
    RAISE NOTICE 'PASS: the margin is booked as revenue and is visible as such';
END $$;
