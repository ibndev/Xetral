-- ===========================================================================
--  Xetral — tax invariants
--  packages/ledger/sql/032_tax.test.sql
-- ===========================================================================

\set QUIET on
\pset format unaligned
\pset tuples_only on

INSERT INTO users (email, status) VALUES ('p32-payer@example.ng', 'active');

-- A real transfer, posted the way `WalletService` posts one: the fee split
-- between what we keep and what we owe. Written as postings rather than
-- through a helper, because every view here reads the ledger and a fixture
-- that skipped it would be testing a view that can never return a row.
DO $$
DECLARE
    v_u BIGINT; v_wallet BIGINT; v_fees BIGINT; v_tax BIGINT; v_float BIGINT;
    v_entry BIGINT;
BEGIN
    SELECT id INTO v_u FROM users WHERE email = 'p32-payer@example.ng';

    INSERT INTO accounts (kind, owner_type, owner_id, currency, normal_balance)
    VALUES ('customer_wallet', 'user', v_u, 'NGN', 'credit') RETURNING id INTO v_wallet;

    -- Platform accounts are one row per currency for the whole database, so
    -- they are resolved-or-created. Inserting unconditionally aborts the file
    -- the moment an earlier suite has already made one — the collision Phase 5
    -- recorded.
    SELECT id INTO v_fees FROM accounts
     WHERE kind = 'revenue_fees' AND currency = 'NGN' AND owner_id IS NULL;
    IF v_fees IS NULL THEN
        INSERT INTO accounts (kind, owner_type, owner_id, currency, normal_balance)
        VALUES ('revenue_fees', 'platform', NULL, 'NGN', 'credit') RETURNING id INTO v_fees;
    END IF;

    SELECT id INTO v_tax FROM accounts
     WHERE kind = 'liability_tax_payable' AND currency = 'NGN' AND owner_id IS NULL;
    IF v_tax IS NULL THEN
        INSERT INTO accounts (kind, owner_type, owner_id, currency, normal_balance)
        VALUES ('liability_tax_payable', 'platform', NULL, 'NGN', 'credit')
        RETURNING id INTO v_tax;
    END IF;

    -- Fund the wallet, or the overdraft guard refuses the transfer below. The
    -- guard is doing its job: a fixture that posted a debit against an empty
    -- account would be testing a state production cannot reach.
    SELECT id INTO v_float FROM accounts
     WHERE kind = 'provider_float' AND currency = 'NGN' AND owner_id IS NULL;
    IF v_float IS NULL THEN
        INSERT INTO accounts (kind, owner_type, owner_id, currency, normal_balance)
        VALUES ('provider_float', 'platform', NULL, 'NGN', 'debit') RETURNING id INTO v_float;
    END IF;

    INSERT INTO journal_entries (idempotency_key, kind, occurred_at, description)
    VALUES ('p32:fund', 'wallet_funding', now(), 'seed') RETURNING id INTO v_entry;
    INSERT INTO postings (journal_entry_id, account_id, amount_minor, currency)
    VALUES (v_entry, v_wallet, 100000, 'NGN'), (v_entry, v_float, -100000, 'NGN');

    -- ₦100.00 of fee, split 7.5% VAT-inclusive: ₦93.03 ours, ₦6.97 the
    -- FIRS's. 10000 * 750 / 10750 = 697.67, rounded UP to 698.
    INSERT INTO journal_entries (idempotency_key, kind, occurred_at, description)
    VALUES ('p32:transfer', 'wallet_transfer', now(), 'a transfer with a taxed fee')
    RETURNING id INTO v_entry;

    INSERT INTO postings (journal_entry_id, account_id, amount_minor, currency)
    VALUES (v_entry, v_wallet, -10000, 'NGN'),
           (v_entry, v_fees,     9302, 'NGN'),
           (v_entry, v_tax,       698, 'NGN');

    INSERT INTO tax_collections
      (kind, entry_id, user_id, amount_minor, currency, base_minor, rate_applied,
       occurred_at)
    VALUES ('vat', v_entry, v_u, 698, 'NGN', 9302, '750bp', now());
END $$;

