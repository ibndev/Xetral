-- ============================================================================
--  055 — the United Kingdom and Canada
--
--  WHAT THIS IS. Two more corridors, opened deliberately. 040's design is that
--  adding a country is free and OPENING one is a decision — a row goes in
--  CLOSED whatever it names, because defaulting to enabled would make an
--  INSERT into a reference table a licensing decision. This file makes that
--  decision explicitly for two countries, which is the only honest way to do
--  it.
--
--  THE COVERAGE COMES FIRST, and the ordering is the point rather than
--  tidiness: `countries_enable_needs_coverage` refuses to enable a country
--  whose currency has no daily ceiling at every tier and nothing watching it,
--  so a file that inserted the countries first would fail on its own trigger.
--  That is the correct failure and this is the correct order — the same
--  argument 040's seed makes, and 038's about USDC.
--
--  EVERY FIGURE IS A STARTING POINT AN OPERATOR MUST REVIEW. The sterling and
--  Canadian dollar numbers are the naira ones converted at a round rate and
--  rounded to something legible. They are NOT a compliance position: the
--  reporting threshold in each country is a regulator's number, and the FCA
--  and FINTRAC both have one.
--
--  AND OPENING A COUNTRY IS A LICENSING CLAIM. This file says the platform
--  operates there; whether it may is a question for somebody with a licence,
--  not for a migration. It is written down here so that is a decision on the
--  record rather than a side effect of a currency being added.
-- ============================================================================

BEGIN;

INSERT INTO kyc_tier_limits (tier, currency, daily_limit_minor) VALUES
  -- ---- GBP, exponent 2 (penny) ---------------------------------------------
  -- £30 unverified, roughly the naira tier-0 ceiling.
  (0, 'GBP', 3000),
  -- £3,000 verified.
  (1, 'GBP', 300000),
  -- £15,000 with source of funds established.
  (2, 'GBP', 1500000),

  -- ---- CAD, exponent 2 (cent) ----------------------------------------------
  (0, 'CAD', 5000),
  (1, 'CAD', 500000),
  (2, 'CAD', 2500000)
ON CONFLICT (tier, currency) DO NOTHING;

INSERT INTO risk_thresholds (currency, large_value_minor, notable_minor) VALUES
  -- £3,000 and £60. A STARTING POINT: the UK's own reporting threshold is the
  -- FCA's number, not this one.
  ('GBP', 300000, 6000),
  -- CA$5,000 and CA$100. Canada's is FINTRAC's.
  ('CAD', 500000, 10000)
ON CONFLICT (currency) DO NOTHING;

-- ---------------------------------------------------------------------------
--  The countries. GB already exists as a closed row from 040's seed, so this
--  opens it rather than inserting it; CA is new.
--
--  `payout_method` is `bank` for both — that is the conservative answer and
--  the true one, since neither runs on mobile money. `funding_methods` is
--  EMPTY, deliberately: Paystack issues dedicated accounts in Nigeria and
--  nowhere else, so a customer here can be PAID — by another customer, by a
--  payment link, in crypto — and cannot yet top up.
--  `countries_without_a_way_in` reports exactly that, which is what it is for.
-- ---------------------------------------------------------------------------
INSERT INTO countries (code, name, dial_code, currency, enabled, payout_method, funding_methods)
VALUES
  ('CA', 'Canada', '1', 'CAD', TRUE, 'bank', '{}')
ON CONFLICT (code) DO UPDATE
   SET name = EXCLUDED.name,
       dial_code = EXCLUDED.dial_code,
       currency = EXCLUDED.currency,
       enabled = EXCLUDED.enabled,
       payout_method = EXCLUDED.payout_method;

UPDATE countries
   SET enabled = TRUE, payout_method = 'bank', funding_methods = '{}'
 WHERE code = 'GB';

COMMIT;
