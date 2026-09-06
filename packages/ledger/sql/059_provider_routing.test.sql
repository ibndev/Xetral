-- ===========================================================================
--  Xetral — invariants for 059_provider_routing.sql
--  Every block prints PASS. A TEST FAILED means a control is not wired up.
-- ===========================================================================

\set ON_ERROR_STOP on

-- ---------------------------------------------------------------------------
-- 1. THE SEEDED CORRIDORS ARE ROUTED, AND NAIRA DID NOT MOVE
--
-- The whole failure this migration exists for is that cedis had nowhere to go.
-- The whole risk of fixing it is moving naira, which was working. Both halves
-- are asserted, because a migration that fixed the broken corridor by breaking
-- the working one would look identical from the cedi side.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    ngn TEXT;
    ghs TEXT;
    kes TEXT;
BEGIN
    SELECT provider INTO ngn FROM provider_routes WHERE operation = 'collect' AND currency = 'NGN';
    SELECT provider INTO ghs FROM provider_routes WHERE operation = 'collect' AND currency = 'GHS';
    SELECT provider INTO kes FROM provider_routes WHERE operation = 'payout'  AND currency = 'KES';

    IF ngn IS DISTINCT FROM 'paystack' THEN
        RAISE EXCEPTION 'TEST FAILED 1: naira collection is routed to %, not paystack', ngn;
    END IF;
    IF ghs IS DISTINCT FROM 'flutterwave' THEN
        RAISE EXCEPTION 'TEST FAILED 1: cedi collection is routed to %, not flutterwave', ghs;
    END IF;
    IF kes IS DISTINCT FROM 'flutterwave' THEN
        RAISE EXCEPTION 'TEST FAILED 1: shilling payouts are routed to %, not flutterwave', kes;
    END IF;

    RAISE NOTICE 'PASS 1: naira stays on Paystack; cedis and shillings route to Flutterwave';
END $$;

-- ---------------------------------------------------------------------------
-- 2. AN OPERATION NOTHING DISPATCHES ON IS REFUSED
--
-- A row naming an operation no code reads is a route an operator believes is
-- in force. Free text here would let one be written and quietly do nothing.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
    BEGIN
        INSERT INTO provider_routes (operation, currency, provider)
        VALUES ('issue_card', 'NGN', 'bitnob');
        RAISE EXCEPTION 'TEST FAILED 2: an unknown operation was accepted';
    EXCEPTION WHEN check_violation THEN
        RAISE NOTICE 'PASS 2: only collect and payout can be routed';
    END;
END $$;

-- ---------------------------------------------------------------------------
-- 3. EVERY CHANGE IS RECORDED, BY TRIGGER, WITH WHAT IT WAS
--
-- Written on the TABLE rather than by the endpoint — 026's rule about the
-- credential rotation log: a write the endpoint performs is a write a psql
-- prompt skips, and the prompt is where somebody goes at three in the morning.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    seen INT;
    before_provider TEXT;
BEGIN
    INSERT INTO provider_routes (operation, currency, provider)
    VALUES ('collect', 'ZAR', 'paystack');

    UPDATE provider_routes SET provider = 'flutterwave'
     WHERE operation = 'collect' AND currency = 'ZAR';

    SELECT count(*) INTO seen FROM provider_route_history
     WHERE operation = 'collect' AND currency = 'ZAR';
    IF seen <> 2 THEN
        RAISE EXCEPTION 'TEST FAILED 3: expected 2 history rows, found %', seen;
    END IF;

    SELECT was INTO before_provider FROM provider_route_history
     WHERE operation = 'collect' AND currency = 'ZAR' AND now_is = 'flutterwave';
    IF before_provider IS DISTINCT FROM 'paystack' THEN
        RAISE EXCEPTION 'TEST FAILED 3: the history does not say what it was, it says %',
            COALESCE(before_provider, 'null');
    END IF;

    RAISE NOTICE 'PASS 3: a route change records what it was and what it became';
END $$;

-- ---------------------------------------------------------------------------
-- 4. A NO-OP UPDATE WRITES NO HISTORY
--
-- An operator saving a form without changing anything must not fill the trail
-- with rows saying nothing happened — a log people scroll past is a log nobody
-- reads, which is the lesson 015 records about alerting.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    seen INT;
BEGIN
    UPDATE provider_routes SET provider = 'flutterwave'
     WHERE operation = 'collect' AND currency = 'ZAR';

    SELECT count(*) INTO seen FROM provider_route_history
     WHERE operation = 'collect' AND currency = 'ZAR';
    IF seen <> 2 THEN
        RAISE EXCEPTION 'TEST FAILED 4: a no-op update wrote history; found % rows', seen;
    END IF;

    RAISE NOTICE 'PASS 4: saving an unchanged route records nothing';
END $$;

