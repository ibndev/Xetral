-- ===========================================================================
--  Xetral — provider balance reconciliation invariants
--  packages/ledger/sql/020_balance_reconciliation.test.sql
-- ===========================================================================
\set QUIET on
\pset format unaligned
\pset tuples_only on

INSERT INTO users (email, status) VALUES ('balance-ops@example.ng', 'active');

\echo '=== 1. The difference must AGREE with the two sides ==='
-- The finding is what somebody acts on. A row whose stated difference does not
-- follow from the two figures it quotes is a finding about nothing.
DO $$
BEGIN
    INSERT INTO provider_balance_checks
      (provider, scope, subject, currency, provider_minor, ledger_minor, difference_minor)
    VALUES ('bitnob', 'provider_float', 'NGN', 'NGN', 100000, 90000, 5000);
    RAISE EXCEPTION 'TEST FAILED: a difference that does not follow was accepted';
EXCEPTION
    WHEN check_violation THEN
        RAISE NOTICE 'PASS: the arithmetic of a finding is enforced, not trusted';
END $$;

\echo ''
\echo '=== 2. A finding can be recorded ==='
DO $$
BEGIN
    INSERT INTO provider_balance_checks
      (provider, scope, subject, currency, provider_minor, ledger_minor, difference_minor)
    VALUES ('bitnob', 'provider_float', 'NGN', 'NGN', 100000, 90000, 10000);
    RAISE NOTICE 'PASS: a discrepancy is written down rather than acted on';
END $$;

\echo ''
\echo '=== 3. What the two sides SAID cannot be edited ==='
-- This is the row that matters in the argument about where the money went.
DO $$
DECLARE v_id BIGINT;
BEGIN
    SELECT id INTO v_id FROM provider_balance_checks ORDER BY id DESC LIMIT 1;
    UPDATE provider_balance_checks SET provider_minor = 90000, difference_minor = 0
     WHERE id = v_id;
    RAISE EXCEPTION 'TEST FAILED: a recorded discrepancy was rewritten';
EXCEPTION
    WHEN restrict_violation THEN
        RAISE NOTICE 'PASS: a finding is a fact and stays what it was';
END $$;

\echo ''
\echo '=== 4. A finding cannot be DELETED ==='
DO $$
DECLARE v_id BIGINT;
BEGIN
    SELECT id INTO v_id FROM provider_balance_checks ORDER BY id DESC LIMIT 1;
    DELETE FROM provider_balance_checks WHERE id = v_id;
    RAISE EXCEPTION 'TEST FAILED: a discrepancy was deleted';
EXCEPTION
    WHEN restrict_violation THEN
        RAISE NOTICE 'PASS: a discrepancy is resolved, never removed';
END $$;

\echo ''
\echo '=== 5. Resolving needs a PERSON and a REASON ==='
DO $$
DECLARE v_id BIGINT;
BEGIN
    SELECT id INTO v_id FROM provider_balance_checks ORDER BY id DESC LIMIT 1;
    UPDATE provider_balance_checks SET resolved_at = now() WHERE id = v_id;
    RAISE EXCEPTION 'TEST FAILED: a discrepancy was closed with nobody and no reason';
EXCEPTION
    WHEN check_violation THEN
        RAISE NOTICE 'PASS: an unexplained resolution cannot be recorded';
END $$;

\echo ''
\echo '=== 6. A resolved finding is FINAL ==='
DO $$
DECLARE v_id BIGINT; v_ops BIGINT;
BEGIN
    SELECT id INTO v_ops FROM users WHERE email = 'balance-ops@example.ng';
    SELECT id INTO v_id FROM provider_balance_checks ORDER BY id DESC LIMIT 1;

    UPDATE provider_balance_checks
       SET resolved_at = now(), resolved_by = v_ops,
           resolution = 'an open card hold Bitnob had not settled yet'
     WHERE id = v_id;

    UPDATE provider_balance_checks SET resolution = 'actually something else' WHERE id = v_id;
    RAISE EXCEPTION 'TEST FAILED: a resolved discrepancy was reopened';
EXCEPTION
    WHEN restrict_violation THEN
        RAISE NOTICE 'PASS: an explanation cannot be replaced after the fact';
END $$;

\echo ''
\echo '=== 7. The QUEUE shows only what is unresolved, worst first ==='
DO $$
DECLARE v_open INT; v_top BIGINT;
BEGIN
    INSERT INTO provider_balance_checks
      (provider, scope, subject, currency, provider_minor, ledger_minor, difference_minor)
    VALUES ('bitnob', 'provider_float', 'USD', 'USD', 500, 100, 400),
           ('bitnob', 'card', 'card-uuid-1', 'USD', 100, 9100, -9000);

    -- Counted among ITS OWN rows rather than globally. Written as a global
    -- count first, this asserted 2 and saw 3 — an earlier block's resolution
    -- had rolled back with the exception it was testing for, leaving its row
    -- unresolved. A test that depends on what another block left behind is
    -- asserting on whichever one ran last.
    SELECT count(*) INTO v_open FROM provider_balance_drift
     WHERE subject IN ('USD', 'card-uuid-1');
    IF v_open <> 2 THEN
        RAISE EXCEPTION 'TEST FAILED: expected 2 unresolved of its own, saw %', v_open;
    END IF;

    -- Ordered by MAGNITUDE: a queue ordered by time buries the one that
    -- matters under a week of small ones, and a signed sort would put the
    -- largest SHORTFALL last — which is the direction that means money is
    -- missing. Asserted as "the first row is the largest" rather than against
    -- a literal, because the literal was really an assertion about which other
    -- blocks had run.
    SELECT magnitude_minor INTO v_top FROM provider_balance_drift LIMIT 1;
    IF v_top <> (SELECT max(magnitude_minor) FROM provider_balance_drift) THEN
        RAISE EXCEPTION 'TEST FAILED: the queue does not lead with the largest (%)', v_top;
    END IF;

    -- And the -9000 shortfall outranks the +400 surplus, which a signed sort
    -- would get exactly backwards.
    IF (SELECT magnitude_minor FROM provider_balance_drift WHERE subject = 'card-uuid-1')
       <= (SELECT magnitude_minor FROM provider_balance_drift WHERE subject = 'USD') THEN
        RAISE EXCEPTION 'TEST FAILED: a shortfall ranked below a smaller surplus';
    END IF;
    RAISE NOTICE 'PASS: the biggest unexplained difference is what an operator sees first';
END $$;

\echo ''
\echo '=== 8. The tolerance is BOUNDED and defaults to zero ==='
-- A tolerance is a decision to stop looking at a class of error. On a
-- double-entry ledger the correct difference is nothing.
DO $$
DECLARE v_default TEXT;
BEGIN
    SELECT value INTO v_default FROM platform_settings WHERE key = 'balance_tolerance_minor';
    IF v_default IS DISTINCT FROM '0' THEN
        RAISE EXCEPTION 'TEST FAILED: the shipped tolerance is % rather than zero', v_default;
    END IF;

    UPDATE platform_settings SET value = '-1' WHERE key = 'balance_tolerance_minor';
    RAISE EXCEPTION 'TEST FAILED: a negative tolerance was accepted';
EXCEPTION
    WHEN check_violation THEN
        RAISE NOTICE 'PASS: ships at zero, and cannot be set below it';
END $$;
