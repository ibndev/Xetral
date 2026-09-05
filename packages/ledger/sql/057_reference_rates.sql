-- ============================================================================
--  057 — a rate that arrives on its own
--
--  WHAT WAS WRONG: 053 gave an operator a form to type a rate into, and that
--  is the whole mechanism. A rate is a number that moves every day, in every
--  corridor, and the platform now names eight fiat currencies across five
--  countries — so "publish a rate" is fifty-six numbers somebody has to
--  retype, for ever, or the corridors quote yesterday's price. A price nobody
--  can keep current is a price that is wrong most of the time, and the failure
--  is silent: the quote succeeds, at the wrong number.
--
--  SO A RATE MAY NOW COME FROM A REFERENCE FEED, and `source` is what says
--  which. That column is the whole migration: everything else — append-only,
--  one live rate per direction, the ratio of integers — is 053's and unchanged.
--
--  A FEED RATE IS STILL OUR PRICE, not the feed's. It goes through the same
--  table, carries the same spread on top, and is retired and republished the
--  same way, so a trade quoted last month is still checkable against what was
--  live. What the feed removes is the retyping, not the decision: an operator
--  who wants to quote something other than the market publishes their own,
--  and a hand-published rate is never overwritten by the feed.
--
--  IT IS A REFERENCE, NOT A DEALABLE PRICE, and the difference matters where
--  we are the counterparty. What the feed says a cedi is worth is what the
--  market said it was worth at some point in the last day; the spread on top
--  is what covers the gap between that and what we can actually settle at.
-- ============================================================================

BEGIN;

ALTER TABLE fx_published_rates
    ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'operator'
        CHECK (source IN ('operator', 'reference_feed'));

COMMENT ON COLUMN fx_published_rates.source IS
  'Who set this rate. `operator` is a person at the prices screen; '
  '`reference_feed` is the sync worker. The feed never replaces an operator''s '
  'rate — a deliberate price outranks a market one.';

-- ---------------------------------------------------------------------------
--  APPEND-ONLY, EXTENDED TO THE NEW COLUMN.
--
--  053's trigger names every field it protects, so a column added afterwards
--  is silently editable — and this is the one that says whether a person chose
--  the number. An UPDATE relabelling a feed rate as an operator's would make
--  `prices_without_an_author` and the screen both describe a decision nobody
--  took.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION assert_fx_rate_append_only() RETURNS TRIGGER AS $$
BEGIN
    IF NEW.base_currency  IS DISTINCT FROM OLD.base_currency
       OR NEW.quote_currency IS DISTINCT FROM OLD.quote_currency
       OR NEW.numerator      IS DISTINCT FROM OLD.numerator
       OR NEW.denominator    IS DISTINCT FROM OLD.denominator
       OR NEW.quote_per_base IS DISTINCT FROM OLD.quote_per_base
       OR NEW.effective_from IS DISTINCT FROM OLD.effective_from
       OR NEW.source         IS DISTINCT FROM OLD.source THEN
        RAISE EXCEPTION
            'a published rate cannot be edited. Retire it and publish another, '
            'so every past quote can still be checked against what was live.';
    END IF;

    IF OLD.retired_at IS NOT NULL AND NEW.retired_at IS DISTINCT FROM OLD.retired_at THEN
        RAISE EXCEPTION 'a retired rate stays retired';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
--  THE SCREEN SAYS WHERE A RATE CAME FROM.
--
--  `CREATE OR REPLACE VIEW` may only APPEND columns, and this one appends
--  `source` and `age`. Both are for the same question an operator has looking
--  at a price: did somebody choose this, and when.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW published_fx_rates AS
SELECT r.uuid,
       r.base_currency,
       r.quote_currency,
       r.numerator::text  AS numerator,
       r.denominator::text AS denominator,
       r.quote_per_base,
       r.effective_from,
       p.spread_basis_points,
       u.email AS created_by,
       r.source,
       -- Whole seconds. A rate's AGE is the thing that goes wrong when a feed
       -- stops: the number on screen stays plausible for ever.
       EXTRACT(EPOCH FROM (now() - r.effective_from))::bigint AS age_seconds
  FROM fx_published_rates r
  LEFT JOIN fx_spread_policies p
         ON p.base_currency = r.base_currency
        AND p.quote_currency = r.quote_currency
        AND p.retired_at IS NULL
  LEFT JOIN users u ON u.id = r.created_by
 WHERE r.retired_at IS NULL
 ORDER BY r.base_currency, r.quote_currency;

