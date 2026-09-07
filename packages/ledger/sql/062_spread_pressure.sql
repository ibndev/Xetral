-- ============================================================================
--  062 — the spread that widens when the payout currency strengthens
--
--  WHAT WAS WRONG. `fx_spread_policies` holds a margin an operator published
--  and `fx_published_rates` holds the rate we quote at. Both are append-only
--  and neither moves on its own, so between the moment a rate is published and
--  the moment somebody republishes it the market can move — and every quote
--  struck in that gap uses the old number. In one direction that costs
--  nothing. In the other it comes out of margin, on every transaction, until a
--  person notices; and nothing anywhere was watching for it.
--
--  THE EXPOSURE IS ALWAYS ON THE CURRENCY BEING PAID OUT. On USD→NGN we hand
--  over naira, so naira getting more expensive costs us. On NGN→USD we hand
--  over dollars, so DOLLARS getting more expensive costs us — the opposite
--  statement about the naira. That is why this cannot be a rule about any one
--  currency, and it is per pair by construction: expressed as the published
--  rate, both cases are the SAME FALL in `quote_per_base`, because the payout
--  currency strengthening means fewer of it per unit of the other.
--
--  WHAT THIS MIGRATION ADDS is only the DATA the decision needs. The arithmetic
--  is `widenedSpread()` in `@xetral/shared`, one place, with its rounding
--  stated — the same shape as `splitInclusiveTax()`, and for the same reason.
--
--  WHY AN OBSERVATION TABLE RATHER THAN READING THE PUBLISHED RATE TWICE. 057
--  keeps the feed's rates in `fx_published_rates` itself, distinguished by
--  `source` — so where the feed is running, the live rate IS current and there
--  is no gap to measure. The gap only exists where the feed did NOT
--  republish: a rate a person published (never overwritten, by design), or a
--  base the feed could not fetch. In exactly those cases the market's own
--  number is recorded nowhere, which is why it is recorded here.
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
--  What the market last said, whether or not we acted on it.
--
--  ONE ROW PER DIRECTION, overwritten in place — and that is the one table in
--  this schema which is deliberately NOT append-only. It is not a price and
--  nothing quotes from it: it is the latest reading of an instrument, and a
--  history of readings is a different feature with a different retention
--  answer. `fx_published_rates` remains the record of what anybody was ever
--  charged.
--
--  `observed_at` is what makes a stale reading visible. A feed that stops
--  answering leaves these rows exactly as they were, which would otherwise be
--  indistinguishable from a market that has not moved — the failure 057
--  records as the one nothing else can see.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS fx_rate_observations (
    base_currency  TEXT        NOT NULL,
    quote_currency TEXT        NOT NULL,

    /**
     * A decimal string at a FIXED six places, the same form 057 stores and for
     * the same reason: it is what makes two readings comparable as TEXT, and
     * comparing is what decides whether anything happened at all. TEXT rather
     * than NUMERIC so no reader is tempted to do arithmetic in the database on
     * a value the application handles as scaled integers.
     */
    quote_per_base TEXT        NOT NULL
        CHECK (quote_per_base ~ '^[0-9]+\.[0-9]{6}$'),

    observed_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT fx_rate_observations_pkey PRIMARY KEY (base_currency, quote_currency),
    CONSTRAINT fx_observation_is_a_pair CHECK (base_currency <> quote_currency)
);

COMMENT ON TABLE fx_rate_observations IS
  'The reference feed''s latest reading per direction, recorded on every sync '
  'whether or not it republished. Not a price: nothing quotes from this table. '
  'It is the baseline `widenedSpread()` measures a published rate against.';

-- ---------------------------------------------------------------------------
--  The two settings, and both are bounded by CHECK rather than by a form.
--
--  009's argument: a bound typed into a screen is a bound that holds until
--  somebody uses psql at three in the morning. The ceiling is capped at 1000
--  basis points — ten percent — because this mechanism exists to protect a
--  margin during a gap, and a spread wider than that is not a price anybody
--  would accept; during a genuine spike the right answer is an operator
--  looking at it, not an ever-widening automatic quote.
--
--  IT SHIPS OFF. Turning it on CHANGES WHAT EVERY CUSTOMER IS CHARGED on the
--  affected corridors, which is a pricing decision — the same argument 032
--  makes about the transfer levy, whose machinery ships complete and whose
--  decision does not ship at all.
-- ---------------------------------------------------------------------------
INSERT INTO platform_settings
  (key, value, value_type, min_value, max_value, label, description, category, sensitive)
