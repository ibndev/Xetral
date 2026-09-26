-- ============================================================================
--  076 invariants — account numbers route on their own
-- ============================================================================
\set ON_ERROR_STOP on

-- 1. `account` is a routable operation, and naira account numbers go to
--    Flutterwave unless somebody decided otherwise.
DO $$
DECLARE v TEXT;
BEGIN
    SELECT provider INTO v FROM provider_routes WHERE operation = 'account' AND currency = 'NGN';
    IF v IS NULL THEN
        RAISE EXCEPTION 'TEST FAILED 1: no account route for NGN';
    END IF;
    RAISE NOTICE 'PASS 1: naira account numbers are routed (to %)', v;
END $$;

-- 2. It moved account numbers and NOTHING ELSE. A naira checkout is still
--    answered by the `collect` row it always was.
DO $$
DECLARE v TEXT;
BEGIN
    SELECT provider INTO v FROM provider_routes WHERE operation = 'collect' AND currency = 'NGN';
    IF v IS DISTINCT FROM 'paystack' THEN
        RAISE EXCEPTION 'TEST FAILED 2: the naira checkout route moved to %', v;
    END IF;
    RAISE NOTICE 'PASS 2: naira checkouts stay where they were';
END $$;

-- 3. An operation nothing dispatches on is still refused.
DO $$
BEGIN
    BEGIN
        INSERT INTO provider_routes (operation, currency, provider)
        VALUES ('issue_card', 'NGN', 'bitnob');
        RAISE EXCEPTION 'TEST FAILED 3: an unknown operation was accepted';
    EXCEPTION WHEN check_violation THEN
        RAISE NOTICE 'PASS 3: only account, collect and payout can be routed';
    END;
END $$;

-- 4. Moving it is recorded, like every route change.
--    PUT BACK TO WHAT IT WAS, not to a rail this suite names: 083 moved naira
--    account numbers to Paystack, and a suite restoring a value it does not
--    own undoes a later migration on the shared invariant database — 033's
--    lesson about a hardcoded consent version.
DO $$
DECLARE
    n   INT;
    was TEXT;
BEGIN
    SELECT provider INTO was FROM provider_routes
     WHERE operation = 'account' AND currency = 'NGN';
    UPDATE provider_routes SET provider = 'bitnob'
     WHERE operation = 'account' AND currency = 'NGN';
    SELECT count(*) INTO n FROM provider_route_history
     WHERE operation = 'account' AND currency = 'NGN' AND now_is = 'bitnob';
    IF n < 1 THEN
        RAISE EXCEPTION 'TEST FAILED 4: an account route change left no history';
    END IF;
    UPDATE provider_routes SET provider = was
     WHERE operation = 'account' AND currency = 'NGN';
    RAISE NOTICE 'PASS 4: moving naira account numbers is on the record';
END $$;

-- 5. No Flutterwave account is still keyed on an email address.
DO $$
DECLARE n INT;
BEGIN
    SELECT count(*) INTO n FROM virtual_accounts
     WHERE provider = 'flutterwave' AND provider_customer_ref LIKE '%@%';
    IF n <> 0 THEN
        RAISE EXCEPTION 'TEST FAILED 5: % Flutterwave account(s) still keyed on an email', n;
    END IF;
    RAISE NOTICE 'PASS 5: every Flutterwave account is found by its own reference';
END $$;
