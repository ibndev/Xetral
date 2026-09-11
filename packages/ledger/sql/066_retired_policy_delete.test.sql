-- ===========================================================================
--  066 invariants — deleting a retired spread policy
-- ===========================================================================
\set ON_ERROR_STOP on
BEGIN;

-- ---------------------------------------------------------------------------
--  1 — a LIVE policy cannot be deleted
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_id BIGINT;
BEGIN
    INSERT INTO fx_spread_policies (base_currency, quote_currency, spread_basis_points, min_base_minor)
    VALUES ('NGN', 'GHS', 150, 100000)
    RETURNING id INTO v_id;

    BEGIN
        DELETE FROM fx_spread_policies WHERE id = v_id;
        RAISE EXCEPTION 'TEST FAILED: a live spread policy was deleted, which '
                        'unprices the corridor with nothing saying so';
    EXCEPTION WHEN raise_exception THEN
        IF SQLERRM LIKE 'TEST FAILED%' THEN RAISE; END IF;
        RAISE NOTICE 'PASS 1: a live spread policy cannot be deleted';
    END;
END $$;

-- ---------------------------------------------------------------------------
--  2 — a RETIRED policy that priced nothing CAN be deleted
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_id BIGINT; v_left INT;
BEGIN
    INSERT INTO fx_spread_policies (base_currency, quote_currency, spread_basis_points, min_base_minor, retired_at)
    VALUES ('NGN', 'KES', 150, 100000, now())
    RETURNING id INTO v_id;

    DELETE FROM fx_spread_policies WHERE id = v_id;
    SELECT count(*) INTO v_left FROM fx_spread_policies WHERE id = v_id;
    IF v_left <> 0 THEN
        RAISE EXCEPTION 'TEST FAILED: a retired policy nobody traded on could not '
                        'be removed, so the screen accumulates every mistyped '
                        'margin for ever';
    END IF;
    RAISE NOTICE 'PASS 2: a retired policy that priced nothing can be deleted';
END $$;

-- ---------------------------------------------------------------------------
--  3 — a RETIRED policy that PRICED A TRADE cannot be deleted, and the
--      FOREIGN KEY is what refuses it
--
--  Deliberately not re-checked by a trigger: a count before the constraint is
--  a second, weaker copy of the rule plus a race, because a trade landing
--  between the count and the delete would pass the trigger and hit the key
--  anyway.
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_policy BIGINT; v_entry BIGINT; v_user BIGINT;
BEGIN
    INSERT INTO users (email, phone, status, country, full_name)
    VALUES ('p66@example.ng', '+2348066000001', 'active', 'NG', 'Policy Trader')
    RETURNING id INTO v_user;

    INSERT INTO fx_spread_policies (base_currency, quote_currency, spread_basis_points, min_base_minor, retired_at)
    VALUES ('USD', 'NGN', 150, 100, now())
    RETURNING id INTO v_policy;

    INSERT INTO journal_entries (kind, idempotency_key, occurred_at)
    VALUES ('fx_trade', 'p66:trade-1', now())
    RETURNING id INTO v_entry;

    INSERT INTO fx_trades
      (user_id, entry_id, reference, idempotency_key,
       base_currency, base_minor, quote_currency, quote_minor,
       rate_numerator, rate_denominator, spread_minor, spread_policy_id)
    VALUES (v_user, v_entry, 'p66-ref-1', 'p66:key-1',
            'USD', 10000, 'NGN', 16500000, 1650, 1, 150, v_policy);

    BEGIN
        DELETE FROM fx_spread_policies WHERE id = v_policy;
        RAISE EXCEPTION 'TEST FAILED: a policy that priced a real trade was '
                        'deleted, so that trade no longer names what it was '
                        'priced under';
    EXCEPTION WHEN foreign_key_violation THEN
        RAISE NOTICE 'PASS 3: a policy a trade points at is refused by the key';
    END;
END $$;

ROLLBACK;
