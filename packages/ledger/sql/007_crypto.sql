-- ===========================================================================
--  Xetral — Phase 9: Crypto (USDT, stablecoins, on-chain)
--  packages/ledger/sql/007_crypto.sql
--
--  WHAT MAKES CRYPTO DIFFERENT FROM EVERY OTHER RAIL HERE
--  ------------------------------------------------------
--  1. A deposit is NOT final when you first see it. A transaction with one
--     confirmation can be reorganised out of existence, and crediting it as
--     spendable means a customer withdraws money that later stops having
--     happened. So a deposit lands in `customer_pending` -- the same account
--     card authorizations and gift card holds use -- and only becomes
--     spendable at the confirmation threshold.
--
--  2. A withdrawal is IRREVERSIBLE the moment it is broadcast. There is no
--     chargeback, no recall, and no provider to appeal to. Everything before
--     the broadcast (the PIN, the address validation, the overdraft guard) is
--     the entire safety mechanism, because nothing after it exists.
--
--  3. The chain matters as much as the asset. USDT on Tron sent to an
--     Ethereum address is gone. `network` is therefore part of an address's
--     identity, not a label on it.
--
--  The money flow -- and note that it needs NO new entry kinds. `crypto_deposit`
--  and `crypto_withdrawal` have been in 001_ledger.sql since Phase 1, and the
--  two-phase shape is the one Phase 5 built for card authorizations:
--
--    Deposit seen        provider_float   -> customer_pending
--    Deposit confirmed   customer_pending -> customer_wallet
--    Deposit orphaned    a reversal naming the seen entry
--
--    Withdrawal reserved customer_wallet  -> customer_pending
--    Withdrawal sent     customer_pending -> provider_float
--    Withdrawal failed   a reversal naming the reservation
-- ===========================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. WHERE MONEY COMES IN
--
-- A deposit address is permanent and public. Anyone can send to it at any
-- time, without asking us, and we find out afterwards -- which is why the row
-- is immutable and why one address belongs to exactly one customer.
-- ---------------------------------------------------------------------------

CREATE TYPE crypto_network AS ENUM ('bitcoin', 'ethereum', 'tron', 'bsc');

CREATE TABLE crypto_addresses (
    id                  BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    uuid                UUID        NOT NULL DEFAULT gen_random_uuid(),
    user_id             BIGINT      NOT NULL REFERENCES users(id),

    provider            TEXT        NOT NULL DEFAULT 'bitnob',
    provider_address_id TEXT        NOT NULL,

    asset               TEXT        NOT NULL,
    network             crypto_network NOT NULL,
    address             TEXT        NOT NULL CHECK (length(address) BETWEEN 20 AND 128),
    /** Required on chains that use one (XRP, XLM-style memos). NULL elsewhere. */
    memo                TEXT        NULL,

    active              BOOLEAN     NOT NULL DEFAULT TRUE,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT crypto_addresses_uuid_key     UNIQUE (uuid),
    CONSTRAINT crypto_addresses_provider_key UNIQUE (provider, provider_address_id),

    -- One address, one owner. A deposit naming an address must resolve to
    -- exactly one customer or the money is credited to whoever was read first.
    CONSTRAINT crypto_addresses_unique       UNIQUE (network, address)
);

-- One LIVE address per (customer, asset, network).
--
-- A partial UNIQUE INDEX rather than an EXCLUDE constraint, for the reason
-- Phase 8 discovered the hard way: `ON CONFLICT` cannot target an exclusion
-- constraint, and the issuing path needs the loser of a race to read the
-- winner's row rather than receive an error.
CREATE UNIQUE INDEX crypto_addresses_one_live
    ON crypto_addresses (user_id, asset, network) WHERE (active);

