-- ============================================================================
--  053 — the rate itself, set by us
--
--  WHAT WAS MISSING. `fx_spread_policies` publishes a MARGIN and a minimum,
--  and it is the only FX thing an operator can set. The RATE has always come
--  from `FxPort.rate()` — from Bitnob — so the admin surface could say "take
--  1.5% on NGN→GHS" and had no way at all to say what a cedi is worth.
--
--  For NGN→USD that is right: there is a market and a provider quoting it, and
--  a rate we typed would drift from the one the swap actually executes at.
--  FOR NGN→GHS THERE IS NO SUCH PROVIDER. Bitnob does not quote it, so the
--  pair could be given a spread, appear published, and refuse every customer
--  — which is the state this platform is in today for exactly the corridor it
--  was built for.
--
--  SO A PUBLISHED RATE MAKES US THE COUNTERPARTY, and that is a decision
--  rather than a detail. Where a rate exists here, Xetral is quoting its own
--  price and settling the swap out of its own float in both currencies —
--  there is no provider to ask and none to execute against. Where one does
--  not, nothing changes and the provider is asked exactly as before.
--
--  A RATIO OF INTEGERS, never a decimal, and never "minor units per major
--  unit". Phase 10 records why: per-major works for USD→NGN and collapses for
--  NGN→USD, where one kobo is 0.0006 cents and any per-major integer rounds
--  to zero. The operator types a decimal on the form and the service turns it
--  into this ratio in one place, the way `fromMajor()` takes a string.
--
--  EACH DIRECTION IS ITS OWN ROW, the rule 035 already states for spreads. A
--  rate is a ratio and NGN→GHS says nothing about GHS→NGN; an operator who
--  publishes one and forgets the other learns it from `published_fx_rates`
--  rather than from a customer.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS fx_published_rates (
    id              BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    uuid            UUID        NOT NULL DEFAULT gen_random_uuid(),

    base_currency   TEXT        NOT NULL,
    quote_currency  TEXT        NOT NULL,

    -- quoteMinor = baseMinor * numerator / denominator. Both positive, both
    -- BIGINT: a rate is a ratio of integers and this is the one place it is
    -- stored, so there is nowhere for a float to get in.
    numerator       BIGINT      NOT NULL CHECK (numerator > 0),
    denominator     BIGINT      NOT NULL CHECK (denominator > 0),

    -- What the operator actually typed, kept verbatim for the screen: "1 USD
    -- = 1650.00 NGN" is what they can check, and recomputing it from the
    -- ratio for display would be a second piece of arithmetic that can
    -- disagree with the first. It is NOT read by any conversion.
    quote_per_base  TEXT        NOT NULL CHECK (quote_per_base ~ '^[0-9]+(\.[0-9]+)?$'),

    effective_from  TIMESTAMPTZ NOT NULL DEFAULT now(),
    retired_at      TIMESTAMPTZ NULL,
    created_by      BIGINT      NULL REFERENCES users(id),

    CONSTRAINT fx_published_rates_uuid_key UNIQUE (uuid),
    CONSTRAINT fx_published_rate_is_not_identity CHECK (base_currency <> quote_currency)
);

-- One LIVE rate per direction. Two would make `ORDER BY ... LIMIT 1` the thing
-- resolving an ambiguity, which is 035's argument about overlapping gift card
-- bands: a LIMIT 1 settling a question the schema should have refused.
CREATE UNIQUE INDEX IF NOT EXISTS fx_published_rates_live
    ON fx_published_rates (base_currency, quote_currency) WHERE (retired_at IS NULL);

-- ---------------------------------------------------------------------------
--  APPEND-ONLY, the rule 007's rate cards and 035's prices both follow.
--
--  Editing a rate in place rewrites the price of every past quote. Retire and
--  republish, so a trade months old can still be checked against the number
--  that was live when it happened.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION assert_fx_rate_append_only() RETURNS TRIGGER AS $$
BEGIN
    IF NEW.base_currency  IS DISTINCT FROM OLD.base_currency
       OR NEW.quote_currency IS DISTINCT FROM OLD.quote_currency
       OR NEW.numerator      IS DISTINCT FROM OLD.numerator
       OR NEW.denominator    IS DISTINCT FROM OLD.denominator
       OR NEW.quote_per_base IS DISTINCT FROM OLD.quote_per_base
       OR NEW.effective_from IS DISTINCT FROM OLD.effective_from THEN
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

