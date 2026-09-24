-- ============================================================================
--  079 invariants — the routing policy
-- ============================================================================
\set ON_ERROR_STOP on

-- 1. There is exactly one policy row, and it ships reading the route table
--    with the account fallback on.
DO $$
DECLARE n INT; m TEXT; f BOOLEAN;
BEGIN
    SELECT count(*) INTO n FROM provider_routing_policy;
    IF n <> 1 THEN
        RAISE EXCEPTION 'TEST FAILED 1: % routing policy rows', n;
    END IF;
    SELECT mode, account_fallback INTO m, f FROM provider_routing_policy;
    IF m IS DISTINCT FROM 'per_route' OR f IS DISTINCT FROM TRUE THEN
        RAISE EXCEPTION 'TEST FAILED 1: shipped as mode % fallback %', m, f;
    END IF;
    RAISE NOTICE 'PASS 1: one policy row, per_route, fallback on';
END $$;

-- 2. It cannot be deleted into nothing.
DO $$
BEGIN
    BEGIN
        DELETE FROM provider_routing_policy;
        RAISE EXCEPTION 'TEST FAILED 2: the policy row was deleted';
    EXCEPTION WHEN raise_exception THEN
        IF SQLERRM LIKE 'TEST FAILED%' THEN RAISE; END IF;
        RAISE NOTICE 'PASS 2: the policy is changed, never removed';
    END;
END $$;

-- 3. A mode that needs a provider cannot be set without one.
DO $$
BEGIN
    BEGIN
        UPDATE provider_routing_policy SET mode = 'single', single_provider = NULL;
        RAISE EXCEPTION 'TEST FAILED 3: single mode was accepted with no provider';
    EXCEPTION WHEN check_violation THEN
        NULL;
    END;
    BEGIN
        UPDATE provider_routing_policy SET mode = 'by_coverage', preferred_provider = NULL;
        RAISE EXCEPTION 'TEST FAILED 3: by_coverage was accepted with no preference';
    EXCEPTION WHEN check_violation THEN
        NULL;
    END;
    RAISE NOTICE 'PASS 3: a mode that names a provider must name one';
END $$;

-- 4. A change is recorded by trigger, and the history is append-only.
DO $$
DECLARE n INT;
BEGIN
    UPDATE provider_routing_policy
       SET mode = 'single', single_provider = 'flutterwave';
    SELECT count(*) INTO n FROM provider_routing_policy_history
     WHERE mode = 'single' AND single_provider = 'flutterwave';
    IF n < 1 THEN
        RAISE EXCEPTION 'TEST FAILED 4: a policy change left no history';
    END IF;
    BEGIN
        UPDATE provider_routing_policy_history SET mode = 'per_route';
        RAISE EXCEPTION 'TEST FAILED 4: the history was edited';
    EXCEPTION WHEN raise_exception THEN
        IF SQLERRM LIKE 'TEST FAILED%' THEN RAISE; END IF;
    END;
    UPDATE provider_routing_policy
       SET mode = 'per_route', single_provider = NULL;
    RAISE NOTICE 'PASS 4: policy changes are on the record and cannot be rewritten';
END $$;

-- 5. Coverage names only providers and operations the platform dispatches on,
--    and naira account numbers can be opened by more than one rail — which is
--    what the account fallback depends on.
DO $$
DECLARE n INT;
BEGIN
    SELECT count(*) INTO n FROM provider_coverage WHERE operation = 'account' AND currency = 'NGN';
    IF n < 2 THEN
        RAISE EXCEPTION 'TEST FAILED 5: only % rail(s) cover naira account numbers', n;
    END IF;
    BEGIN
        INSERT INTO provider_coverage (provider, operation, currency, basis)
        VALUES ('bitnob', 'issue_card', 'USD', 'an operation nothing dispatches on');
        RAISE EXCEPTION 'TEST FAILED 5: an unknown operation was accepted';
    EXCEPTION WHEN check_violation THEN
        NULL;
    END;
    RAISE NOTICE 'PASS 5: coverage is bounded, and naira accounts have a second rail';
END $$;

-- 6. Paystack's Nigerian registration covers naira and nothing else.
DO $$
DECLARE n INT;
BEGIN
    SELECT count(*) INTO n FROM provider_coverage
     WHERE provider = 'paystack' AND currency <> 'NGN';
    IF n <> 0 THEN
        RAISE EXCEPTION 'TEST FAILED 6: Paystack is recorded as covering % non-naira rows', n;
    END IF;
    RAISE NOTICE 'PASS 6: Paystack covers naira only';
END $$;