\echo '=== 1. Tax is a LIABILITY, not revenue ==='
-- The whole point of the file. Money collected for the FIRS is money owed to
-- the FIRS, and an account holding it must be a liability — a credit balance
-- that grows as we charge and falls as we remit. Booking it as revenue
-- overstates what the business earned and understates what it owes, and both
-- errors point the same way.
DO $$
DECLARE v_normal TEXT;
BEGIN
    SELECT normal_balance INTO v_normal FROM accounts
     WHERE kind = 'liability_tax_payable' AND currency = 'NGN' AND owner_id IS NULL;
    IF v_normal <> 'credit' THEN
        RAISE EXCEPTION 'TEST FAILED: tax payable has a % balance, not credit', v_normal;
    END IF;
    RAISE NOTICE 'PASS: collected tax is money we owe';
END $$;

\echo '=== 2. The split leaves the customer paying the SAME ==='
-- VAT-inclusive means the fee is what it always was and only the books change.
-- If the two legs did not sum to the fee, turning VAT on would have been a
-- silent price rise — which is a pricing decision wearing a tax setting's
-- clothes.
DO $$
DECLARE v_fee BIGINT; v_kept BIGINT; v_owed BIGINT;
BEGIN
    SELECT -sum(p.amount_minor) INTO v_fee
      FROM postings p JOIN accounts a ON a.id = p.account_id
      JOIN journal_entries e ON e.id = p.journal_entry_id
     WHERE e.idempotency_key = 'p32:transfer' AND a.kind = 'customer_wallet';

    SELECT sum(p.amount_minor) INTO v_kept
      FROM postings p JOIN accounts a ON a.id = p.account_id
      JOIN journal_entries e ON e.id = p.journal_entry_id
     WHERE e.idempotency_key = 'p32:transfer' AND a.kind = 'revenue_fees';

    SELECT sum(p.amount_minor) INTO v_owed
      FROM postings p JOIN accounts a ON a.id = p.account_id
      JOIN journal_entries e ON e.id = p.journal_entry_id
     WHERE e.idempotency_key = 'p32:transfer' AND a.kind = 'liability_tax_payable';

    IF v_kept + v_owed <> v_fee THEN
        RAISE EXCEPTION 'TEST FAILED: % kept + % owed <> % charged',
            v_kept, v_owed, v_fee;
    END IF;
    IF v_owed <> 698 THEN
        RAISE EXCEPTION 'TEST FAILED: VAT on a 100.00 inclusive fee was %, not 698',
            v_owed;
    END IF;
    RAISE NOTICE 'PASS: the customer pays the same and the books split it';
END $$;

\echo '=== 3. VAT ROUNDS UP, so we can never under-remit ==='
-- The rounding direction is a decision, not a detail. A sub-kobo fraction
-- rounded toward us is a fraction of somebody else's money kept, repeated on
-- every transfer; rounded toward the revenue authority it is a fraction of our
-- own given away. Only one of those is a finding.
DO $$
DECLARE v_exact NUMERIC; v_recorded BIGINT;
BEGIN
    v_exact := 10000::NUMERIC * 750 / 10750;   -- 697.674...
    SELECT amount_minor INTO v_recorded FROM tax_collections
     WHERE entry_id = (SELECT id FROM journal_entries
                        WHERE idempotency_key = 'p32:transfer');
    IF v_recorded < v_exact THEN
        RAISE EXCEPTION 'TEST FAILED: recorded % is below the exact % — we under-remit',
            v_recorded, v_exact;
    END IF;
    IF v_recorded <> ceil(v_exact) THEN
        RAISE EXCEPTION 'TEST FAILED: recorded % is not the exact figure rounded up',
            v_recorded;
    END IF;
    RAISE NOTICE 'PASS: the fraction goes to the revenue authority';
END $$;

\echo '=== 4. One collection of each kind PER ENTRY ==='
-- A retried transfer is a replay at the ledger and must be one here. Without
-- this a redelivery would double what a return says was collected while the
-- postings — correctly — did not move.
DO $$
DECLARE v_entry BIGINT; v_u BIGINT;
BEGIN
    SELECT id INTO v_entry FROM journal_entries WHERE idempotency_key = 'p32:transfer';
    SELECT id INTO v_u FROM users WHERE email = 'p32-payer@example.ng';

    INSERT INTO tax_collections
      (kind, entry_id, user_id, amount_minor, currency, base_minor, rate_applied,
       occurred_at)
    VALUES ('vat', v_entry, v_u, 698, 'NGN', 9302, '750bp', now());
    RAISE EXCEPTION 'TEST FAILED: one entry recorded VAT twice';
EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'PASS: a replayed transfer is one collection';
END $$;

\echo '=== 5. Two KINDS on one entry are allowed ==='
-- VAT and a transfer levy are filed on different returns and both can arise
-- from one transfer, so the uniqueness is per (entry, kind) rather than per
-- entry. Getting that wrong would make the levy unrecordable on any transfer
-- that also carried a fee — which is all of them.
DO $$
DECLARE v_entry BIGINT; v_u BIGINT; v_n INT;
BEGIN
    SELECT id INTO v_entry FROM journal_entries WHERE idempotency_key = 'p32:transfer';
    SELECT id INTO v_u FROM users WHERE email = 'p32-payer@example.ng';

    INSERT INTO tax_collections
      (kind, entry_id, user_id, amount_minor, currency, base_minor, rate_applied,
       occurred_at)
    VALUES ('transfer_levy', v_entry, v_u, 5000, 'NGN', 1000000, 'flat', now());

    SELECT count(*) INTO v_n FROM tax_collections WHERE entry_id = v_entry;
    IF v_n <> 2 THEN
        RAISE EXCEPTION 'TEST FAILED: expected two collections on one entry, found %', v_n;
    END IF;
    RAISE NOTICE 'PASS: VAT and a levy coexist on one transfer';
END $$;

\echo '=== 6. A collection cannot be REWRITTEN ==='
-- A tax record that can be edited after a return is filed is a record that
-- says whatever makes the last return look right.
DO $$
BEGIN
    UPDATE tax_collections SET amount_minor = 1
     WHERE entry_id = (SELECT id FROM journal_entries
                        WHERE idempotency_key = 'p32:transfer');
    RAISE EXCEPTION 'TEST FAILED: a recorded collection was rewritten';
EXCEPTION WHEN restrict_violation THEN
    RAISE NOTICE 'PASS: what was collected is immutable';
END $$;

\echo '=== 7. A collection cannot be DELETED ==='
DO $$
BEGIN
    DELETE FROM tax_collections
     WHERE entry_id = (SELECT id FROM journal_entries
                        WHERE idempotency_key = 'p32:transfer');
    RAISE EXCEPTION 'TEST FAILED: a recorded collection was deleted';
EXCEPTION WHEN restrict_violation THEN
    RAISE NOTICE 'PASS: a collection cannot be made to disappear';
END $$;

\echo '=== 8. A collection must name an entry that EXISTS ==='
-- The posting is the money; this is the description of it. A description with
-- nothing behind it is a figure on a return that no transaction supports.
DO $$
DECLARE v_u BIGINT;
BEGIN
    SELECT id INTO v_u FROM users WHERE email = 'p32-payer@example.ng';
    INSERT INTO tax_collections
      (kind, entry_id, user_id, amount_minor, currency, base_minor, rate_applied,
       occurred_at)
    VALUES ('vat', 9223372036854775807, v_u, 1, 'NGN', 1, '750bp', now());
    RAISE EXCEPTION 'TEST FAILED: tax was recorded against no entry';
EXCEPTION WHEN foreign_key_violation THEN
    RAISE NOTICE 'PASS: a collection names a real entry';
END $$;

\echo '=== 9. Zero is not a collection ==='
-- A row saying "we collected nothing" is indistinguishable from one somebody
-- forgot to write, and the ledger refuses a zero-amount posting for the same
-- reason. Collecting nothing is recorded by there being no row.
DO $$
DECLARE v_entry BIGINT; v_u BIGINT;
BEGIN
    SELECT id INTO v_entry FROM journal_entries WHERE idempotency_key = 'p32:transfer';
    SELECT id INTO v_u FROM users WHERE email = 'p32-payer@example.ng';
    INSERT INTO tax_collections
      (kind, entry_id, user_id, amount_minor, currency, base_minor, rate_applied,
       occurred_at)
    VALUES ('vat', v_entry, v_u, 0, 'NGN', 0, '0bp', now());
    RAISE EXCEPTION 'TEST FAILED: a zero collection was recorded';
EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS: nothing collected is no row';
END $$;

\echo '=== 10. The monthly report is PER CURRENCY ==='
-- A return is filed in one currency. Summing kobo and cents into a single
-- figure is the arithmetic the ledger's per-currency balance invariant exists
-- to refuse, and a tax return is the last place to start doing it.
DO $$
DECLARE v_n INT;
BEGIN
    SELECT count(*) INTO v_n
      FROM information_schema.columns
     WHERE table_name = 'tax_collected_monthly' AND column_name = 'currency';
    IF v_n <> 1 THEN
        RAISE EXCEPTION 'TEST FAILED: the monthly tax report does not separate currencies';
    END IF;

    SELECT count(*) INTO v_n FROM tax_collected_monthly
     WHERE currency = 'NGN' AND kind = 'vat';
    IF v_n < 1 THEN
        RAISE EXCEPTION 'TEST FAILED: the VAT collected this month is not reported';
    END IF;
    RAISE NOTICE 'PASS: what finance files is reported per currency';
END $$;

\echo '=== 11. The transfer levy ships OFF ==='
-- Turning it on CHANGES WHAT CUSTOMERS ARE CHARGED. Whether the EMTL applies
-- to a wallet like this one is a question for a Nigerian tax adviser, so the
-- machinery ships complete and the decision does not ship at all.
DO $$
DECLARE v_value TEXT;
BEGIN
    SELECT value INTO v_value FROM platform_settings WHERE key = 'transfer_levy_enabled';
    IF v_value IS NULL THEN
        RAISE EXCEPTION 'TEST FAILED: the levy switch does not exist';
    END IF;
    IF v_value <> 'false' THEN
        RAISE EXCEPTION 'TEST FAILED: the levy ships ON, charging customers by default';
    END IF;
    RAISE NOTICE 'PASS: a charge nobody has taken advice on is off';
END $$;

\echo '=== 12. The VAT rate is BOUNDED ==='
-- A rate is a row an operator edits, so the bound is what stands between a
-- mistyped figure and every fee being wrong. 75 typed where basis points were
-- meant is 0.75% and merely wrong; 75000 would be 750%.
--
-- The handler names the reason. A bare `WHEN OTHERS` here would stay green
-- while the update failed for any other reason at all — the way Phase 10's
-- balance test was green while never reaching the check it was written for.
DO $$
DECLARE v_message TEXT;
BEGIN
    UPDATE platform_settings SET value = '75000' WHERE key = 'vat_basis_points';
    RAISE EXCEPTION 'TEST FAILED: a 750%% VAT rate was accepted';
EXCEPTION WHEN check_violation OR raise_exception THEN
    GET STACKED DIAGNOSTICS v_message = MESSAGE_TEXT;
    IF v_message NOT LIKE '%at most 2500%' THEN
        RAISE EXCEPTION 'TEST FAILED: refused, but not by the bound: %', v_message;
    END IF;
    RAISE NOTICE 'PASS: the rate cannot be set to nonsense';
END $$;

\echo '=== 13. Held tax is read from the BALANCE, not from the record ==='
-- `tax_collections` describes; the posting is the money. If the two disagree
-- the balance is the one that is true, and `tax_remittance_drift` is what
-- makes the disagreement a row somebody sees rather than an argument in March.
DO $$
DECLARE v_held BIGINT;
BEGIN
    SELECT balance_minor INTO v_held FROM tax_payable WHERE currency = 'NGN';
    IF v_held IS NULL THEN
        RAISE EXCEPTION 'TEST FAILED: nothing reports what tax we hold';
    END IF;
    IF v_held < 698 THEN
        RAISE EXCEPTION 'TEST FAILED: held tax is %, below the 698 just posted', v_held;
    END IF;
    RAISE NOTICE 'PASS: what we hold comes from the ledger';
END $$;

