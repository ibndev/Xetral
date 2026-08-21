-- ===========================================================================
--  Xetral — Phase 8: NGN funding rail (Bitnob dedicated virtual accounts)
--  packages/ledger/sql/006_funding.sql
--
--  THE PHASE THAT LETS THE PLATFORM RECEIVE MONEY.
--
--  Everything shipped before this can move, spend and reconcile funds that are
--  already in a wallet. Nothing put them there. A customer gets a dedicated
--  Nigerian bank account number in their own name, transfers to it from any
--  bank, and Bitnob tells us the money arrived.
--
--    Funding    provider_float -> customer_wallet
--
--  That entry kind (`wallet_funding`) has existed since Phase 1 and has been
--  exercised by every e2e suite through a `fund()` helper standing in for this
--  webhook. So the accounting is not new. What is new is the account a
--  customer pays into, the webhook that reports it, and the fact that from
--  here on the money is REAL.
--
--  WHY THIS IS THE MOST DANGEROUS WEBHOOK IN THE SYSTEM
--  ----------------------------------------------------
--  Every other inbound event moves money that is already ours to move. This
--  one CREATES a customer balance out of a provider's say-so. Three failure
--  modes follow, and each has a control below:
--
--    1. A replayed webhook credits twice.        -> journal idempotency_key
--    2. A misread amount credits the wrong sum.  -> deposits.amount_minor is
--                                                   what we posted, checked
--                                                   against the entry
--    3. A deposit we cannot attribute is lost.   -> suspense, never dropped
-- ===========================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. THE ACCOUNT A CUSTOMER PAYS INTO
--
-- Dedicated and permanent: one NGN account number per customer, issued once
-- and printed in their app for ever. That permanence is the reason for the
-- immutability trigger below — a customer who saved the number as a beneficiary
-- last year will use it again next year, and every deposit already made points
-- at this row.
-- ---------------------------------------------------------------------------

CREATE TYPE virtual_account_status AS ENUM ('pending', 'active', 'closed');

CREATE TABLE virtual_accounts (
    id                  BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    uuid                UUID        NOT NULL DEFAULT gen_random_uuid(),
    user_id             BIGINT      NOT NULL REFERENCES users(id),

    provider            TEXT        NOT NULL DEFAULT 'bitnob',
    /** Bitnob's id for the account. The webhook names this. */
    provider_account_id TEXT        NOT NULL,

    -- The NBA details a customer types into their banking app. Not secret --
    -- an account number is meant to be given out -- but wrong ones send money
    -- to a stranger, so they are immutable once issued.
    account_number      TEXT        NOT NULL CHECK (account_number ~ '^[0-9]{10}$'),
    bank_name           TEXT        NOT NULL,
    account_name        TEXT        NOT NULL,

    currency            TEXT        NOT NULL DEFAULT 'NGN',
    status              virtual_account_status NOT NULL DEFAULT 'pending',

    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT virtual_accounts_uuid_key UNIQUE (uuid),

    -- One provider account belongs to one row. Without this a webhook naming
    -- an account could credit whichever row was read first, which is the
    -- funding equivalent of routing a deposit to a stranger.
    CONSTRAINT virtual_accounts_provider_key UNIQUE (provider, provider_account_id),
    -- And the NUBAN itself is unique across the whole table, because that is
    -- what a customer actually types and what a webhook may identify.
    CONSTRAINT virtual_accounts_number_key UNIQUE (account_number)
);

-- One LIVE account per customer per currency. Partial, so a closed account
-- stays as history and a replacement can be issued.
--
-- A partial UNIQUE INDEX rather than an EXCLUDE constraint, and the difference
-- is not cosmetic: `ON CONFLICT` cannot target an exclusion constraint, and the
-- issuing path depends on it. Two requests racing to create a customer's first
-- account must have the loser read the winner's row -- the same
-- resolve-or-create the ledger uses for accounts -- and with EXCLUDE the loser
-- gets an error instead, on the one request a customer makes when they are
-- trying to give us money.
CREATE UNIQUE INDEX virtual_accounts_one_live
    ON virtual_accounts (user_id, currency) WHERE (status <> 'closed');

CREATE INDEX virtual_accounts_user ON virtual_accounts (user_id) WHERE status <> 'closed';

-- Identity is fixed at issuance. Changing the owner or the number of an
-- account that customers have already paid into would silently redirect
-- money -- including deposits that are in flight at the moment of the UPDATE.
CREATE OR REPLACE FUNCTION assert_virtual_account_immutable() RETURNS TRIGGER AS $$
BEGIN
    IF NEW.user_id             IS DISTINCT FROM OLD.user_id
       OR NEW.provider            IS DISTINCT FROM OLD.provider
       OR NEW.provider_account_id IS DISTINCT FROM OLD.provider_account_id
       OR NEW.account_number      IS DISTINCT FROM OLD.account_number
       OR NEW.currency            IS DISTINCT FROM OLD.currency THEN
        RAISE EXCEPTION 'virtual account % is issued; its owner and number are fixed', OLD.id
            USING ERRCODE = 'check_violation';
    END IF;

    -- A closed account is closed. Reopening one would resurrect a number we
    -- may have already told the customer to stop using.
    IF OLD.status = 'closed' AND NEW.status <> 'closed' THEN
        RAISE EXCEPTION 'virtual account % is closed', OLD.id
            USING ERRCODE = 'check_violation';
    END IF;

    NEW.updated_at := now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER virtual_accounts_immutable
    BEFORE UPDATE ON virtual_accounts
    FOR EACH ROW EXECUTE FUNCTION assert_virtual_account_immutable();

