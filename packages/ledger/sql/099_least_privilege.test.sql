-- ===========================================================================
--  Xetral — least privilege invariants
--  packages/ledger/sql/022_least_privilege.test.sql
--
--  Every block runs AS THE APPLICATION ROLE, because a check performed as the
--  owner proves nothing about what the application can do.
-- ===========================================================================
\set QUIET on
\pset format unaligned
\pset tuples_only on

-- A real entry to attack, created as the owner.
INSERT INTO users (email, status) VALUES ('lp-probe@example.ng', 'active');
DO $$
DECLARE v_user BIGINT; v_wallet BIGINT; v_float BIGINT; v_entry BIGINT;
BEGIN
    SELECT id INTO v_user FROM users WHERE email = 'lp-probe@example.ng';
    INSERT INTO accounts (kind, owner_type, owner_id, currency, normal_balance)
    VALUES ('customer_wallet', 'user', v_user, 'NGN', 'credit') RETURNING id INTO v_wallet;
    SELECT id INTO v_float FROM accounts
     WHERE kind = 'provider_float' AND currency = 'NGN' AND owner_id IS NULL;
    IF v_float IS NULL THEN
        INSERT INTO accounts (kind, currency, normal_balance)
        VALUES ('provider_float', 'NGN', 'debit') RETURNING id INTO v_float;
    END IF;

    INSERT INTO journal_entries (idempotency_key, kind, occurred_at, description)
    VALUES ('lp:seed', 'wallet_funding', now(), 'seed') RETURNING id INTO v_entry;
    INSERT INTO postings (journal_entry_id, account_id, amount_minor, currency) VALUES
      (v_entry, v_wallet, 100000, 'NGN'),
      (v_entry, v_float, -100000, 'NGN');
END $$;

\echo '=== 1. The application role cannot DISABLE the immutability trigger ==='
-- THE BLOCK THIS MIGRATION EXISTS FOR. Before it, the app owned these tables,
-- and a table's owner turns its triggers off with one statement — so the
-- immutability guarantee was really "nobody runs two statements".
DO $$
BEGIN
    SET LOCAL ROLE xetral_app;
    EXECUTE 'ALTER TABLE postings DISABLE TRIGGER USER';
    RESET ROLE;
    RAISE EXCEPTION 'TEST FAILED: the application disabled the ledger immutability trigger';
EXCEPTION
    WHEN insufficient_privilege THEN
        RESET ROLE;
        RAISE NOTICE 'PASS: the app cannot switch off the rule that protects the ledger';
END $$;

\echo ''
\echo '=== 2. It cannot UPDATE a posting, trigger or no trigger ==='
-- Belt to the trigger's braces: the privilege is absent as well, so the
-- statement is refused before any trigger has an opinion.
DO $$
BEGIN
    SET LOCAL ROLE xetral_app;
    EXECUTE 'UPDATE postings SET amount_minor = amount_minor + 500000';
    RESET ROLE;
    RAISE EXCEPTION 'TEST FAILED: the application rewrote a posting';
EXCEPTION
    WHEN insufficient_privilege THEN
        RESET ROLE;
        RAISE NOTICE 'PASS: rewriting financial history is not a privilege the app holds';
END $$;

\echo ''
\echo '=== 3. It cannot DELETE a posting ==='
DO $$
BEGIN
    SET LOCAL ROLE xetral_app;
    EXECUTE 'DELETE FROM postings';
    RESET ROLE;
    RAISE EXCEPTION 'TEST FAILED: the application deleted a posting';
EXCEPTION
    WHEN insufficient_privilege THEN
        RESET ROLE;
        RAISE NOTICE 'PASS: a posting cannot be removed by the application';
END $$;

\echo ''
\echo '=== 4. It cannot CREATE a table, so it cannot own one ==='
-- A role that can create a table owns it, which is the ownership problem by
-- another route.
DO $$
BEGIN
    SET LOCAL ROLE xetral_app;
    EXECUTE 'CREATE TABLE lp_should_not_exist (id INT)';
    RESET ROLE;
    RAISE EXCEPTION 'TEST FAILED: the application created a table';