-- An address that has been given out is fixed. Reassigning one would credit a
-- new owner with deposits the previous owner is still receiving -- and the
-- sender has no way to know, because they are pasting an address they saved
-- months ago.
CREATE OR REPLACE FUNCTION assert_crypto_address_immutable() RETURNS TRIGGER AS $$
BEGIN
    IF NEW.user_id  IS DISTINCT FROM OLD.user_id
       OR NEW.address  IS DISTINCT FROM OLD.address
       OR NEW.network  IS DISTINCT FROM OLD.network
       OR NEW.asset    IS DISTINCT FROM OLD.asset
       OR NEW.memo     IS DISTINCT FROM OLD.memo
       OR NEW.provider IS DISTINCT FROM OLD.provider
       OR NEW.provider_address_id IS DISTINCT FROM OLD.provider_address_id THEN
        RAISE EXCEPTION 'crypto address % is issued and immutable', OLD.id
            USING ERRCODE = 'check_violation';
    END IF;

    NEW.updated_at := now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER crypto_addresses_immutable
    BEFORE UPDATE ON crypto_addresses
    FOR EACH ROW EXECUTE FUNCTION assert_crypto_address_immutable();

-- ---------------------------------------------------------------------------
-- 2. MONEY ARRIVING
--
-- `seen` is a real state, not a formality. Between seen and confirmed the
-- money is recorded, visible to the customer as pending, and NOT spendable --
-- because a chain reorganisation can still remove it, and a customer who
-- withdrew against it would have spent money that never existed.
-- ---------------------------------------------------------------------------

CREATE TYPE crypto_deposit_status AS ENUM ('seen', 'confirmed', 'orphaned');

CREATE TABLE crypto_deposits (
    id                  BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    uuid                UUID        NOT NULL DEFAULT gen_random_uuid(),

    provider            TEXT        NOT NULL DEFAULT 'bitnob',
    /** The provider's id for this credit. Our replay guard's source. */
    provider_reference  TEXT        NOT NULL,

    user_id             BIGINT      NOT NULL REFERENCES users(id),
    address_id          BIGINT      NOT NULL REFERENCES crypto_addresses(id),

    /** The on-chain transaction. Recorded because it is the only thing a
     *  customer can point at when they say "I sent it". */
    tx_hash             TEXT        NOT NULL,
    /** Which output within that transaction. A single transaction can pay the
     *  same address twice, and both payments are real money. */
    output_index        INT         NOT NULL DEFAULT 0 CHECK (output_index >= 0),

    asset               TEXT        NOT NULL,
    network             crypto_network NOT NULL,
    amount_minor        BIGINT      NOT NULL CHECK (amount_minor > 0),

    confirmations       INT         NOT NULL DEFAULT 0 CHECK (confirmations >= 0),
    /** How many this asset needs. Stored per row: raising the threshold later
     *  must not retroactively un-confirm deposits already credited. */
    required_confirmations INT      NOT NULL CHECK (required_confirmations > 0),

    status              crypto_deposit_status NOT NULL DEFAULT 'seen',

    seen_entry_id       BIGINT      NOT NULL REFERENCES journal_entries(id),
    confirmed_entry_id  BIGINT      NULL REFERENCES journal_entries(id),

    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT crypto_deposits_uuid_key     UNIQUE (uuid),
    CONSTRAINT crypto_deposits_provider_key UNIQUE (provider, provider_reference),
    -- The on-chain identity. Belt and braces with the provider reference: a
    -- provider that re-issued its own id must still not credit one payment
    -- twice.
    CONSTRAINT crypto_deposits_onchain_key  UNIQUE (network, tx_hash, output_index),

    CONSTRAINT confirmed_has_an_entry CHECK (
        status <> 'confirmed' OR confirmed_entry_id IS NOT NULL
    )
);

CREATE INDEX crypto_deposits_user ON crypto_deposits (user_id, created_at DESC);
CREATE INDEX crypto_deposits_open ON crypto_deposits (created_at) WHERE status = 'seen';