-- ---------------------------------------------------------------------------
-- 2. THE MONEY THAT ARRIVED
--
-- A record per inbound credit, separate from the journal entry, for three
-- reasons the ledger alone does not serve:
--
--   - AML. Nigerian regulation cares who sent the money. The sender's name,
--     bank and account are recorded here and nowhere in the ledger, which
--     records amounts and not counterparties.
--   - Reconciliation. "Bitnob says they received 40 deposits today; how many
--     did we credit?" is a question about this table.
--   - Attribution. A deposit we could not match to a customer still happened,
--     and must be visible while it sits in suspense.
-- ---------------------------------------------------------------------------

CREATE TYPE deposit_status AS ENUM ('credited', 'suspense', 'returned');

CREATE TABLE deposits (
    id                  BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    uuid                UUID        NOT NULL DEFAULT gen_random_uuid(),

    provider            TEXT        NOT NULL DEFAULT 'bitnob',
    /** The provider's own id for this credit. THE replay guard's source. */
    provider_reference  TEXT        NOT NULL,

    -- NULL when we could not attribute it. That is the whole point of the
    -- column being nullable: an unattributable deposit is still a deposit and
    -- must be recorded, not discarded because it did not fit.
    user_id             BIGINT      NULL REFERENCES users(id),
    virtual_account_id  BIGINT      NULL REFERENCES virtual_accounts(id),

    amount_minor        BIGINT      NOT NULL CHECK (amount_minor > 0),
    currency            TEXT        NOT NULL,

    -- Who paid. Free text because it comes from the sending bank and we do not
    -- control its shape. Personal data: never logged, and read only for
    -- compliance.
    sender_name         TEXT        NULL,
    sender_bank         TEXT        NULL,
    sender_account      TEXT        NULL,

    status              deposit_status NOT NULL,
    /** The entry that credited it. Always set -- suspense is a posting too. */
    entry_id            BIGINT      NOT NULL REFERENCES journal_entries(id),
    suspense_reason     TEXT        NULL,

    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT deposits_uuid_key UNIQUE (uuid),
    -- One credit per provider reference. The journal's idempotency_key is the
    -- real guard; this one makes a double-credit impossible to even record,
    -- so the two would have to fail together.
    CONSTRAINT deposits_provider_key UNIQUE (provider, provider_reference),

    -- A credited deposit belongs to somebody. A suspense one explicitly does
    -- not, and says why.
    CONSTRAINT credited_has_an_owner CHECK (
        status <> 'credited' OR (user_id IS NOT NULL AND virtual_account_id IS NOT NULL)
    ),
    CONSTRAINT suspense_says_why CHECK (
        status <> 'suspense' OR suspense_reason IS NOT NULL
    )
);

CREATE INDEX deposits_user     ON deposits (user_id, created_at DESC);
CREATE INDEX deposits_suspense ON deposits (created_at) WHERE status = 'suspense';

-- A deposit's amount and owner are what we posted to the ledger. Changing
-- either would make the two disagree, and the ledger is the one that is right.
-- Moving a deposit OUT of suspense is the single legal transition, because
-- that is a correction a human makes with a reversing entry.
CREATE OR REPLACE FUNCTION assert_deposit_immutable() RETURNS TRIGGER AS $$
BEGIN
    IF NEW.amount_minor       IS DISTINCT FROM OLD.amount_minor
       OR NEW.currency           IS DISTINCT FROM OLD.currency
       OR NEW.provider_reference IS DISTINCT FROM OLD.provider_reference
       OR NEW.entry_id           IS DISTINCT FROM OLD.entry_id THEN
        RAISE EXCEPTION 'deposit % records what was posted; it is immutable', OLD.id
            USING ERRCODE = 'check_violation';
    END IF;

    IF OLD.status <> 'suspense' AND NEW.status IS DISTINCT FROM OLD.status THEN
        RAISE EXCEPTION 'deposit % is already %; only suspense can be resolved',
            OLD.id, OLD.status
            USING ERRCODE = 'check_violation';
    END IF;

    NEW.updated_at := now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER deposits_immutable
    BEFORE UPDATE ON deposits
    FOR EACH ROW EXECUTE FUNCTION assert_deposit_immutable();

-- Money we hold and cannot attribute. Every row is somebody's rent, and the
-- oldest ones are the ones somebody is currently on the phone about.
CREATE OR REPLACE VIEW unattributed_deposits AS
SELECT d.id AS deposit_id,
       d.uuid AS deposit_uuid,
       d.provider,
       d.provider_reference,
       d.amount_minor,
       d.currency,
       d.sender_name,
       d.sender_bank,
       d.suspense_reason,
       d.created_at,
       now() - d.created_at AS unresolved_for
  FROM deposits d
 WHERE d.status = 'suspense'
 ORDER BY d.created_at;

COMMIT;
