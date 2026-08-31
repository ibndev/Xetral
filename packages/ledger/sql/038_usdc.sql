-- ============================================================================
--  038 — USDC: the limits and thresholds it needs before it can be held.
--
--  WHY THIS IS A MIGRATION AND NOT A LINE IN THE REGISTRY. Adding a currency
--  to `packages/shared/src/money/currency.ts` gives it an exponent and a
--  symbol, which is everything the money primitives need and nothing the
--  CONTROLS need. Two coverage views are driven by
--  `SELECT DISTINCT currency FROM accounts`:
--
--    kyc_tier_coverage      every tier against every currency the ledger
--                           holds, and the invariant suite fails on a gap —
--                           because the alternative to a limit is a FALLBACK,
--                           and a fallback means an unlisted currency is
--                           silently uncapped.
--    risk_currency_coverage a currency the ledger holds and 027 does not
--                           watch, which the suite also fails on, because
--                           unmonitored has to be a visible state.
--
--  So the first USDC account to exist would turn both green suites red — and
--  in the window before somebody noticed, USDC would be the one asset with no
--  daily ceiling and no monitoring. The rows go in FIRST, which is the only
--  ordering where the gap never exists.
--
--  ZERO AT TIER 0, exactly as USDT and BTC are, and for the reason 029
--  records: on a chain is the one place money cannot be recalled from, so it
--  is the one movement that must never be available to an account nobody has
--  identified. Zero is a real limit here, not a missing row — `#tierLimit`
--  returns undefined for a missing row and 0 for this one, and collapsing the
--  two would turn a coverage gap into a customer who cannot move their own
--  money, indistinguishably.
--
--  THE FIGURES MIRROR USDT because both are dollar stablecoins with six
--  decimals, so the same dollar value is the same integer. That is a
--  coincidence of exponents rather than a rule, and it is written out
--  literally rather than copied by a SELECT so that changing one cannot
--  silently change the other.
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- What each tier may move in USDC per Lagos day.
-- ---------------------------------------------------------------------------
INSERT INTO kyc_tier_limits (tier, currency, daily_limit_minor) VALUES
  -- 0: registered, nothing verified. No crypto without an identity.
  (0, 'USDC', 0),
  -- 1: identity verified by a person. 10,000 USDC, at six decimals.
  (1, 'USDC', 10000000000),
  -- 2: source of funds established. 100,000 USDC.
  (2, 'USDC', 100000000000)
ON CONFLICT (tier, currency) DO NOTHING;

-- ---------------------------------------------------------------------------
-- What counts as large and what counts as worth looking at.
--
-- `large_value_minor` is a REGULATORY figure and this one is a starting point,
-- the same caveat 027's seed carries: it must be set to what the NFIU
-- currently requires, and a programme running on a number somebody copied from
-- a migration is a finding.
-- ---------------------------------------------------------------------------
INSERT INTO risk_thresholds (currency, large_value_minor, notable_minor) VALUES
  -- 10,000 USDC and 500 USDC. Six decimals, NOT two — a figure copied from
  -- the USD row would be off by ten thousand, which is the whole reason
  -- exponents are per currency.
  ('USDC', 10000000000, 500000000)
ON CONFLICT (currency) DO NOTHING;

COMMIT;