\echo '=== 14. Drift is reported in ONE direction ==='
-- Remitting reduces the balance without being a collection, so the balance is
-- expected to fall below what was ever collected. Only the other direction —
-- more held than we can account for — is a discrepancy, and a view that
-- flagged both would fire on every payment we make to the FIRS.
--
-- The remittance is POSTED, not assumed. Asserting on an untouched balance
-- would be asserting that a view filtering `held > collected` never returns a
-- negative difference — true by construction, and true with the whole view
-- deleted.
DO $$
DECLARE v_tax BIGINT; v_float BIGINT; v_entry BIGINT; v_n INT; v_held BIGINT;
BEGIN
    SELECT id INTO v_tax FROM accounts
     WHERE kind = 'liability_tax_payable' AND currency = 'NGN' AND owner_id IS NULL;
    SELECT id INTO v_float FROM accounts
     WHERE kind = 'provider_float' AND currency = 'NGN' AND owner_id IS NULL;

    -- Paying the FIRS: the liability falls, the money leaves.
    INSERT INTO journal_entries (idempotency_key, kind, occurred_at, description)
    VALUES ('p32:remit', 'adjustment', now(), 'a return, filed')
    RETURNING id INTO v_entry;
    INSERT INTO postings (journal_entry_id, account_id, amount_minor, currency)
    VALUES (v_entry, v_tax, -500, 'NGN'), (v_entry, v_float, 500, 'NGN');

    SELECT balance_minor INTO v_held FROM tax_payable WHERE currency = 'NGN';
    IF v_held >= 698 THEN
        RAISE EXCEPTION 'TEST FAILED: remitting did not reduce what we hold (%)', v_held;
    END IF;

    SELECT count(*) INTO v_n FROM tax_remittance_drift WHERE currency = 'NGN';
    IF v_n <> 0 THEN
        RAISE EXCEPTION 'TEST FAILED: remitting tax is reported as drift';
    END IF;
    RAISE NOTICE 'PASS: paying a return is not a discrepancy';
END $$;

\echo '=== 14b. Holding MORE than was ever collected IS drift ==='
-- The other direction, which is the one that matters: money in the account
-- that no collection explains means a path posted the tax and forgot the
-- record. Left unseen it is an unexplained figure discovered while filing.
DO $$
DECLARE v_tax BIGINT; v_float BIGINT; v_entry BIGINT; v_n INT;
BEGIN
    SELECT id INTO v_tax FROM accounts
     WHERE kind = 'liability_tax_payable' AND currency = 'NGN' AND owner_id IS NULL;
    SELECT id INTO v_float FROM accounts
     WHERE kind = 'provider_float' AND currency = 'NGN' AND owner_id IS NULL;

    INSERT INTO journal_entries (idempotency_key, kind, occurred_at, description)
    VALUES ('p32:unrecorded', 'adjustment', now(), 'tax posted with no collection row')
    RETURNING id INTO v_entry;
    INSERT INTO postings (journal_entry_id, account_id, amount_minor, currency)
    VALUES (v_entry, v_tax, 900000, 'NGN'), (v_entry, v_float, -900000, 'NGN');

    SELECT count(*) INTO v_n FROM tax_remittance_drift WHERE currency = 'NGN';
    IF v_n <> 1 THEN
        RAISE EXCEPTION 'TEST FAILED: tax held with nothing explaining it was not reported';
    END IF;
    RAISE NOTICE 'PASS: unexplained tax is a row somebody can see';
END $$;

\echo '=== 15. tax_collections has a retention DECISION ==='
-- 019 fails the build on an UNDECIDED table in both directions, and a table
-- holding what was collected on a revenue authority's behalf is exactly the
-- kind that accumulates quietly for years if nobody names it.
DO $$
DECLARE v_decision TEXT;
BEGIN
    SELECT decision INTO v_decision FROM retention_decisions
     WHERE table_name = 'tax_collections';
    IF v_decision IS NULL THEN
        RAISE EXCEPTION 'TEST FAILED: nobody decided how long tax records are kept';
    END IF;
    IF v_decision <> 'keep' THEN
        RAISE EXCEPTION 'TEST FAILED: a scheduled job can delete tax records';
    END IF;
    RAISE NOTICE 'PASS: tax records are kept, deliberately';
END $$;
