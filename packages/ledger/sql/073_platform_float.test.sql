-- ===========================================================================
--  073 — invariants for the platform's own currency position
--
--  THE SIGN IS WHAT THIS FILE IS FOR. `held_minor` is the NEGATIVE of the
--  ledger balance, because liabilities are positive in this schema and an
--  asset a provider holds on our behalf is therefore negative. Get that
--  backwards and a healthy float reads as a shortfall and a shortfall reads
--  as healthy — and NOTHING ELSE would notice, because the entries balance
--  either way and `ledger_drift` reports nothing.
--
--  IT MEASURES DELTAS AND RESTORES WHAT IT FOUND. These files share one
--  database and run in order, so GHS carries whatever earlier suites left in
--  it; an absolute figure here would be an assertion about them. And the
--  entry below is reversed rather than left behind, because postings are
--  append-only and a test that quietly funds a currency changes what every
--  later file sees.
--
--  GHS RATHER THAN A CURRENCY NOBODY USES, deliberately. Creating an account
--  in a new currency adds it to `SELECT DISTINCT currency FROM accounts`,
--  which is what `kyc_tier_coverage` and `risk_currency_coverage` are built
--  from — so a JPY account here would turn two unrelated green suites red,
--  exactly as 038 records about the first USDC account.
-- ===========================================================================
\set ON_ERROR_STOP on

-- Resolve-or-create, for the reason 003 records: a PLATFORM account has one
-- row per currency for the whole database, so an unconditional INSERT aborts
-- the run with a unique violation that reads as a bug in this migration.
CREATE OR REPLACE FUNCTION test_account(
    p_kind account_kind, p_owner BIGINT, p_currency TEXT, p_normal TEXT
) RETURNS BIGINT AS $fn$
DECLARE v_id BIGINT;
BEGIN
    SELECT id INTO v_id FROM accounts
     WHERE kind = p_kind AND currency = p_currency
       AND owner_id IS NOT DISTINCT FROM p_owner;
    IF v_id IS NOT NULL THEN RETURN v_id; END IF;

    INSERT INTO accounts (kind, owner_type, owner_id, currency, normal_balance)
    VALUES (p_kind, CASE WHEN p_owner IS NULL THEN NULL ELSE 'user' END,
            p_owner, p_currency, p_normal)
    RETURNING id INTO v_id;
    RETURN v_id;
END $fn$ LANGUAGE plpgsql;

DO $$
DECLARE
    v_float     BIGINT;
    v_revenue   BIGINT;
    v_entry     BIGINT;
    v_reversal  BIGINT;
    v_held_was  BIGINT;
    v_bal_was   BIGINT;
    v_held_now  BIGINT;
    v_bal_now   BIGINT;
BEGIN
    v_float   := test_account('provider_float', NULL, 'GHS', 'debit');
    v_revenue := test_account('revenue_fees',   NULL, 'GHS', 'credit');

    SELECT held_minor, ledger_balance_minor INTO v_held_was, v_bal_was
      FROM platform_float_positions WHERE currency = 'GHS';
    IF v_held_was IS NULL THEN
        RAISE EXCEPTION 'TEST FAILED 1a: no position for a currency with a float account';
    END IF;

    /*
     * MONEY ARRIVING AT THE PROVIDER. `provider_float` goes DOWN by 1,000,
     * which is what a collection posts — so what the platform HOLDS must go
     * UP by 1,000. The other leg is a platform account rather than a
     * customer wallet, because what is being tested is the float and a
     * customer leg would drag in the overdraft guard for no reason.
     */
    INSERT INTO journal_entries (idempotency_key, kind, occurred_at, description)
    VALUES ('p073:collect', 'wallet_funding', now(), 'a collection, to move the float')
    RETURNING id INTO v_entry;

    INSERT INTO postings (journal_entry_id, account_id, amount_minor, currency)
    VALUES (v_entry, v_float, -1000, 'GHS'),
           (v_entry, v_revenue, 1000, 'GHS');

    SELECT held_minor, ledger_balance_minor INTO v_held_now, v_bal_now
      FROM platform_float_positions WHERE currency = 'GHS';

    IF v_bal_now - v_bal_was <> -1000 THEN
        RAISE EXCEPTION 'TEST FAILED 1b: the ledger balance moved by %, expected -1000',
            v_bal_now - v_bal_was;
    END IF;
    IF v_held_now - v_held_was <> 1000 THEN
        RAISE EXCEPTION
            'TEST FAILED 1c: a provider taking in 1000 must raise held_minor by 1000, got %',
            v_held_now - v_held_was;
    END IF;
    RAISE NOTICE 'PASS 1: held_minor is the negative of the ledger balance';

    -- RESTORED, because postings are append-only and a later file must see
    -- the float it would have seen without this test.
    INSERT INTO journal_entries
        (idempotency_key, kind, occurred_at, description, reverses_id)
    VALUES ('p073:collect-undo', 'reversal', now(), 'undo the test collection', v_entry)
    RETURNING id INTO v_reversal;

    INSERT INTO postings (journal_entry_id, account_id, amount_minor, currency)
    VALUES (v_reversal, v_float, 1000, 'GHS'),
           (v_reversal, v_revenue, -1000, 'GHS');

    SELECT held_minor INTO v_held_now
      FROM platform_float_positions WHERE currency = 'GHS';
    IF v_held_now <> v_held_was THEN
        RAISE EXCEPTION 'TEST FAILED 1d: the reversal left the float at % rather than %',
            v_held_now, v_held_was;
    END IF;
    RAISE NOTICE 'PASS 1e: the books are as they were found';
