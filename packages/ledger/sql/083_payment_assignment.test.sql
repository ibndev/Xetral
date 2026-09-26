-- ============================================================================
--  083 invariants — the owner's assignment is what the route table says
-- ============================================================================
\set ON_ERROR_STOP on

-- 1. Every assigned corridor names the assigned rail.
DO $$
DECLARE
    v_wrong TEXT;
BEGIN
    SELECT string_agg(format('%s %s = %s (wanted %s)', w.operation, w.currency,
                             coalesce(r.provider, 'none'), w.provider), '; ')
      INTO v_wrong
      FROM (VALUES ('account', 'NGN', 'paystack'),
                   ('payout',  'NGN', 'paystack'),
                   ('collect', 'GHS', 'flutterwave'),
                   ('payout',  'GHS', 'flutterwave'),
                   ('payout',  'KES', 'bitnob')) AS w(operation, currency, provider)
      LEFT JOIN provider_routes r
        ON r.operation = w.operation AND r.currency = w.currency
     WHERE r.provider IS DISTINCT FROM w.provider;
    IF v_wrong IS NOT NULL THEN
        RAISE EXCEPTION 'TEST FAILED: %', v_wrong;
    END IF;
    RAISE NOTICE 'PASS: every assigned corridor names its assigned rail';
END $$;

-- 2. Kenyan collection has NO rail, in the table or in coverage — so neither
--    per_route nor by_coverage can pick one.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM provider_routes WHERE operation = 'collect' AND currency = 'KES') THEN
        RAISE EXCEPTION 'TEST FAILED: collect KES is still routed';
    END IF;
    IF EXISTS (SELECT 1 FROM provider_coverage WHERE operation = 'collect' AND currency = 'KES') THEN
        RAISE EXCEPTION 'TEST FAILED: collect KES is still covered, so by_coverage would route it';
    END IF;
    RAISE NOTICE 'PASS: Kenyan collection is unconfigured';
END $$;

-- 3. Removing a route leaves a trace: who and when, with now_is NULL.
DO $$
DECLARE
    v_rows INT;
BEGIN
    INSERT INTO provider_routes (operation, currency, provider) VALUES ('collect', 'ZZZ', 'paystack');
    DELETE FROM provider_routes WHERE operation = 'collect' AND currency = 'ZZZ';
    SELECT count(*) INTO v_rows
      FROM provider_route_history
     WHERE operation = 'collect' AND currency = 'ZZZ' AND was = 'paystack' AND now_is IS NULL;
    IF v_rows <> 1 THEN
        RAISE EXCEPTION 'TEST FAILED: a removed route left % history row(s)', v_rows;
    END IF;
    RAISE NOTICE 'PASS: a removed route is recorded';
END $$;
