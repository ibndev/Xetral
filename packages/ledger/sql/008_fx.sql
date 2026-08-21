-- ===========================================================================
--  Xetral — Phase 10: Multi-currency and FX / remittance
--  packages/ledger/sql/008_fx.sql
--
--  THIS PHASE ADDS A FLOW, NOT A MIGRATION.
--
--  The ledger has been multi-currency since Phase 1: `fx_trade` is in
--  `entry_kind`, `revenue_fx_spread` is in `account_kind`, and the balance
--  invariant is enforced PER CURRENCY rather than per entry. That last one is
--  what makes an FX entry safe, and it was written for exactly this:
--
--    NGN legs:  wallet -X,  provider_float +X',  revenue_fx_spread +(X - X')
--    USD legs:  provider_float -Y,  wallet +Y
--
--  Each currency sums to zero on its own. A whole-entry check would add kobo
--  to cents and let two independent errors cancel — which is finding 1 of
--  Phase 1, and this is the flow it was guarding against.
--
--  HOW A RATE IS REPRESENTED, AND WHY NOT A DECIMAL
--  -------------------------------------------------
--  A rate is a RATIO between two minor-unit amounts, stored as an integer
--  numerator and denominator:
--
--      quote_minor = round(base_minor * numerator / denominator)
--
--  Not a decimal, and not "minor units per major unit". The latter works for
--  USD -> NGN (1 USD = 165,025 kobo) and collapses for NGN -> USD, where one
--  kobo is 0.0006 cents and any per-major integer rounds to zero. A ratio is
--  exact in both directions and makes the rounding a decision at the point of
--  conversion rather than a property lost in storage.
-- ===========================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. WHAT WE CHARGE OVER THE MARKET
--
-- The spread is OUR margin, expressed in basis points, and it is a published
-- price like a gift card rate card: append-only, so a quote given months ago
-- can still be reproduced during a dispute. Editing one in place would
-- silently rewrite the price of every past trade.
-- ---------------------------------------------------------------------------

CREATE TABLE fx_spread_policies (
    id                  BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    uuid                UUID        NOT NULL DEFAULT gen_random_uuid(),

    base_currency       TEXT        NOT NULL,
    quote_currency      TEXT        NOT NULL,

    -- BASIS POINTS as an integer (150 = 1.5%), never a decimal. Same rule as
    -- the transfer fee: a decimal margin is a float in disguise, and this one
    -- multiplies every conversion.
    spread_basis_points INT         NOT NULL
                        CHECK (spread_basis_points >= 0 AND spread_basis_points <= 10000),

    -- Below this, a conversion is refused rather than quoted. Not a fee: FX on
    -- a trivial amount rounds to nothing for the customer and still costs a
    -- provider call, and quoting it invites a customer to convert ₦5 and
    -- receive zero.
    min_base_minor      BIGINT      NOT NULL DEFAULT 1 CHECK (min_base_minor > 0),

    effective_from      TIMESTAMPTZ NOT NULL DEFAULT now(),
    retired_at          TIMESTAMPTZ NULL,
    created_by          BIGINT      NULL REFERENCES users(id),

    CONSTRAINT fx_spread_policies_uuid_key UNIQUE (uuid),
    CONSTRAINT fx_pair_is_not_identity CHECK (base_currency <> quote_currency)
);

CREATE UNIQUE INDEX fx_spread_policies_live
    ON fx_spread_policies (base_currency, quote_currency) WHERE (retired_at IS NULL);

-- Published prices are never edited. Retire and republish.
CREATE OR REPLACE FUNCTION assert_fx_policy_append_only() RETURNS TRIGGER AS $$
BEGIN
    IF NEW.base_currency       IS DISTINCT FROM OLD.base_currency
       OR NEW.quote_currency      IS DISTINCT FROM OLD.quote_currency
       OR NEW.spread_basis_points IS DISTINCT FROM OLD.spread_basis_points
       OR NEW.min_base_minor      IS DISTINCT FROM OLD.min_base_minor THEN
        RAISE EXCEPTION 'fx policy % is published; retire it and publish a new one', OLD.id
            USING ERRCODE = 'check_violation';
    END IF;

    IF OLD.retired_at IS NOT NULL AND NEW.retired_at IS DISTINCT FROM OLD.retired_at THEN
        RAISE EXCEPTION 'fx policy % is already retired', OLD.id
            USING ERRCODE = 'check_violation';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER fx_spread_policies_append_only
    BEFORE UPDATE ON fx_spread_policies
    FOR EACH ROW EXECUTE FUNCTION assert_fx_policy_append_only();