-- seen -> confirmed | orphaned, and nothing else.
--
-- `confirmed` is final because the money is spendable from that moment and may
-- already be gone. A chain deep enough to reorganise past our confirmation
-- threshold is an incident for a human, not a state transition.
CREATE OR REPLACE FUNCTION assert_crypto_deposit_transition() RETURNS TRIGGER AS $$
BEGIN
    IF NEW.status IS DISTINCT FROM OLD.status THEN
        IF NOT (OLD.status = 'seen' AND NEW.status IN ('confirmed', 'orphaned')) THEN
            RAISE EXCEPTION 'crypto deposit % cannot go from % to %',
                OLD.id, OLD.status, NEW.status
                USING ERRCODE = 'check_violation';
        END IF;
    END IF;

    IF NEW.amount_minor IS DISTINCT FROM OLD.amount_minor
       OR NEW.user_id     IS DISTINCT FROM OLD.user_id
       OR NEW.tx_hash     IS DISTINCT FROM OLD.tx_hash
       OR NEW.output_index IS DISTINCT FROM OLD.output_index
       OR NEW.asset       IS DISTINCT FROM OLD.asset
       OR NEW.network     IS DISTINCT FROM OLD.network
       OR NEW.seen_entry_id IS DISTINCT FROM OLD.seen_entry_id THEN
        RAISE EXCEPTION 'crypto deposit % records an on-chain fact; it is immutable', OLD.id
            USING ERRCODE = 'check_violation';
    END IF;

    -- Confirming below the threshold defeats the only protection against a
    -- reorg. The number is compared in the database so a service with a stale
    -- config cannot lower it.
    IF NEW.status = 'confirmed' AND NEW.confirmations < OLD.required_confirmations THEN
        RAISE EXCEPTION 'crypto deposit % has % confirmations; % are required',
            OLD.id, NEW.confirmations, OLD.required_confirmations
            USING ERRCODE = 'check_violation';
    END IF;

    -- Confirmations only ever go up. A provider re-reporting a lower count is
    -- reporting a different view of the chain, not a fact about ours.
    IF NEW.confirmations < OLD.confirmations THEN
        RAISE EXCEPTION 'crypto deposit % cannot lose confirmations (% -> %)',
            OLD.id, OLD.confirmations, NEW.confirmations
            USING ERRCODE = 'check_violation';
    END IF;

    NEW.updated_at := now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER crypto_deposits_transition
    BEFORE UPDATE ON crypto_deposits
    FOR EACH ROW EXECUTE FUNCTION assert_crypto_deposit_transition();

-- Deposits waiting on the chain. Money the customer can see and cannot spend.
CREATE OR REPLACE VIEW crypto_deposits_maturing AS
SELECT d.id AS deposit_id,
       d.user_id,
       d.provider_reference,
       d.asset,
       d.network,
       d.amount_minor,
       d.confirmations,
       d.required_confirmations,
       d.created_at,
       now() - d.created_at AS waiting_for
  FROM crypto_deposits d
 WHERE d.status = 'seen'
 ORDER BY d.created_at;

-- ---------------------------------------------------------------------------
-- 3. MONEY LEAVING, IRREVERSIBLY
--
-- The destination address is the single most dangerous field in the platform.
-- A typo does not bounce; it delivers, to a stranger, permanently. Everything
-- here exists to make the moment before broadcast as slow and as checked as it
-- can reasonably be.
-- ---------------------------------------------------------------------------

CREATE TYPE crypto_withdrawal_status AS ENUM (
  'reserved',    -- the customer's money is committed, nothing broadcast
  'broadcast',   -- it is on the chain and cannot be recalled
  'confirmed',   -- it is settled
  'failed'       -- it never left; the reservation is reversed
);

CREATE TABLE crypto_withdrawals (
    id                  BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    uuid                UUID        NOT NULL DEFAULT gen_random_uuid(),
    user_id             BIGINT      NOT NULL REFERENCES users(id),

    /** Ours, derived from the customer's key. The root of both ledger keys. */
    reference           TEXT        NOT NULL,
    idempotency_key     TEXT        NOT NULL,

    asset               TEXT        NOT NULL,
    network             crypto_network NOT NULL,
    /** Where it is going. Validated at the boundary AND checked here for
     *  obvious nonsense, because a wrong one cannot be undone. */
    destination         TEXT        NOT NULL CHECK (length(destination) BETWEEN 20 AND 128),
    memo                TEXT        NULL,

    /** What the destination receives. */
    amount_minor        BIGINT      NOT NULL CHECK (amount_minor > 0),
    /** The network fee, paid by the customer ON TOP of the amount. Separate so
     *  a statement can say what was sent and what it cost. */
    fee_minor           BIGINT      NOT NULL CHECK (fee_minor >= 0),

    status              crypto_withdrawal_status NOT NULL DEFAULT 'reserved',
    provider_reference  TEXT        NULL,
    tx_hash             TEXT        NULL,
    failure_reason      TEXT        NULL,

    reserve_entry_id    BIGINT      NOT NULL REFERENCES journal_entries(id),
    settle_entry_id     BIGINT      NULL REFERENCES journal_entries(id),

    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT crypto_withdrawals_uuid_key      UNIQUE (uuid),
    CONSTRAINT crypto_withdrawals_reference_key UNIQUE (reference),
    -- A customer key is unique PER CUSTOMER. Two customers will send the same
    -- one; a client counting from one is enough.
    CONSTRAINT crypto_withdrawals_user_key      UNIQUE (user_id, idempotency_key),

    CONSTRAINT broadcast_has_a_tx CHECK (
        status NOT IN ('broadcast', 'confirmed') OR tx_hash IS NOT NULL
    ),
    CONSTRAINT failed_says_why CHECK (
        status <> 'failed' OR failure_reason IS NOT NULL
    ),
    CONSTRAINT confirmed_has_an_entry CHECK (
        status <> 'confirmed' OR settle_entry_id IS NOT NULL
    )
);

