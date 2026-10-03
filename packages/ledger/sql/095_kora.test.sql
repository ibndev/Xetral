-- ============================================================================
--  095 invariants — Kora carries what it documents, and the old rail is gone
-- ============================================================================
\set ON_ERROR_STOP on

-- 1. Nothing routes to, covers, prefers or authorises the removed rail.
DO $$
DECLARE
    left_over TEXT;
BEGIN
    SELECT string_agg(what, '; ') INTO left_over FROM (
        SELECT 'route ' || operation || ' ' || currency AS what
          FROM provider_routes WHERE provider = 'flutterwave'
        UNION ALL
        SELECT 'coverage ' || operation || ' ' || currency
          FROM provider_coverage WHERE provider = 'flutterwave'
        UNION ALL
        SELECT 'slot ' || name FROM provider_credential_slots WHERE provider = 'flutterwave'
        UNION ALL
        SELECT 'policy' FROM provider_routing_policy
         WHERE preferred_provider = 'flutterwave' OR single_provider = 'flutterwave'
        UNION ALL
        SELECT 'open account ' || id FROM virtual_accounts
         WHERE provider = 'flutterwave' AND status <> 'closed'
    ) s;
    IF left_over IS NOT NULL THEN
        RAISE EXCEPTION 'TEST FAILED 1: the removed rail is still configured: %', left_over;
    END IF;
    RAISE NOTICE 'PASS 1: the removed rail routes, covers, holds and authorises nothing';
END $$;

-- 2. The CHECKs refuse the old name, so a form or a prompt cannot bring it back.
DO $$
BEGIN
    BEGIN
        INSERT INTO provider_coverage (provider, operation, currency, basis)
        VALUES ('flutterwave', 'collect', 'GHS', 'a rail this platform no longer has');
        RAISE EXCEPTION 'TEST FAILED 2: coverage accepted the removed rail';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
    BEGIN
        UPDATE provider_routing_policy SET preferred_provider = 'flutterwave';
        RAISE EXCEPTION 'TEST FAILED 2: the policy accepted the removed rail';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
    RAISE NOTICE 'PASS 2: the removed rail cannot be named again';
END $$;

-- 3. Kora's coverage is exactly what its guides document, with the evidence,
--    and neither a dollar checkout nor a Kenyan collection is among it.
DO $$
DECLARE
    got TEXT;
BEGIN
    SELECT string_agg(operation || ' ' || currency, ', ' ORDER BY operation, currency)
      INTO got FROM provider_coverage WHERE provider = 'kora';
    IF got IS DISTINCT FROM
       'account NGN, collect GHS, collect NGN, payout GHS, payout KES, payout NGN' THEN
        RAISE EXCEPTION 'TEST FAILED 3: Kora covers %', got;
    END IF;
    IF EXISTS (SELECT 1 FROM provider_coverage
                WHERE provider = 'kora' AND basis NOT LIKE '%guide%' AND basis NOT LIKE '%Overview%') THEN
        RAISE EXCEPTION 'TEST FAILED 3: a Kora coverage row does not name its source';
    END IF;
    RAISE NOTICE 'PASS 3: Kora covers what it documents, and nothing else';
END $$;

-- 4. Cedis are routed to Kora, both ways; naira did not move.
DO $$
DECLARE
    v_wrong TEXT;
BEGIN
    SELECT string_agg(format('%s %s = %s', w.operation, w.currency, coalesce(r.provider, 'none')), '; ')
      INTO v_wrong
      FROM (VALUES ('collect', 'GHS', 'kora'),
                   ('payout',  'GHS', 'kora'),
                   ('collect', 'NGN', 'paystack')) AS w(operation, currency, provider)
      LEFT JOIN provider_routes r ON r.operation = w.operation AND r.currency = w.currency
     WHERE r.provider IS DISTINCT FROM w.provider;
    IF v_wrong IS NOT NULL THEN
        RAISE EXCEPTION 'TEST FAILED 4: %', v_wrong;
    END IF;
    RAISE NOTICE 'PASS 4: cedis go to Kora and naira stays where it was';
END $$;

-- 5. Kora's one key is a slot in use.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM provider_credential_slots
                    WHERE provider = 'kora' AND name = 'secret_key' AND in_use
                      AND env_var = 'KORA_SECRET_KEY') THEN
        RAISE EXCEPTION 'TEST FAILED 5: no Kora secret key slot';
    END IF;
    RAISE NOTICE 'PASS 5: Kora''s secret key has its slot';
END $$;

-- 6. The privacy notice naming Kora is live (AT OR AFTER, so a later republish
--    does not turn this red), alone, and nothing older is.
DO $$
DECLARE n INT;
BEGIN
    SELECT count(*) INTO n FROM consent_documents
     WHERE kind = 'privacy' AND retired_at IS NULL AND version >= '2026-10-04';
    IF n <> 1 THEN
        RAISE EXCEPTION 'TEST FAILED 6: % live privacy notices at or after 2026-10-04', n;
    END IF;
    IF EXISTS (SELECT 1 FROM consent_documents
                WHERE kind = 'privacy' AND retired_at IS NULL AND version < '2026-10-04') THEN
        RAISE EXCEPTION 'TEST FAILED 6: an older privacy notice is still live';
    END IF;
    RAISE NOTICE 'PASS 6: the privacy notice naming Kora is the live one';
END $$;

-- 7. Re-applying 095's data moves changes nothing.
DO $$
DECLARE before INT; after INT;
BEGIN
    SELECT (SELECT count(*) FROM consent_documents) + (SELECT count(*) FROM provider_coverage)
         + (SELECT count(*) FROM provider_routes) + (SELECT count(*) FROM provider_credential_slots)
      INTO before;
    INSERT INTO provider_credential_slots (provider, name, label, description, env_var, in_use)
    VALUES ('kora', 'secret_key', 'x', 'x', 'KORA_SECRET_KEY', TRUE)
    ON CONFLICT (provider, name) DO NOTHING;
    INSERT INTO provider_coverage (provider, operation, currency, basis)
    VALUES ('kora', 'collect', 'GHS', 'Checkout with the mobile_money channel (Pay-ins Overview)')
    ON CONFLICT (provider, operation, currency) DO NOTHING;
    INSERT INTO consent_documents (kind, version, body_sha256, summary)
    SELECT 'privacy', '2026-10-04', '338f1d3783b6bf2b4b064f62562213731f596b1e889ee421c7fb68175a8f8739', 'x'
     WHERE NOT EXISTS (SELECT 1 FROM consent_documents
                        WHERE kind = 'privacy' AND retired_at IS NULL AND version > '2026-10-04')
    ON CONFLICT (kind, version) DO NOTHING;
    SELECT (SELECT count(*) FROM consent_documents) + (SELECT count(*) FROM provider_coverage)
         + (SELECT count(*) FROM provider_routes) + (SELECT count(*) FROM provider_credential_slots)
      INTO after;
    IF before <> after THEN RAISE EXCEPTION 'TEST FAILED 7: re-applying 095 wrote a row'; END IF;
    RAISE NOTICE 'PASS 7: 095 is idempotent';
END $$;