-- ---------------------------------------------------------------------------
-- 2. WHAT ACTUALLY HAPPENED
--
-- One row per executed conversion. Records BOTH rates — the one the provider
-- gave us and the one the customer got — because the difference is our
-- revenue, and a trade that cannot show where its margin came from cannot be
-- audited.
--
-- A trade is atomic and final. There is no `reserved` state, because unlike a
-- purchase there is no provider to wait for: the money moves between two
-- accounts we already control, in one journal entry, or it does not move.
-- ---------------------------------------------------------------------------

CREATE TABLE fx_trades (
    id                  BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    uuid                UUID        NOT NULL DEFAULT gen_random_uuid(),
    user_id             BIGINT      NOT NULL REFERENCES users(id),

    reference           TEXT        NOT NULL,
    idempotency_key     TEXT        NOT NULL,

    -- What the customer gave up.
    base_currency       TEXT        NOT NULL,
    base_minor          BIGINT      NOT NULL CHECK (base_minor > 0),
    -- What they received.
    quote_currency      TEXT        NOT NULL,
    quote_minor         BIGINT      NOT NULL CHECK (quote_minor > 0),

    -- The rate the CUSTOMER got, as the ratio actually applied. Stored rather
    -- than recomputed so a statement months later shows the number they were
    -- shown, not the number today's policy would produce.
    rate_numerator      BIGINT      NOT NULL CHECK (rate_numerator > 0),
    rate_denominator    BIGINT      NOT NULL CHECK (rate_denominator > 0),

    -- Our margin, in the BASE currency, and the policy it came from.
    spread_minor        BIGINT      NOT NULL CHECK (spread_minor >= 0),
    spread_policy_id    BIGINT      NOT NULL REFERENCES fx_spread_policies(id),

    /**
     * Set when this is a remittance: the wallet that received the quote
     * currency belongs to somebody else. NULL means the customer converted
     * between their own wallets.
     */
    recipient_user_id   BIGINT      NULL REFERENCES users(id),

    entry_id            BIGINT      NOT NULL REFERENCES journal_entries(id),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT fx_trades_uuid_key      UNIQUE (uuid),
    CONSTRAINT fx_trades_reference_key UNIQUE (reference),
    -- A customer key is unique PER CUSTOMER. Two customers will send the same
    -- one; a client counting from one is enough.
    CONSTRAINT fx_trades_user_key      UNIQUE (user_id, idempotency_key),

    CONSTRAINT fx_trade_is_not_identity CHECK (base_currency <> quote_currency),
    -- Sending to yourself is a conversion, not a remittance, and modelling it
    -- as one would make the two indistinguishable in reporting.
    CONSTRAINT remittance_is_to_somebody_else CHECK (
        recipient_user_id IS NULL OR recipient_user_id <> user_id
    )
);

CREATE INDEX fx_trades_user      ON fx_trades (user_id, created_at DESC);
CREATE INDEX fx_trades_recipient ON fx_trades (recipient_user_id, created_at DESC)
    WHERE recipient_user_id IS NOT NULL;

-- A trade is a record of an entry that has already been written. Nothing about
-- it can change afterwards without the two disagreeing, and the ledger is the
-- one that is right.
CREATE OR REPLACE FUNCTION assert_fx_trade_immutable() RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'fx trade % records a completed entry; it is immutable', OLD.id
        USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER fx_trades_immutable
    BEFORE UPDATE ON fx_trades
    FOR EACH ROW EXECUTE FUNCTION assert_fx_trade_immutable();

-- What we have earned on spread, by currency and day. The counterpart to the
-- ledger's own drift view: reporting reads this, reconciliation reads the
-- postings, and the two must agree.
CREATE OR REPLACE VIEW fx_spread_earned AS
SELECT t.base_currency AS currency,
       date_trunc('day', t.created_at) AS day,
       COUNT(*) AS trades,
       SUM(t.spread_minor) AS spread_minor
  FROM fx_trades t
 GROUP BY t.base_currency, date_trunc('day', t.created_at)
 ORDER BY day DESC, currency;

COMMIT;