EXCEPTION
    WHEN insufficient_privilege THEN
        RESET ROLE;
        RAISE NOTICE 'PASS: the app cannot create a table it would then own';
END $$;

\echo ''
\echo '=== 5. It CAN still do its job: read and append ==='
-- A privilege model that breaks the product is one somebody widens back to
-- superuser on the first outage.
DO $$
DECLARE v_entry BIGINT; v_count BIGINT;
BEGIN
    SET LOCAL ROLE xetral_app;

    SELECT count(*) INTO v_count FROM postings;
    IF v_count = 0 THEN
        RESET ROLE;
        RAISE EXCEPTION 'TEST FAILED: the app cannot read postings';
    END IF;

    INSERT INTO journal_entries (idempotency_key, kind, occurred_at, description)
    VALUES ('lp:app-write', 'adjustment', now(), 'written by the app role')
    RETURNING id INTO v_entry;

    RESET ROLE;
    RAISE NOTICE 'PASS: the application can read and append, which is all it needs';
END $$;

\echo ''
\echo '=== 6. The app holds DELETE on NOTHING, anywhere ==='
-- DERIVED, not listed, so a table added next year cannot arrive with DELETE.
--
-- Written first as "every table with an append-only trigger is read-append",
-- which was wrong and said so loudly: most of those triggers are PARTIAL. A
-- refresh token permits consumption and refuses everything else; a deposit
-- permits a suspense resolution and refuses the rest. Revoking UPDATE from
-- those would have broken the product to satisfy a heuristic about a trigger's
-- name.
--
-- What IS true across every table is that nothing may be deleted by the
-- application at all — the retention sweep is the only thing here that removes
-- a row, and it runs as the owner.
DO $$
DECLARE v_deletable TEXT;
BEGIN
    SELECT string_agg(c.relname, ', ' ORDER BY c.relname) INTO v_deletable
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'r'
       AND has_table_privilege('xetral_app', c.oid, 'DELETE');

    IF v_deletable IS NOT NULL THEN
        RAISE EXCEPTION 'TEST FAILED: the app can DELETE from: %', v_deletable;
    END IF;
    RAISE NOTICE 'PASS: no row anywhere can be deleted by the application';
END $$;

\echo ''
\echo '=== 6b. And UPDATE is revoked on every table named in 022 ==='
-- The stated list IS the security decision, so it is checked against reality
-- rather than trusted. A name removed from 022 by accident fails here.
DO $$
DECLARE
    v_stated TEXT[] := ARRAY[
        'journal_entries', 'postings', 'admin_audit_log',
        'card_reveals', 'provider_balance_checks'
    ];
    v_table TEXT;
BEGIN
    FOREACH v_table IN ARRAY v_stated LOOP
        IF has_table_privilege('xetral_app', format('public.%I', v_table), 'UPDATE') THEN
            RAISE EXCEPTION 'TEST FAILED: % is still updatable by the app', v_table;
        END IF;
    END LOOP;
    RAISE NOTICE 'PASS: every table 022 names as append-only really is, for the app';
END $$;

\echo '=== 7. Retention still works, through the FUNCTION ==='
-- The app holds no DELETE anywhere, so the only way a row leaves is
-- `apply_retention()` running as the owner. What may be deleted is decided by
-- the body of that function rather than by a permission somebody granted once.
DO $$
DECLARE v_ran BOOLEAN := FALSE;
BEGIN
    SET LOCAL ROLE xetral_app;
    PERFORM apply_retention();
    v_ran := TRUE;
    RESET ROLE;

    IF NOT v_ran THEN
        RAISE EXCEPTION 'TEST FAILED: the app could not run the retention sweep';
    END IF;
    RAISE NOTICE 'PASS: deletion happens through an audited function, never a grant';
END $$;
