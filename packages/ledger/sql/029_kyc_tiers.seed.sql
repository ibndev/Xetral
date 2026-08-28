-- ============================================================================
--  029 seed — the limits grid.
--
--  THESE FIGURES MUST BE REVIEWED BY THE OPERATOR. They are a defensible
--  starting point and not regulatory advice: the CBN publishes limits for its
--  own KYC tiers and revises them, and a platform running on numbers somebody
--  copied from a migration is running on numbers nobody reviewed.
--
--  The shape is what matters and is worth reading as a grid:
--
--    * an UNVERIFIED account may move a little naira and NO crypto at all.
--      Zero is a real limit here, not a missing row — an account nobody has
--      identified must not be able to put value on a chain, because that is
--      the one movement that cannot be undone.
--    * a VERIFIED account gets the ceiling that used to apply to everybody.
--    * an ENHANCED account gets a higher one, because somebody established
--      where the money comes from and wrote down why.
-- ============================================================================

BEGIN;

INSERT INTO kyc_tier_limits (tier, currency, daily_limit_minor) VALUES
  -- ---- 0: registered, nothing verified -------------------------------------
  -- ₦50,000 a day. Enough to be a usable wallet while somebody's documents are
  -- being read, and far below anything worth the trouble of stealing.
  (0, 'NGN',  5000000),
  (0, 'USD',  0),
  -- No crypto without an identity. On a chain is the one place money cannot be
  -- recalled from, so it is the one movement that must never be available to
  -- an account nobody has identified.
  (0, 'USDT', 0),
  (0, 'BTC',  0),

  -- ---- 1: identity verified by a person ------------------------------------
  -- ₦5,000,000 — the ceiling that used to apply to every customer including
  -- the unverified ones.
  (1, 'NGN',  500000000),
  (1, 'USD',  1000000),
  (1, 'USDT', 10000000000),
  (1, 'BTC',  25000000),

  -- ---- 2: source of funds established --------------------------------------
  (2, 'NGN',  5000000000),
  (2, 'USD',  10000000),
  (2, 'USDT', 100000000000),
  (2, 'BTC',  250000000)
ON CONFLICT (tier, currency) DO NOTHING;

COMMIT;
