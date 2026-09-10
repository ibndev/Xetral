-- ===========================================================================
--  064 — deleting a RETIRED published rate
--
--  WHY THIS IS ALLOWED AT ALL, given 053 says a published rate is never
--  deleted.
--
--  That rule was written to protect one thing: the ability to check a quote
--  somebody was given last month against the number that was live when it
--  happened. It turns out a rate row is NOT what carries that. `fx_trades`
--  stores `applied_numerator` and `applied_denominator` — the ratio actually
--  used — so a trade is self-describing about its own price and nothing
--  references `fx_published_rates` by key at all. The row records what was
--  OFFERED, not what any transaction used.
--
--  So the cost of deleting a retired one is losing an offer nobody took, and
--  the cost of refusing is a prices screen that accumulates every mistyped
--  rate for ever with no way to tidy it. An operator who publishes 16500
--  where they meant 1650 retires it immediately and then looks at it for the
--  life of the deployment.
--
--  A LIVE RATE STAYS UNDELETABLE, and that is the half that matters. Deleting
--  one silently unprices a corridor: 053's own reader refuses an unpublished
--  pair rather than quoting a default, so the next customer on that corridor
--  is told it cannot be converted, and nothing on the screen says a row was
--  removed. Retiring is a decision an operator takes deliberately; this only
--  removes something already retired.
--
--  UPDATE stays refused outright. Editing a rate in place is the thing 053
--  exists to prevent and none of the above touches it.
-- ===========================================================================

CREATE OR REPLACE FUNCTION refuse_fx_rate_delete() RETURNS TRIGGER AS $$
BEGIN
    IF OLD.retired_at IS NULL THEN
        RAISE EXCEPTION
            'a LIVE published rate cannot be deleted. Retire it first — '
            'deleting it would leave the corridor unpriced and every quote on '
            'it refused, with nothing on screen saying why.';
    END IF;
    RETURN OLD;
END;
$$ LANGUAGE plpgsql;

-- The trigger itself is unchanged and still BEFORE DELETE; only what it
-- permits has moved. Restated here so a database that has 053 and not this
-- file ends up in the same place as one applied in order.
DROP TRIGGER IF EXISTS fx_published_rates_no_delete ON fx_published_rates;
CREATE TRIGGER fx_published_rates_no_delete
    BEFORE DELETE ON fx_published_rates
    FOR EACH ROW EXECUTE FUNCTION refuse_fx_rate_delete();


-- ---------------------------------------------------------------------------
--  AND DELETING ONE MUST SAY WHY.
--
--  009's list is the actions that take something away, and 035 put
--  `price.retire` on it because retiring looks like tidying and is not. This
--  is the same action with nothing to undo it: a retired rate can be
--  republished, a deleted one cannot be recovered from anything this
--  application holds. Enforced by CHECK rather than only by the handler, for
--  the reason every other bound here is a CHECK — a rule that lives in one
--  code path holds until the first script that skips it.
-- ---------------------------------------------------------------------------
ALTER TABLE admin_audit_log DROP CONSTRAINT IF EXISTS destructive_actions_say_why;
ALTER TABLE admin_audit_log ADD CONSTRAINT destructive_actions_say_why CHECK (
    action NOT IN ('user.freeze', 'user.close', 'deposit.return', 'giftcard.clawback',
                   'data.erase', 'price.retire', 'recovery.reverse', 'price.delete')
    OR reason IS NOT NULL
);


-- ---------------------------------------------------------------------------
--  AND THE SCREEN HAS TO BE ABLE TO SEE ONE.
--
--  `published_fx_rates` filtered to `retired_at IS NULL`, so a retired rate
--  was invisible on the prices screen and there was nothing to put a button
--  on. Retired rows come back the way the FX spreads table already shows
--  them — LAST, so a live price is never below a dead one — and the column
--  is what the screen greys the row out by.
--
--  A LIVE ROW IS STILL EXACTLY ONE PER DIRECTION. The unique index says so and
--  nothing here changes it; this only stops the READ hiding history from the
--  one screen that can act on it.
-- ---------------------------------------------------------------------------
-- DROPPED AND RECREATED, not replaced: `CREATE OR REPLACE VIEW` can only
-- APPEND columns, and this inserts `retired_at` in the middle where it reads
-- beside `effective_from`. Postgres refuses that as a rename, which is the
-- right refusal and the wrong thing to work around by putting the column last.
DROP VIEW IF EXISTS published_fx_rates;
CREATE VIEW published_fx_rates AS
SELECT r.uuid,
       r.base_currency,
       r.quote_currency,
       r.numerator::text   AS numerator,
       r.denominator::text AS denominator,
       r.quote_per_base,
       r.effective_from,
       r.retired_at,
       p.spread_basis_points,
       u.email AS created_by,
       r.source,
       EXTRACT(epoch FROM now() - r.effective_from)::bigint AS age_seconds
  FROM fx_published_rates r
  LEFT JOIN fx_spread_policies p
    ON p.base_currency = r.base_currency
   AND p.quote_currency = r.quote_currency
   AND p.retired_at IS NULL
  LEFT JOIN users u ON u.id = r.created_by
 ORDER BY r.retired_at IS NOT NULL, r.base_currency, r.quote_currency;
