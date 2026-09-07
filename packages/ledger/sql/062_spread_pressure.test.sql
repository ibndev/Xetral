-- ============================================================================
--  062 — tests
--
--  Every block prints PASS or raises. The numbers here are the SAME ones
--  `spread.test.ts` asserts against `widenedSpread()`, deliberately: the view
--  repeats that arithmetic because a view cannot call a TypeScript function,
--  and two copies of a pricing rule that nobody compares are two prices.
-- ============================================================================

\set ON_ERROR_STOP on

-- ---------------------------------------------------------------------------
--  Fixtures. A corridor nothing else in the suite uses, so the assertions here
--  cannot be moved by another file's rows.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
    /*
     * CAD→GBP, A CORRIDOR NO OTHER SUITE TOUCHES.
     *
     * The first version of this used USD/NGN and read 175 basis points rather
     * than the 150 it had just tried to insert: 008's suite publishes that
     * pair, `ON CONFLICT DO NOTHING` left the existing row alone, and every
     * assertion below was then measured against somebody else's price. These
     * files share one database and run in file order — the lesson the e2e
     * suites record about pinning what an assertion depends on.
     */
    INSERT INTO fx_spread_policies
      (base_currency, quote_currency, spread_basis_points, min_base_minor)
    VALUES ('CAD', 'GBP', 150, 100)
    ON CONFLICT DO NOTHING;

    INSERT INTO fx_published_rates
      (base_currency, quote_currency, numerator, denominator, quote_per_base)
    VALUES ('CAD', 'GBP', 1650000, 100, '1650.000000')
    ON CONFLICT DO NOTHING;
    RAISE NOTICE 'seeded CAD/GBP at 1650.000000 with a 150bp base';
END $$;

-- ---------------------------------------------------------------------------
--  1. No observation is not a move.
--
--  The feed's key expires and nothing errors — the rows stay and the screen
--  renders. Reading a missing figure as a move would widen every corridor on
--  exactly that day.
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_adverse INT; v_effective INT; v_observed TEXT; v_age BIGINT;
BEGIN
    DELETE FROM fx_rate_observations WHERE base_currency = 'CAD' AND quote_currency = 'GBP';

    SELECT adverse_basis_points, effective_basis_points, observed_rate, observation_age_seconds
      INTO v_adverse, v_effective, v_observed, v_age
      FROM fx_spread_pressure
     WHERE base_currency = 'CAD' AND quote_currency = 'GBP';

    IF v_adverse <> 0 THEN
        RAISE EXCEPTION 'TEST FAILED 1: no observation reported % basis points of move', v_adverse;
    END IF;
    -- The effective spread IS the base, which is the truthful answer: with
    -- nothing to compare against, the price is the one an operator published.
    IF v_effective <> 150 THEN
        RAISE EXCEPTION 'TEST FAILED 1: an unobserved pair quoted % rather than its base',
              v_effective;
    END IF;
    /*
     * AND "NEVER OBSERVED" IS TOLD APART FROM "OBSERVED, UNMOVED" — by the
     * rate and the age being NULL, not by the basis points, which are zero in
     * both. Collapsing the two would make a dead feed look like a calm market,
     * which is 057's whole point about the failure nothing else can see.
     */
    IF v_observed IS NOT NULL OR v_age IS NOT NULL THEN
        RAISE EXCEPTION 'TEST FAILED 1: an unobserved pair reported a reading';
    END IF;
    RAISE NOTICE 'PASS 1: no observation quotes the base, and says it has no reading';
END $$;