-- ---------------------------------------------------------------------------
--  A PRICE NOBODY CHOSE IS STILL WORTH SEEING — but a feed rate is not one.
--
--  035's view exists to find rows written at a psql prompt, which have no
--  author because nobody recorded one. A feed rate also has no author, and
--  saying so would fill that list with fifty-six entries a day until nobody
--  reads it — the lesson 015 records about an alert people learn to ignore.
--  It is EXCLUDED BY ITS SOURCE rather than by its author, so a rate written
--  at a prompt still appears.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW prices_without_an_author AS
  SELECT 'fx_spread'::TEXT AS kind,
         uuid,
         base_currency || '/' || quote_currency AS subject,
         effective_from
    FROM fx_spread_policies
   WHERE retired_at IS NULL AND created_by IS NULL
UNION ALL
  SELECT 'fx_rate',
         uuid,
         base_currency || '/' || quote_currency,
         effective_from
    FROM fx_published_rates
   WHERE retired_at IS NULL AND created_by IS NULL AND source <> 'reference_feed'
UNION ALL
  SELECT 'giftcard_rate',
         uuid,
         brand || ' ' || country || ' ' || card_type,
         effective_from
    FROM giftcard_rate_cards
   WHERE retired_at IS NULL AND created_by IS NULL
 ORDER BY effective_from;

-- ---------------------------------------------------------------------------
--  A FEED THAT HAS STOPPED LOOKS EXACTLY LIKE A QUIET MARKET.
--
--  This is the failure the whole feature introduces. Every automatic price is
--  a price nobody is looking at, so when the key expires, the quota runs out
--  or the worker interval is unset on the one instance that had it, NOTHING
--  ERRORS: the rows stay, the screen renders, and customers are quoted a rate
--  from whenever it last worked. The same silent shape as
--  `NOTIFICATION_INTERVAL_SECONDS` unset, which 036 and the go-live list both
--  exist because of.
--
--  Two days, not one: the free tier refreshes daily, so a one-day threshold
--  would fire every time a sync ran an hour late — and an alert people learn
--  to ignore is worse than none.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW stale_reference_rates AS
SELECT base_currency,
       quote_currency,
       quote_per_base,
       effective_from,
       EXTRACT(EPOCH FROM (now() - effective_from))::bigint AS age_seconds
  FROM fx_published_rates
 WHERE retired_at IS NULL
   AND source = 'reference_feed'
   AND effective_from < now() - interval '2 days'
 ORDER BY effective_from;

COMMENT ON VIEW stale_reference_rates IS
  'Automatic rates that have stopped being refreshed. Nothing else notices: '
  'the rows stay, the screen renders, and customers are quoted whatever the '
  'feed last said before it stopped.';

INSERT INTO attention_sources (source, decision, queue_name, rationale)
VALUES ('stale_reference_rates', 'watch', NULL,
        'A rate feed that has stopped. Nothing errors when it does — customers '
        'are simply quoted an old price, which looks exactly like a quiet market.')
ON CONFLICT (source) DO UPDATE
   SET decision = EXCLUDED.decision,
       queue_name = EXCLUDED.queue_name,
       rationale = EXCLUDED.rationale;

-- ---------------------------------------------------------------------------
--  THE CREDENTIAL, in the store rather than only in the environment.
--
--  026's order: the database is authoritative and the environment is the
--  fallback, so an operator can paste a key without a deploy. Which matters
--  here for a specific reason — the free tier has a request quota, and the
--  answer to exhausting one is a new key today rather than a release.
-- ---------------------------------------------------------------------------
INSERT INTO provider_credential_slots
  (provider, name, label, description, env_var, in_use)
VALUES
  ('exchangerate', 'api_key', 'ExchangeRate-API key',
   'What keeps every FX corridor priced. Without it the sync worker does '
   'nothing and says so, and rates stay at whatever was last published by '
   'hand — which is not an error anywhere, just an old number quoted to '
   'customers. Free-tier keys refresh once a day and have a request quota.',
   'EXCHANGERATE_API_KEY', TRUE)
ON CONFLICT (provider, name) DO UPDATE
   SET label       = EXCLUDED.label,
       description = EXCLUDED.description,
       env_var     = EXCLUDED.env_var,
       in_use      = EXCLUDED.in_use;

COMMIT;