VALUES
  ('fx_auto_spread_enabled', 'false', 'boolean', NULL, NULL,
   'Widen a spread when the payout currency strengthens',
   'ON widens an FX spread automatically when the payout currency has '
   'strengthened since that pair''s rate was last published, roughly one for '
   'one with the move. It ships OFF because turning it on CHANGES WHAT '
   'CUSTOMERS ARE QUOTED on the affected corridors, which is a pricing '
   'decision. It never narrows a spread and never exceeds the ceiling below.',
   'fees', TRUE),

  ('fx_auto_spread_ceiling_basis_points', '600', 'integer', 0, 1000,
   'Ceiling on a widened spread (basis points)',
   'The hard ceiling on an automatically widened spread. The effective figure '
   'is the LOWER of this and double the published base, so a thinly priced '
   'corridor stays comparatively thin. Capped at 1000 — during a genuine spike '
   'the right answer is an operator looking at it, not an ever-widening quote.',
   'fees', TRUE)
ON CONFLICT (key) DO NOTHING;

-- ---------------------------------------------------------------------------
--  WHAT AN OPERATOR CAN SEE, which is the half that stops this being a silent
--  change to a price.
--
--  A mechanism that quietly charges more than the published number is exactly
--  the kind of thing this codebase keeps recording as a fault — a control
--  nothing reads, a queue nobody sees. So every corridor under pressure is
--  listed with the published spread, the effective one and how far the rate
--  has moved, and the prices screen renders it.
--
--  The arithmetic is REPEATED here rather than shared with the application,
--  and that is a deliberate cost: a view cannot call a TypeScript function,
--  and `spread-pressure.test.ts` asserts the two agree on the same inputs so
--  the copy cannot drift silently. The alternative — the screen asking the
--  application what it would quote, pair by pair — is a page that makes
--  fifty-six calls to render a table.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW fx_spread_pressure AS
SELECT p.base_currency,
       p.quote_currency,
       p.spread_basis_points                          AS base_basis_points,
       r.quote_per_base                               AS published_rate,
       o.quote_per_base                               AS observed_rate,
       o.observed_at,
       EXTRACT(EPOCH FROM (now() - o.observed_at))::bigint AS observation_age_seconds,

       -- How far the payout currency has strengthened, in basis points. A
       -- rate at or above the published one is the other direction and reads
       -- as zero — this widens, it never narrows.
       GREATEST(
         0,
         FLOOR(
           (r.quote_per_base::numeric - o.quote_per_base::numeric)
           * 10000 / NULLIF(r.quote_per_base::numeric, 0)
         )
       )::int                                         AS adverse_basis_points,

       LEAST(
         p.spread_basis_points + GREATEST(
           0,
           FLOOR(
             (r.quote_per_base::numeric - o.quote_per_base::numeric)
             * 10000 / NULLIF(r.quote_per_base::numeric, 0)
           )
         )::int,
         p.spread_basis_points * 2,
         (SELECT value::int FROM platform_settings
           WHERE key = 'fx_auto_spread_ceiling_basis_points')
       )                                              AS effective_basis_points
  FROM fx_spread_policies p
  JOIN fx_published_rates r
    ON r.base_currency = p.base_currency
   AND r.quote_currency = p.quote_currency
   AND r.retired_at IS NULL
  LEFT JOIN fx_rate_observations o
    ON o.base_currency = p.base_currency
   AND o.quote_currency = p.quote_currency
 WHERE p.retired_at IS NULL
 ORDER BY p.base_currency, p.quote_currency;

COMMENT ON VIEW fx_spread_pressure IS
  'Every live corridor against the market, with the spread it is actually '
  'quoted at. A row whose effective figure exceeds its base is one the '
  'automatic widening is acting on right now.';

-- ---------------------------------------------------------------------------
--  036 classifies EVERY view, both directions, and fails the build on one
--  nobody decided about.
--
--  A `watch`: it is a number an operator reads to understand a price, not a
--  queue with items to work through. The action it might prompt — republish
--  that pair — is the ordinary Publish an exchange rate button.
-- ---------------------------------------------------------------------------
INSERT INTO attention_sources (source, decision, rationale)
VALUES
  ('fx_spread_pressure', 'watch',
   'Corridors whose published rate has fallen behind the market, with the '
   'spread each is actually being quoted at. A widened one is a pair overdue '
   'for a republish.')
ON CONFLICT (source) DO NOTHING;

-- ---------------------------------------------------------------------------
--  019 refuses a table with no retention decision, in both directions.
--
--  `purge`: one row per direction, overwritten in place, holding a public
--  market number and no personal data at all. There is nothing here to keep
--  for five years and nothing to erase on request — an observation for a
--  corridor nobody quotes any more is simply noise.
-- ---------------------------------------------------------------------------
INSERT INTO retention_decisions (table_name, decision, rationale)
VALUES
  ('fx_rate_observations', 'purge',
   'A public market reading per corridor, overwritten in place and holding no '
   'personal data. Nothing here is evidence and nothing is erasable.')
ON CONFLICT (table_name) DO NOTHING;

COMMIT;