END $$;

DO $$
DECLARE
    v_wrong BIGINT;
BEGIN
    /*
     * 2. THE SHORTFALL VIEW AGREES WITH THE POSITION VIEW, BOTH WAYS.
     *
     *    Asserted as a PROPERTY over whatever the database currently holds
     *    rather than by contriving a shortfall — which would mean driving a
     *    live currency negative and leaving it that way for every later file.
     *    Both directions, because a queue that under-reports is the one that
     *    silently fills and a queue that over-reports is the one people learn
     *    to ignore: 036's argument, and 015's.
     */
    SELECT COUNT(*) INTO v_wrong
      FROM platform_float_positions p
      LEFT JOIN platform_float_shortfalls s ON s.currency = p.currency
     WHERE (p.committed_minor > p.held_minor) <> (s.currency IS NOT NULL);
    IF v_wrong <> 0 THEN
        RAISE EXCEPTION
            'TEST FAILED 2a: % currencies disagree between the position and the shortfall',
            v_wrong;
    END IF;

    -- And the figure is the gap itself, not the amount held.
    SELECT COUNT(*) INTO v_wrong
      FROM platform_float_shortfalls
     WHERE short_by_minor <> committed_minor - held_minor;
    IF v_wrong <> 0 THEN
        RAISE EXCEPTION 'TEST FAILED 2b: short_by_minor is not the gap';
    END IF;
    RAISE NOTICE 'PASS 2: the shortfall view is exactly the currencies that are short';
END $$;

DO $$
DECLARE
    v_enabled TEXT;
BEGIN
    -- 3. THE GUARD SHIPS ON. Off, the refusal it prevents still happens — it
    --    just arrives from the provider afterwards, as a message about the
    --    customer's own account, which is the misdiagnosis this migration
    --    exists to end.
    SELECT value INTO v_enabled FROM platform_settings
     WHERE key = 'payout_float_guard_enabled';
    IF v_enabled IS DISTINCT FROM 'true' THEN
        RAISE EXCEPTION 'TEST FAILED 3: the float guard must ship enabled, found %',
            COALESCE(v_enabled, '(no row)');
    END IF;
    RAISE NOTICE 'PASS 3: the float guard ships on';
END $$;

DO $$
DECLARE
    v_decision TEXT;
    v_name     TEXT;
BEGIN
    -- 4. BOTH VIEWS ARE CLASSIFIED, in 036's terms, and as what was intended
    --    rather than merely as something. A `watch` must carry no queue name;
    --    the coverage view refuses an undecided source in either direction.
    SELECT decision, queue_name INTO v_decision, v_name
      FROM attention_sources WHERE source = 'platform_float_shortfalls';
    IF v_decision IS DISTINCT FROM 'watch' THEN
        RAISE EXCEPTION 'TEST FAILED 4a: the shortfall view must be a watch, found %',
            COALESCE(v_decision, '(undecided)');
    END IF;
    IF v_name IS NOT NULL THEN
        RAISE EXCEPTION 'TEST FAILED 4b: a watch must carry no queue name, found %', v_name;
    END IF;

    SELECT decision INTO v_decision
      FROM attention_sources WHERE source = 'platform_float_positions';
    IF v_decision IS DISTINCT FROM 'internal' THEN
        RAISE EXCEPTION 'TEST FAILED 4c: the position view must be internal, found %',
            COALESCE(v_decision, '(undecided)');
    END IF;
    RAISE NOTICE 'PASS 4: both views are classified';
END $$;
