-- ===========================================================================
--  Xetral — Phase 5: Virtual USD cards
--  packages/ledger/sql/003_cards.sql
--
--  The card itself lives at Bitnob. This schema holds only what we must know
--  to route a webhook to the right customer and to answer "what cards does
--  this person have" without asking a provider — never the PAN, never the CVV.
-- ===========================================================================

-- Returning a terminated card's balance to the wallet is its own business
-- event: it is not a refund from a merchant and not an adjustment somebody
-- typed in. Added outside the transaction below because a new enum value
-- cannot be USED in the transaction that adds it.
ALTER TYPE entry_kind ADD VALUE IF NOT EXISTS 'card_termination';

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. PROVIDER CUSTOMERS
--
-- Bitnob issues cards to ITS customers, not to ours, so every user who holds a
-- card has an identity on the provider's side. Kept in its own table rather
-- than a column on `users` because a second card issuer would mean a second
-- id, and a `bitnob_customer_id` column is exactly the provider detail that
-- Rule 3 keeps out of the rest of the system.
-- ---------------------------------------------------------------------------
CREATE TABLE provider_customers (
    user_id              BIGINT      NOT NULL REFERENCES users(id),
    provider             TEXT        NOT NULL,
    provider_customer_id TEXT        NOT NULL,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),

    PRIMARY KEY (user_id, provider),

    -- One provider identity belongs to one user. Without this, a webhook
    -- naming a customer could route money to whichever row was read first.
    CONSTRAINT provider_customers_unique UNIQUE (provider, provider_customer_id)
);

-- ---------------------------------------------------------------------------
-- 2. CARDS
--
-- `pending` exists because issuing is not instantaneous: Bitnob accepts the
-- request and the card becomes usable later. A card that is not yet active
-- must not be presented to the customer as if it were.
-- ---------------------------------------------------------------------------
CREATE TYPE card_status AS ENUM ('pending', 'active', 'frozen', 'terminated');

CREATE TABLE cards (
    id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    uuid             UUID        NOT NULL DEFAULT gen_random_uuid(),
    user_id          BIGINT      NOT NULL REFERENCES users(id),

    provider         TEXT        NOT NULL DEFAULT 'bitnob',
    provider_card_id TEXT        NOT NULL,

    currency         TEXT        NOT NULL DEFAULT 'USD',

    -- The last four digits, and NOTHING else from the card number. The PAN,
    -- the CVV and the expiry-plus-PAN pair are all things a database dump must
    -- not contain; a CHECK keeps "just four digits" from drifting into "the
    -- whole number" the first time somebody is in a hurry.
    last4            TEXT        NULL CHECK (last4 IS NULL OR last4 ~ '^[0-9]{4}$'),
    expiry_month     INT         NULL CHECK (expiry_month IS NULL OR expiry_month BETWEEN 1 AND 12),
    expiry_year      INT         NULL CHECK (expiry_year IS NULL OR expiry_year BETWEEN 2000 AND 2100),

    status           card_status NOT NULL DEFAULT 'pending',
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    terminated_at    TIMESTAMPTZ NULL,

    CONSTRAINT cards_uuid_key UNIQUE (uuid),

    -- The webhook lookup key. A provider card id maps to exactly one card row,
    -- so an inbound event can never be ambiguous about whose money moved.
    CONSTRAINT cards_provider_unique UNIQUE (provider, provider_card_id),

    CONSTRAINT termination_is_complete CHECK (
        (status = 'terminated') = (terminated_at IS NOT NULL)
    )
);

CREATE INDEX cards_user ON cards (user_id, status);

-- Termination is final, like a revoked session. A terminated card's number is
-- dead at the provider and cannot be brought back, so a row that says
-- otherwise would be a lie the application could act on.
CREATE OR REPLACE FUNCTION assert_card_termination_final() RETURNS TRIGGER AS $$
BEGIN
    IF OLD.status = 'terminated' AND NEW.status IS DISTINCT FROM 'terminated' THEN
        RAISE EXCEPTION 'card % was terminated at %; termination is final',
            OLD.id, OLD.terminated_at
            USING ERRCODE = 'check_violation';
    END IF;

    -- The provider's identity for a card is immutable. If this ever changed,
    -- every webhook already delivered would point at the wrong row.
    IF NEW.provider_card_id IS DISTINCT FROM OLD.provider_card_id
       OR NEW.provider IS DISTINCT FROM OLD.provider
       OR NEW.user_id IS DISTINCT FROM OLD.user_id THEN
        RAISE EXCEPTION 'card % identity is immutable', OLD.id
            USING ERRCODE = 'check_violation';
    END IF;

    NEW.updated_at := now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER cards_termination_final
    BEFORE UPDATE ON cards
    FOR EACH ROW EXECUTE FUNCTION assert_card_termination_final();

-- ---------------------------------------------------------------------------
-- 3. WHY A CARD HAS ITS OWN LEDGER ACCOUNT
--
-- `customer_card` is described in 001_ledger.sql as "funds loaded onto a
-- virtual card", and that is exactly what it holds. A Bitnob virtual card has
-- its own balance that is topped up from the wallet; a purchase is authorised
-- against THAT balance, not against the wallet.
--
--   Funding       wallet  -> card                  (reclassified, still ours)
--   Authorization card    -> pending               (committed, not yet spent)
--   Settlement    pending -> provider_float        (the hold becomes a spend)
--   Expiry        pending -> card                  (the hold lapsed)
--   Termination   card    -> wallet                (what is left comes back)
--
-- The overdraft guard from section 6b already covers `customer_card`, so a
-- card cannot be spent past its balance without any new rule being written.
--
-- NOTE — this CORRECTS Phase 3. The Bitnob webhook adapter originally mapped
-- an authorization as wallet -> pending, which would let a customer spend the
-- whole wallet on a card funded with ten dollars. Phase 3 had no card table to
-- know better; this file is where the distinction becomes real.
-- ---------------------------------------------------------------------------

-- Cards a customer can actually use right now. Frozen and terminated cards are
-- excluded, so a caller cannot present one as spendable by forgetting a filter.
CREATE OR REPLACE VIEW active_cards AS
SELECT c.id AS card_id,
       c.uuid AS card_uuid,
       c.user_id,
       c.provider,
       c.provider_card_id,
       c.currency,
       c.last4,
       c.expiry_month,
       c.expiry_year,
       c.created_at
  FROM cards c
 WHERE c.status = 'active';

COMMIT;