-- ---------------------------------------------------------------------------
--  2. The payout currency STRENGTHENING widens, roughly one for one.
--
--  USD→NGN pays out naira. The naira strengthening means fewer naira per
--  dollar, so the published rate FALLS: 1650 → 1633.50 is one percent, and
--  one percent is a hundred basis points on top of the base.
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_adverse INT; v_effective INT;
BEGIN
    INSERT INTO fx_rate_observations (base_currency, quote_currency, quote_per_base)
    VALUES ('CAD', 'GBP', '1633.500000')
    ON CONFLICT (base_currency, quote_currency)
    DO UPDATE SET quote_per_base = EXCLUDED.quote_per_base, observed_at = now();

    SELECT adverse_basis_points, effective_basis_points
      INTO v_adverse, v_effective
      FROM fx_spread_pressure
     WHERE base_currency = 'CAD' AND quote_currency = 'GBP';

    IF v_adverse <> 100 THEN
        RAISE EXCEPTION 'TEST FAILED 2: a 1%% move read as % basis points', v_adverse;
    END IF;
    IF v_effective <> 250 THEN
        RAISE EXCEPTION 'TEST FAILED 2: 150bp base + 100bp move gave %', v_effective;
    END IF;
    RAISE NOTICE 'PASS 2: the payout currency strengthening 1%% adds 100 basis points';
END $$;

-- ---------------------------------------------------------------------------
--  3. The payout currency WEAKENING does nothing at all.
--
--  Charging a customer less than the price an operator published is a pricing
--  decision. The quote is simply better than it needed to be.
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_adverse INT; v_effective INT;
BEGIN
    UPDATE fx_rate_observations SET quote_per_base = '1700.000000', observed_at = now()
     WHERE base_currency = 'CAD' AND quote_currency = 'GBP';

    SELECT adverse_basis_points, effective_basis_points
      INTO v_adverse, v_effective
      FROM fx_spread_pressure
     WHERE base_currency = 'CAD' AND quote_currency = 'GBP';

    IF v_adverse <> 0 THEN
        RAISE EXCEPTION 'TEST FAILED 3: a weakening payout currency read as % adverse', v_adverse;
    END IF;
    IF v_effective <> 150 THEN
        RAISE EXCEPTION 'TEST FAILED 3: the spread moved to % on a favourable rate', v_effective;
    END IF;
    RAISE NOTICE 'PASS 3: a weakening payout currency leaves the base spread alone';
END $$;

-- ---------------------------------------------------------------------------
--  4. Never more than DOUBLE THE BASE.
--
--  A ten percent move against a 150bp base wants 1150bp. Double the base is
--  300, and it is the lower of the two ceilings here.
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_effective INT;
BEGIN
    UPDATE fx_rate_observations SET quote_per_base = '1485.000000', observed_at = now()
     WHERE base_currency = 'CAD' AND quote_currency = 'GBP';

    SELECT effective_basis_points INTO v_effective
      FROM fx_spread_pressure
     WHERE base_currency = 'CAD' AND quote_currency = 'GBP';

    IF v_effective <> 300 THEN
        RAISE EXCEPTION 'TEST FAILED 4: a 10%% move gave % rather than double the base', v_effective;
    END IF;
    RAISE NOTICE 'PASS 4: a widened spread never exceeds double the base';
END $$;

-- ---------------------------------------------------------------------------
--  5. And never more than the HARD CEILING, which is the lower one here.
--
--  Base 500 doubles to 1000, so the 600bp ceiling binds instead. Both limits
--  exist because they bind in different places.
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_effective INT;
BEGIN
    /*
     * RETIRE AND REPUBLISH, because 035 makes a policy append-only — an UPDATE
     * here is refused, which is the schema doing its job. Changing a price is
     * two acts, and that is what keeps every past quote reproducible.
     */
    UPDATE fx_spread_policies SET retired_at = now()
     WHERE base_currency = 'CAD' AND quote_currency = 'GBP' AND retired_at IS NULL;
    INSERT INTO fx_spread_policies
      (base_currency, quote_currency, spread_basis_points, min_base_minor)
    VALUES ('CAD', 'GBP', 500, 100);

    SELECT effective_basis_points INTO v_effective
      FROM fx_spread_pressure
     WHERE base_currency = 'CAD' AND quote_currency = 'GBP';

    IF v_effective <> 600 THEN
        RAISE EXCEPTION 'TEST FAILED 5: the hard ceiling gave % rather than 600', v_effective;
    END IF;

    UPDATE fx_spread_policies SET retired_at = now()
     WHERE base_currency = 'CAD' AND quote_currency = 'GBP' AND retired_at IS NULL;
    INSERT INTO fx_spread_policies
      (base_currency, quote_currency, spread_basis_points, min_base_minor)
    VALUES ('CAD', 'GBP', 150, 100);
    RAISE NOTICE 'PASS 5: the LOWER of the two ceilings is what binds';
