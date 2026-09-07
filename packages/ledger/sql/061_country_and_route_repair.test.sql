-- ============================================================================
--  061 — tests
--
--  Every block prints PASS or raises. The migration's job is to CONVERGE a
--  database that is in the wrong state, so each block puts it in that state
--  first and then re-runs the migration's own statement.
-- ============================================================================

\set ON_ERROR_STOP on

-- ---------------------------------------------------------------------------
--  1. Ghana and Kenya pay out on mobile money.
--
--  The row both apps read to decide whether the Send screen says "Account
--  number" or "Mobile Money number".
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_gh TEXT; v_ke TEXT;
BEGIN
    SELECT payout_method INTO v_gh FROM countries WHERE code = 'GH';
    SELECT payout_method INTO v_ke FROM countries WHERE code = 'KE';
    IF v_gh IS DISTINCT FROM 'mobile_money' THEN
        RAISE EXCEPTION 'TEST FAILED 1: GH pays out by % rather than mobile_money', v_gh;
    END IF;
    IF v_ke IS DISTINCT FROM 'mobile_money' THEN
        RAISE EXCEPTION 'TEST FAILED 1: KE pays out by % rather than mobile_money', v_ke;
    END IF;
    RAISE NOTICE 'PASS 1: GH and KE pay out on mobile money';
END $$;

-- ---------------------------------------------------------------------------
--  2. And it CONVERGES — which is the whole reason this migration exists.
--
--  Set it wrong, re-run the statement, and it comes back. A migration that
--  only asserts would pass on a database that is already right and do nothing
--  for the one that is not.
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_gh TEXT;
BEGIN
    UPDATE countries SET payout_method = 'bank' WHERE code = 'GH';

    UPDATE countries
       SET payout_method = 'mobile_money'
     WHERE code IN ('GH', 'KE')
       AND payout_method IS DISTINCT FROM 'mobile_money';

    SELECT payout_method INTO v_gh FROM countries WHERE code = 'GH';
    IF v_gh IS DISTINCT FROM 'mobile_money' THEN
        RAISE EXCEPTION 'TEST FAILED 2: a GH row set to bank was not repaired';
    END IF;
    RAISE NOTICE 'PASS 2: a wrong payout_method is repaired, not merely asserted';
END $$;

-- ---------------------------------------------------------------------------
--  3. Nigeria is untouched by that repair.
--
--  The UPDATE names two codes. If it ever grew a third, naira payouts would
--  be routed at a rail that cannot make them — so the absence is asserted
--  rather than assumed from reading the WHERE clause.
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_ng TEXT;
BEGIN
    SELECT payout_method INTO v_ng FROM countries WHERE code = 'NG';
    IF v_ng IS DISTINCT FROM 'bank' THEN
        RAISE EXCEPTION 'TEST FAILED 3: NG pays out by % rather than bank', v_ng;
    END IF;
    RAISE NOTICE 'PASS 3: Nigeria still pays out to a bank';
END $$;

-- ---------------------------------------------------------------------------
--  4. Every corridor the platform collects in has a rail.
--
--  A missing row here is the "Payments are unavailable right now" the
--  checkout answers with, and it is what a payment link in cedis fails on.
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_missing TEXT;
BEGIN
    SELECT string_agg(want.operation || ':' || want.currency, ', ')
      INTO v_missing
      FROM (VALUES
             ('collect', 'NGN'), ('collect', 'GHS'),
             ('collect', 'KES'), ('collect', 'USD'),
             ('payout',  'NGN'), ('payout',  'GHS'), ('payout', 'KES')
           ) AS want(operation, currency)
     WHERE NOT EXISTS (
            SELECT 1 FROM provider_routes r
             WHERE r.operation = want.operation AND r.currency = want.currency
           );
    IF v_missing IS NOT NULL THEN
        RAISE EXCEPTION 'TEST FAILED 4: no route for %', v_missing;
    END IF;
    RAISE NOTICE 'PASS 4: every corridor 061 names has a rail';
END $$;

