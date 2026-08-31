-- ============================================================================
--  038 — Tests: USDC cannot be held without a ceiling or a watcher.
--
--  The point of these is not that three rows were inserted. It is that the
--  two coverage views — the ones the invariant suite fails on — stay complete
--  once a USDC account exists, which is the state the migration was written
--  to get ahead of.
-- ============================================================================

\set ON_ERROR_STOP on

-- ---------------------------------------------------------------------------
-- 1. Every tier has a USDC ceiling, and tier 0's is zero.
-- ---------------------------------------------------------------------------
DO $$
DECLARE tiers INT; zero_at_0 BIGINT;
BEGIN
    SELECT count(*) INTO tiers FROM kyc_tier_limits WHERE currency = 'USDC';
    IF tiers <> 3 THEN
        RAISE EXCEPTION 'TEST FAILED 1a: expected 3 USDC tier limits, found %', tiers;
    END IF;

    SELECT daily_limit_minor INTO zero_at_0
      FROM kyc_tier_limits WHERE currency = 'USDC' AND tier = 0;
    -- Zero rather than absent. A missing row reads as undefined and means
    -- "uncapped by the tier"; this has to mean "may not move it at all".
    IF zero_at_0 <> 0 THEN
        RAISE EXCEPTION 'TEST FAILED 1b: an unverified account may move % USDC', zero_at_0;
    END IF;
    RAISE NOTICE 'PASS 1: USDC is capped at every tier, and at zero unverified';
END $$;

-- ---------------------------------------------------------------------------
-- 2. The exponent was not copied from a two-decimal currency.
--
-- The failure this guards is silent and large: USDC is six decimals, so a
-- figure lifted from the USD row would cap a customer at one dollar while
-- reading as ten thousand.
-- ---------------------------------------------------------------------------
DO $$
DECLARE usdc BIGINT; usdt BIGINT;
BEGIN
    SELECT daily_limit_minor INTO usdc FROM kyc_tier_limits WHERE currency='USDC' AND tier=1;
    SELECT daily_limit_minor INTO usdt FROM kyc_tier_limits WHERE currency='USDT' AND tier=1;
    IF usdc <> usdt THEN
        RAISE EXCEPTION 'TEST FAILED 2: USDC tier 1 is % and USDT is %; both are six-decimal '
                        'dollar stablecoins, so the same value is the same integer', usdc, usdt;
    END IF;
    RAISE NOTICE 'PASS 2: the USDC figures are at six decimals, like USDT';
END $$;

-- ---------------------------------------------------------------------------
-- 3. THE ONE THAT MATTERS: holding USDC leaves no coverage gap.
--
-- Creates a real USDC account, which is what drives both views, and asserts
-- neither reports a hole. Rolled back, so the suite leaves no account behind
-- for a later file to trip over.
-- ---------------------------------------------------------------------------
DO $$
DECLARE tier_gaps INT; risk_gaps INT;
BEGIN
    INSERT INTO accounts (owner_type, owner_id, kind, currency, normal_balance)
    VALUES ('platform', NULL, 'provider_float', 'USDC', 'debit')
    ON CONFLICT DO NOTHING;

    SELECT count(*) INTO tier_gaps
      FROM kyc_tier_coverage WHERE currency = 'USDC' AND NOT has_limit;
    IF tier_gaps > 0 THEN
        RAISE EXCEPTION 'TEST FAILED 3a: % tier/currency combinations for USDC have no '
                        'ceiling, so an account in it is uncapped', tier_gaps;
    END IF;

    SELECT count(*) INTO risk_gaps
      FROM risk_currency_coverage WHERE currency = 'USDC' AND NOT monitored;
    IF risk_gaps > 0 THEN
        RAISE EXCEPTION 'TEST FAILED 3b: USDC is held and not monitored';
    END IF;
    RAISE NOTICE 'PASS 3: a USDC account leaves neither coverage view with a gap';

    RAISE EXCEPTION 'rollback-please';
EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'rollback-please' THEN RAISE; END IF;
END $$;
