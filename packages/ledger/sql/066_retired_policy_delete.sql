-- ===========================================================================
--  066 — deleting a RETIRED spread policy
--
--  064 did this for a published RATE and stopped there, which left the wrong
--  table tidy. An operator retires a SPREAD — that is the row with a Retire
--  button on it, and the one that accumulates every mistyped margin — and
--  retired rates mostly retire themselves, because the reference feed
--  republishes them.
--
--  SO THE DELETE WAS OFFERED ON THE TABLE NOBODY NEEDED IT ON.
--
--  WHY A RETIRED POLICY IS DIFFERENT FROM A RETIRED RATE, and it is the whole
--  reason this is a second migration rather than a copy of the first.
--
--  Nothing references `fx_published_rates` by key at all: a trade stores the
--  ratio it actually used, so a rate row records an OFFER and deleting one
--  loses an offer nobody took. A POLICY is referenced —
--  `fx_trades.spread_policy_id` is a foreign key — so a policy that priced a
--  real trade is part of that trade's record and cannot go.
--
--  THE FOREIGN KEY ALREADY REFUSES THAT, and it is left to do so rather than
--  re-checked here. A trigger counting trades before the constraint runs is a
--  second, weaker copy of the rule plus a race: a trade landing between the
--  count and the delete would pass the trigger and then hit the key anyway.
--  What this file adds is the half the key cannot know about — whether the
--  policy is still LIVE.
--
--  A LIVE POLICY STAYS UNDELETABLE. 008 refuses an unpublished pair rather
--  than quoting from a default, so deleting a live policy silently stops that
--  corridor: the next customer is told it cannot be converted, and nothing on
--  any screen says a row was removed. Retiring is a decision somebody takes
--  deliberately; this only removes something already retired.
--
--  UPDATE stays refused outright, by 008's own append-only trigger. Editing a
--  spread in place rewrites the price of every past quote, which is what that
--  rule exists for and none of this touches.
-- ===========================================================================

BEGIN;

CREATE OR REPLACE FUNCTION refuse_fx_policy_delete() RETURNS TRIGGER AS $$
BEGIN
    IF OLD.retired_at IS NULL THEN
        RAISE EXCEPTION
            'a LIVE spread policy cannot be deleted. Retire it first — '
            'deleting it would leave the corridor unpriced and every quote on '
            'it refused, with nothing on screen saying why.';
    END IF;
    RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS fx_spread_policies_no_live_delete ON fx_spread_policies;
CREATE TRIGGER fx_spread_policies_no_live_delete
    BEFORE DELETE ON fx_spread_policies
    FOR EACH ROW EXECUTE FUNCTION refuse_fx_policy_delete();

COMMIT;