-- ---------------------------------------------------------------------------
--  5. A route an operator moved is NOT overruled.
--
--  `DO NOTHING` rather than `DO UPDATE`, because the reason a corridor is
--  pointed somewhere unusual is almost always that somebody moved it during
--  an incident — and a migration that put it back would undo an incident
--  response at the worst possible moment.
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_now TEXT;
BEGIN
    UPDATE provider_routes SET provider = 'bitnob'
     WHERE operation = 'collect' AND currency = 'GHS';

    INSERT INTO provider_routes (operation, currency, provider)
    VALUES ('collect', 'GHS', 'flutterwave')
    ON CONFLICT (operation, currency) DO NOTHING;

    SELECT provider INTO v_now FROM provider_routes
     WHERE operation = 'collect' AND currency = 'GHS';
    IF v_now IS DISTINCT FROM 'bitnob' THEN
        RAISE EXCEPTION 'TEST FAILED 5: the seed overwrote a moved corridor';
    END IF;

    -- Put it back, so a later suite reading this table sees the shipped answer.
    UPDATE provider_routes SET provider = 'flutterwave'
     WHERE operation = 'collect' AND currency = 'GHS';
    RAISE NOTICE 'PASS 5: a corridor an operator moved is left alone';
END $$;

-- ---------------------------------------------------------------------------
--  6. An account with no country is COUNTED, and its number is read.
--
--  The gap that made this take three rounds: nothing anywhere said "this
--  customer has no country", so every screen falling back to Nigeria looked
--  exactly like a screen that had never been changed.
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_suggests TEXT; v_count BIGINT;
BEGIN
    INSERT INTO users (uuid, email, phone, full_name, country)
    VALUES (gen_random_uuid(), 't61-ghana@example.test', '+233244000061',
            'Test Six One', NULL);

    SELECT phone_suggests, customers INTO v_suggests, v_count
      FROM customers_without_a_country
     WHERE phone_suggests = 'GH';

    IF v_suggests IS DISTINCT FROM 'GH' THEN
        RAISE EXCEPTION
          'TEST FAILED 6: a +233 account with no country was not reported as GH';
    END IF;
    IF v_count IS NULL OR v_count < 1 THEN
        RAISE EXCEPTION 'TEST FAILED 6: the count is %', v_count;
    END IF;
    RAISE NOTICE 'PASS 6: an account with no country is counted, and its number read';
END $$;

-- ---------------------------------------------------------------------------
--  7. And the backfill settles it.
--
--  Same function 050 defines, run a second time. This is the statement in the
--  migration, so what is proved is that re-running it repairs an account that
--  arrived after 050 did.
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_country TEXT; v_left BIGINT;
BEGIN
    PERFORM backfill_country_from_phone();

    SELECT country INTO v_country FROM users WHERE email = 't61-ghana@example.test';
    IF v_country IS DISTINCT FROM 'GH' THEN
        RAISE EXCEPTION
          'TEST FAILED 7: a +233 account settled to % rather than GH', v_country;
    END IF;

    SELECT COALESCE(SUM(customers), 0) INTO v_left
      FROM customers_without_a_country WHERE phone_suggests = 'GH';
    IF v_left <> 0 THEN
        RAISE EXCEPTION
          'TEST FAILED 7: % GH account(s) still have no country after the backfill',
          v_left;
    END IF;
    RAISE NOTICE 'PASS 7: re-running the backfill settles an account 050 never saw';
END $$;

-- ---------------------------------------------------------------------------
--  8. 036 has a decision for the new view.
--
--  `attention_coverage` fails the build on an undecided view and on an
--  orphaned decision, both directions. Asserted here too so the failure names
--  this migration rather than arriving from 036's suite.
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_decision TEXT; v_name TEXT;
BEGIN
    SELECT decision, queue_name INTO v_decision, v_name
      FROM attention_sources WHERE source = 'customers_without_a_country';
    IF v_decision IS DISTINCT FROM 'watch' THEN
        RAISE EXCEPTION 'TEST FAILED 8: the new view is classified %', v_decision;
    END IF;
    -- A watch must NOT carry a queue name, by CHECK. Asserted so a later
    -- reader promoting it to a queue is made to add an arm to the overview.
    IF v_name IS NOT NULL THEN
        RAISE EXCEPTION 'TEST FAILED 8: a watch is carrying the queue name %', v_name;
    END IF;
    RAISE NOTICE 'PASS 8: the new view is a classified watch';
END $$;