DROP TRIGGER IF EXISTS fx_published_rates_append_only ON fx_published_rates;
CREATE TRIGGER fx_published_rates_append_only
    BEFORE UPDATE ON fx_published_rates
    FOR EACH ROW EXECUTE FUNCTION assert_fx_rate_append_only();

CREATE OR REPLACE FUNCTION refuse_fx_rate_delete() RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'a published rate is never deleted. Retire it.';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS fx_published_rates_no_delete ON fx_published_rates;
CREATE TRIGGER fx_published_rates_no_delete
    BEFORE DELETE ON fx_published_rates
    FOR EACH ROW EXECUTE FUNCTION refuse_fx_rate_delete();

-- ---------------------------------------------------------------------------
--  What is quotable right now, and what is only half-published.
--
--  A pair needs BOTH a spread policy and — where we are the counterparty — a
--  rate. `published_fx_rates` is what the admin screen lists; the LEFT JOIN is
--  what makes a spread with no rate visible as such rather than as a pair
--  that simply refuses when a customer tries it.
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
       u.email AS created_by
  FROM fx_published_rates r
  LEFT JOIN fx_spread_policies p
         ON p.base_currency = r.base_currency
        AND p.quote_currency = r.quote_currency
        AND p.retired_at IS NULL
  LEFT JOIN users u ON u.id = r.created_by
 WHERE r.retired_at IS NULL
 ORDER BY r.base_currency, r.quote_currency;

-- ---------------------------------------------------------------------------
--  A SPREAD WITH NO RATE, which is the state that refuses customers silently.
--
--  It is not necessarily wrong — for a pair a provider quotes, the rate comes
--  from them and there is nothing to publish here. It IS wrong for a corridor
--  nobody quotes, and only a person can tell the two apart, so this reports
--  rather than refuses.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW fx_pairs_priced_without_a_rate AS
SELECT p.base_currency, p.quote_currency, p.spread_basis_points
  FROM fx_spread_policies p
  LEFT JOIN fx_published_rates r
         ON r.base_currency = p.base_currency
        AND r.quote_currency = p.quote_currency
        AND r.retired_at IS NULL
 WHERE p.retired_at IS NULL AND r.id IS NULL;

COMMENT ON VIEW fx_pairs_priced_without_a_rate IS
  'Pairs with a margin and no rate of our own. Correct where a provider quotes '
  'the pair and wrong where none does — and the second refuses every customer '
  'with nothing on any screen saying why, which is why it is listed.';

-- 036 refuses a view nobody has classified, in both directions. This one is
-- `internal`: it is what the admin screen renders, not something anybody
-- works through, and a rationale is required precisely so `internal` cannot
-- be the cheap answer for a view that does need working.
INSERT INTO attention_sources (source, decision, queue_name, rationale)
VALUES ('published_fx_rates', 'internal', NULL,
        'What the prices screen lists. A reference read on demand rather than '
        'a queue: nothing here is waiting on anybody.')
ON CONFLICT (source) DO UPDATE
   SET decision = EXCLUDED.decision,
       queue_name = EXCLUDED.queue_name,
       rationale = EXCLUDED.rationale;

INSERT INTO attention_sources (source, decision, queue_name, rationale)
VALUES ('fx_pairs_priced_without_a_rate', 'watch', NULL,
        'A pair with a spread and no rate of ours. Fine where a provider '
        'quotes it; where none does it refuses every customer silently.')
ON CONFLICT (source) DO UPDATE
   SET decision = EXCLUDED.decision,
       queue_name = EXCLUDED.queue_name,
       rationale = EXCLUDED.rationale;

INSERT INTO retention_decisions (table_name, decision, rationale)
VALUES ('fx_published_rates', 'keep',
        'A price we published. Every trade quoted against it must remain '
        'checkable, which is the same reason gift card rate cards are kept.')
ON CONFLICT (table_name) DO UPDATE
   SET decision = EXCLUDED.decision,
       rationale = EXCLUDED.rationale;

COMMIT;