END $$;

-- ---------------------------------------------------------------------------
--  6. An observation must be a rate at six places.
--
--  The CHECK is what makes "comparable as text" structural rather than a
--  convention the writer keeps — 057's argument about a varying width making
--  1650.1 and 1650.100000 look like a price change.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
    BEGIN
        INSERT INTO fx_rate_observations (base_currency, quote_currency, quote_per_base)
        VALUES ('CAD', 'GHS', '15.5');
        RAISE EXCEPTION 'TEST FAILED 6: a rate at one decimal place was accepted';
    EXCEPTION WHEN check_violation THEN
        NULL;
    END;

    BEGIN
        INSERT INTO fx_rate_observations (base_currency, quote_currency, quote_per_base)
        VALUES ('CAD', 'CAD', '1.000000');
        RAISE EXCEPTION 'TEST FAILED 6: a currency was observed against itself';
    EXCEPTION WHEN check_violation THEN
        NULL;
    END;
    RAISE NOTICE 'PASS 6: an observation must be a six-place rate between two currencies';
END $$;

-- ---------------------------------------------------------------------------
--  7. It ships OFF.
--
--  Turning it on changes what customers are quoted, which is a pricing
--  decision — the same argument 032 makes about the transfer levy.
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_on TEXT; v_ceiling TEXT;
BEGIN
    SELECT value INTO v_on FROM platform_settings WHERE key = 'fx_auto_spread_enabled';
    SELECT value INTO v_ceiling
      FROM platform_settings WHERE key = 'fx_auto_spread_ceiling_basis_points';

    IF v_on IS DISTINCT FROM 'false' THEN
        RAISE EXCEPTION 'TEST FAILED 7: automatic widening ships as %', v_on;
    END IF;
    IF v_ceiling IS NULL THEN
        RAISE EXCEPTION 'TEST FAILED 7: no ceiling is seeded';
    END IF;
    RAISE NOTICE 'PASS 7: the mechanism ships complete and switched off';
END $$;

-- ---------------------------------------------------------------------------
--  8. The ceiling is BOUNDED BY THE DATABASE, not by the form.
--
--  009's argument: a bound typed into a screen holds until somebody uses psql
--  at three in the morning.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
    BEGIN
        UPDATE platform_settings SET value = '5000'
         WHERE key = 'fx_auto_spread_ceiling_basis_points';
        RAISE EXCEPTION 'TEST FAILED 8: a 50%% ceiling was accepted';
    EXCEPTION WHEN raise_exception OR check_violation OR data_exception THEN
        IF SQLERRM LIKE 'TEST FAILED%' THEN RAISE; END IF;
    END;
    RAISE NOTICE 'PASS 8: the ceiling cannot be set past ten percent';
END $$;

-- ---------------------------------------------------------------------------
--  9. Both coverage checks have a decision for what this adds.
--
--  036 refuses an unclassified view and 019 refuses an undecided table, both
--  directions. Asserted here so the failure names this migration.
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_view TEXT; v_table TEXT;
BEGIN
    SELECT decision INTO v_view
      FROM attention_sources WHERE source = 'fx_spread_pressure';
    SELECT decision INTO v_table
      FROM retention_decisions WHERE table_name = 'fx_rate_observations';

    IF v_view IS DISTINCT FROM 'watch' THEN
        RAISE EXCEPTION 'TEST FAILED 9: the pressure view is classified %', v_view;
    END IF;
    IF v_table IS DISTINCT FROM 'purge' THEN
        RAISE EXCEPTION 'TEST FAILED 9: the observation table is decided %', v_table;
    END IF;
    RAISE NOTICE 'PASS 9: the new view and table both carry a decision';
END $$;