-- ---------------------------------------------------------------------------
-- 5. THE TRAIL CANNOT BE EDITED OR PRUNED
--
-- A log the person with access can rewrite answers "who pointed this at that"
-- with whatever they would like to have been true.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
    BEGIN
        UPDATE provider_route_history SET now_is = 'bitnob'
         WHERE operation = 'collect' AND currency = 'ZAR';
        RAISE EXCEPTION 'TEST FAILED 5: the route history was editable';
    EXCEPTION WHEN raise_exception THEN
        IF SQLERRM LIKE 'TEST FAILED%' THEN RAISE; END IF;
    END;

    BEGIN
        DELETE FROM provider_route_history
         WHERE operation = 'collect' AND currency = 'ZAR';
        RAISE EXCEPTION 'TEST FAILED 5: the route history was deletable';
    EXCEPTION WHEN raise_exception THEN
        IF SQLERRM LIKE 'TEST FAILED%' THEN RAISE; END IF;
    END;

    RAISE NOTICE 'PASS 5: the route history is append-only';
END $$;

-- ---------------------------------------------------------------------------
-- 6. COVERAGE REPORTS AN UNROUTED CORRIDOR
--
-- The state cedis were in before this migration: customers refused, nothing
-- erroring anywhere. It has to be a visible state, which is why this view
-- exists at all — the same shape as `retention_coverage` and
-- `attention_coverage`, and for the same reason.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    unrouted INT;
BEGIN
    /*
     * GBP, NOT AN INVENTED COUNTRY. 040 refuses to enable one for a currency
     * with no tier ceiling and nothing watching it — correctly, and that guard
     * firing here would be this test breaking a different invariant to prove
     * its own. Britain is open (055) and 059 deliberately routes neither of
     * its arms, which is the real state this view has to report.
     */
    SELECT count(*) INTO unrouted
      FROM provider_route_coverage
     WHERE currency = 'GBP' AND status = 'UNROUTED';

    IF unrouted <> 2 THEN
        RAISE EXCEPTION
            'TEST FAILED 6: expected both GBP operations unrouted, found %', unrouted;
    END IF;

    -- And routing one arm must remove exactly that arm from the report.
    INSERT INTO provider_routes (operation, currency, provider)
    VALUES ('collect', 'GBP', 'paystack')
    ON CONFLICT (operation, currency) DO UPDATE SET provider = EXCLUDED.provider;

    SELECT count(*) INTO unrouted
      FROM provider_route_coverage
     WHERE currency = 'GBP' AND status = 'UNROUTED';

    IF unrouted <> 1 THEN
        RAISE EXCEPTION
            'TEST FAILED 6: routing collection left % GBP arms unrouted, expected 1', unrouted;
    END IF;

    RAISE NOTICE 'PASS 6: a currency the platform is open in with no route is reported';
END $$;

-- ---------------------------------------------------------------------------
-- 7. A PAYMENT CANNOT CHANGE THE RAIL THAT TOOK IT
--
-- A provider-side reference is opaque and only its issuer can verify it, so a
-- row whose provider could change is a payment nothing can ever settle — the
-- exact state `bank_payouts_stuck` counts one flow over.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    uid BIGINT;
    lid BIGINT;
    pid BIGINT;
BEGIN
    INSERT INTO users (email, status) VALUES ('routing-1@xetral.test', 'active')
    RETURNING id INTO uid;
    SELECT id INTO lid FROM payment_links WHERE user_id = uid;

    INSERT INTO link_payments
      (reference, link_id, user_id, amount_minor, currency, payer_email, provider)
    VALUES ('xetpay-routing-1', lid, uid, 500000, 'GHS', 'payer@example.com', 'flutterwave')
    RETURNING id INTO pid;

    BEGIN
        UPDATE link_payments SET provider = 'paystack' WHERE id = pid;
        RAISE EXCEPTION 'TEST FAILED 7: a payment changed provider';
    EXCEPTION WHEN raise_exception THEN
        IF SQLERRM LIKE 'TEST FAILED%' THEN RAISE; END IF;
    END;

    RAISE NOTICE 'PASS 7: the rail that took a payment is immutable';
END $$;

-- ---------------------------------------------------------------------------
-- 8. THE CREDENTIAL SLOTS EXIST, AND THE HASH IS NOT THE KEY
--
-- Flutterwave verifies a webhook with a value an operator sets on ITS OWN
-- dashboard, not with the secret key — one slot would send them to paste the
-- wrong string and wonder why every event was refused.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    slots INT;
BEGIN
    SELECT count(*) INTO slots FROM provider_credential_slots
     WHERE provider = 'flutterwave' AND name IN ('secret_key', 'webhook_hash') AND in_use;

    IF slots <> 2 THEN
        RAISE EXCEPTION
            'TEST FAILED 8: expected both Flutterwave slots in use, found %', slots;
    END IF;

    RAISE NOTICE 'PASS 8: the key and the webhook hash are separate slots';
END $$;