CREATE INDEX crypto_withdrawals_user ON crypto_withdrawals (user_id, created_at DESC);
CREATE INDEX crypto_withdrawals_open ON crypto_withdrawals (created_at)
    WHERE status IN ('reserved', 'broadcast');

-- reserved -> broadcast | failed
-- broadcast -> confirmed | failed
--
-- Note what is absent: there is no path from `broadcast` back to `reserved`,
-- and none from `confirmed` to anything. Once bytes are on a chain the money
-- is gone whatever our database says, so a state machine that pretended
-- otherwise would be lying to whoever reads it next.
CREATE OR REPLACE FUNCTION assert_crypto_withdrawal_transition() RETURNS TRIGGER AS $$
BEGIN
    IF NEW.status IS DISTINCT FROM OLD.status THEN
        IF NOT (
            (OLD.status = 'reserved'  AND NEW.status IN ('broadcast', 'failed'))
            OR (OLD.status = 'broadcast' AND NEW.status IN ('confirmed', 'failed'))
        ) THEN
            RAISE EXCEPTION 'crypto withdrawal % cannot go from % to %',
                OLD.id, OLD.status, NEW.status
                USING ERRCODE = 'check_violation';
        END IF;
    END IF;

    IF NEW.user_id      IS DISTINCT FROM OLD.user_id
       OR NEW.reference    IS DISTINCT FROM OLD.reference
       OR NEW.destination  IS DISTINCT FROM OLD.destination
       OR NEW.memo         IS DISTINCT FROM OLD.memo
       OR NEW.asset        IS DISTINCT FROM OLD.asset
       OR NEW.network      IS DISTINCT FROM OLD.network
       OR NEW.amount_minor IS DISTINCT FROM OLD.amount_minor
       OR NEW.fee_minor    IS DISTINCT FROM OLD.fee_minor
       OR NEW.reserve_entry_id IS DISTINCT FROM OLD.reserve_entry_id THEN
        RAISE EXCEPTION 'crypto withdrawal % is immutable once requested', OLD.id
            USING ERRCODE = 'check_violation';
    END IF;

    -- A transaction hash is a fact about a chain. Changing it would point the
    -- customer's receipt at somebody else's transaction.
    IF OLD.tx_hash IS NOT NULL AND NEW.tx_hash IS DISTINCT FROM OLD.tx_hash THEN
        RAISE EXCEPTION 'crypto withdrawal % already has a transaction hash', OLD.id
            USING ERRCODE = 'check_violation';
    END IF;

    NEW.updated_at := now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER crypto_withdrawals_transition
    BEFORE UPDATE ON crypto_withdrawals
    FOR EACH ROW EXECUTE FUNCTION assert_crypto_withdrawal_transition();

-- Withdrawals whose outcome we do not know. Same idea as `pending_purchases`:
-- money held against an answer nobody has given us yet.
CREATE OR REPLACE VIEW crypto_withdrawals_pending AS
SELECT w.id AS withdrawal_id,
       w.user_id,
       w.reference,
       w.provider_reference,
       w.asset,
       w.network,
       w.amount_minor,
       w.fee_minor,
       w.status,
       w.created_at,
       now() - w.created_at AS held_for
  FROM crypto_withdrawals w
 WHERE w.status IN ('reserved', 'broadcast')
 ORDER BY w.created_at;

COMMIT;
