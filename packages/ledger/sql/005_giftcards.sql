-- ===========================================================================
--  Xetral — Phase 7: Gift card trading
--  packages/ledger/sql/005_giftcards.sql
--
--  Buying gift cards FROM customers. This is the highest-fraud surface in the
--  product and the schema is shaped by that rather than by the happy path.
--
--  WHY THIS IS DIFFERENT FROM EVERY OTHER FLOW
--  -------------------------------------------
--  Everywhere else, the customer gives us money and we give them a thing. Here
--  the customer gives us a THING and we give them money — and the thing is a
--  bearer instrument whose value we cannot verify at the moment we pay.
--
--  A gift card code can be:
--    - already redeemed, and look identical to one that is not
--    - redeemed by the seller minutes AFTER we accept it
--    - bought with a stolen credit card, and clawed back weeks later by the
--      issuer, at which point the balance is voided
--
--  So there is no version of this flow where paying immediately is safe. Two
--  controls exist because of that, and both are in the schema rather than in
--  application code:
--
--    1. A REVIEW QUEUE. Nothing is paid without a human approving it. There is
--       deliberately no auto-approval path, not even for small amounts —
--       "small" is exactly what a fraudster sends first to find the threshold.
--    2. A HOLD PERIOD. An approved payout lands in `customer_pending`, which
--       the wallet already reports as unspendable, and only becomes spendable
--       when the hold expires. That window is what makes a clawback
--       recoverable instead of merely regrettable.
--
--  The money flow, using accounts that mostly already exist:
--
--    Approve        giftcard_inventory -> customer_pending    held, not spendable
--    Release hold   customer_pending   -> customer_wallet     now spendable
--    Claw back      a reversal naming the approval            during the hold
--    Reject         (nothing)                                 no entry at all
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- New enum values must be added OUTSIDE a transaction block.
--
-- Postgres allows ALTER TYPE ... ADD VALUE inside one since 12, but the new
-- value cannot then be USED until that transaction commits — which turns a
-- migration that adds a value and immediately references it into an error that
-- reads as though the value was never added. Adding them first, in autocommit,
-- removes the trap entirely.
-- ---------------------------------------------------------------------------

ALTER TYPE entry_kind ADD VALUE IF NOT EXISTS 'giftcard_purchase';
ALTER TYPE entry_kind ADD VALUE IF NOT EXISTS 'giftcard_hold_release';

-- We exchange a liability to the customer for an asset we now hold: a card
-- with a redeemable balance. It behaves like `provider_float` — a source that
-- goes negative as value flows out to customers — and is separate from it
-- because a gift card sitting in inventory is not money at a provider, and
-- reconciling the two against each other is the whole point of them being
-- different accounts.
ALTER TYPE account_kind ADD VALUE IF NOT EXISTS 'asset_giftcard_inventory';

BEGIN;

-- ---------------------------------------------------------------------------
-- WHO MAY REVIEW
--
-- The first thing in this platform that a customer must NOT be able to do.
-- Deliberately minimal: a row granting one role to one user, with who granted
-- it and when it was withdrawn. It is not an RBAC system and should not grow
-- into one until a second consumer exists — a permissions framework with one
-- caller is a framework whose design has never been tested.
-- ---------------------------------------------------------------------------

CREATE TYPE staff_role AS ENUM (
  'giftcard_reviewer',   -- may approve or reject submissions
  'admin'                -- may do that, and grant roles
);

CREATE TABLE staff_roles (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id     BIGINT      NOT NULL REFERENCES users(id),
    role        staff_role  NOT NULL,

    -- Who granted it. A privilege with no provenance cannot be audited after
    -- the fact, and "how did this account get approval rights?" is the first
    -- question asked after an incident.
    granted_by  BIGINT      NULL REFERENCES users(id),
    granted_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    revoked_at  TIMESTAMPTZ NULL,

    -- One live grant per (user, role). Partial, so a revoked grant stays as
    -- history and the same role can be granted again later.
    CONSTRAINT staff_roles_live_grant EXCLUDE (user_id WITH =, role WITH =)
        WHERE (revoked_at IS NULL)
);

CREATE INDEX staff_roles_live ON staff_roles (user_id, role) WHERE revoked_at IS NULL;

-- ---------------------------------------------------------------------------
-- WHAT WE PAY
--
-- A rate card is a published price: "we pay N1,250.00 for each USD of face
-- value on an Amazon US e-code". That is how the Nigerian gift card market
-- actually quotes, and modelling it directly avoids dragging FX (Phase 10)
-- into a phase that does not need it — the rate IS the conversion, set by us
-- and reviewed by us.
--
-- Rate cards are APPEND-ONLY and versioned. A submission stores the id of the
-- exact card it was quoted against, so a quote can be reproduced months later
-- during a dispute. Editing a rate in place would silently rewrite the price
-- of every past trade, which is the kind of thing that is only noticed when a
-- customer produces a screenshot.
-- ---------------------------------------------------------------------------

CREATE TABLE giftcard_rate_cards (
    id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    uuid              UUID        NOT NULL DEFAULT gen_random_uuid(),

    brand             TEXT        NOT NULL,   -- 'amazon', 'steam', 'apple'
    country           TEXT        NOT NULL,   -- ISO-3166 alpha-2 of the card's region
    card_type         TEXT        NOT NULL
                      CHECK (card_type IN ('ecode', 'physical')),

    face_currency     TEXT        NOT NULL,   -- what the card is denominated in
    payout_currency   TEXT        NOT NULL,   -- what the customer is paid in

    -- Payout minor units per ONE MAJOR unit of face value. N1,250.00 per $1 is
    -- 125000. An integer, like every other rate in this codebase: a decimal
    -- rate is a float in disguise and this one multiplies real money.
    payout_rate_minor BIGINT      NOT NULL CHECK (payout_rate_minor > 0),

    -- The band this rate applies to. Gift card rates genuinely differ by
    -- denomination -- a $500 card is worth proportionally less than a $25 one
    -- because it is harder to resell -- so a single rate per brand would be
    -- wrong in a way that costs money on every large trade.
    min_face_minor    BIGINT      NOT NULL CHECK (min_face_minor > 0),
    max_face_minor    BIGINT      NOT NULL,

    effective_from    TIMESTAMPTZ NOT NULL DEFAULT now(),
    retired_at        TIMESTAMPTZ NULL,
    created_by        BIGINT      NULL REFERENCES users(id),

    CONSTRAINT giftcard_rate_cards_uuid_key UNIQUE (uuid),
    CONSTRAINT rate_band_is_ordered CHECK (max_face_minor >= min_face_minor)
);

CREATE INDEX giftcard_rate_cards_live
    ON giftcard_rate_cards (brand, country, card_type, min_face_minor)
    WHERE retired_at IS NULL;

-- A rate card is a published price and is never edited. Retiring one and
-- publishing its replacement keeps every past quote reproducible.
CREATE OR REPLACE FUNCTION assert_rate_card_append_only() RETURNS TRIGGER AS $$
BEGIN
    IF NEW.brand             IS DISTINCT FROM OLD.brand
       OR NEW.country           IS DISTINCT FROM OLD.country
       OR NEW.card_type         IS DISTINCT FROM OLD.card_type
       OR NEW.face_currency     IS DISTINCT FROM OLD.face_currency
       OR NEW.payout_currency   IS DISTINCT FROM OLD.payout_currency
       OR NEW.payout_rate_minor IS DISTINCT FROM OLD.payout_rate_minor
       OR NEW.min_face_minor    IS DISTINCT FROM OLD.min_face_minor
       OR NEW.max_face_minor    IS DISTINCT FROM OLD.max_face_minor THEN
        RAISE EXCEPTION 'rate card % is published; retire it and publish a new one', OLD.id
            USING ERRCODE = 'check_violation';
    END IF;

    IF OLD.retired_at IS NOT NULL AND NEW.retired_at IS DISTINCT FROM OLD.retired_at THEN
        RAISE EXCEPTION 'rate card % is already retired', OLD.id
            USING ERRCODE = 'check_violation';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER giftcard_rate_cards_append_only
    BEFORE UPDATE ON giftcard_rate_cards
    FOR EACH ROW EXECUTE FUNCTION assert_rate_card_append_only();

-- ---------------------------------------------------------------------------
-- WHAT THE CUSTOMER SENT
-- ---------------------------------------------------------------------------

CREATE TYPE giftcard_status AS ENUM (
  'pending_review',   -- submitted; a human has not looked yet
  'approved',         -- paid, into a hold
  'rejected',         -- not paid; no ledger entry ever existed
  'released',         -- the hold expired and the money is spendable
  'clawed_back'       -- approved, then found bad while still held
);

CREATE TABLE giftcard_submissions (
    id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    uuid               UUID            NOT NULL DEFAULT gen_random_uuid(),
    user_id            BIGINT          NOT NULL REFERENCES users(id),

    -- Ours, and the root of both ledger idempotency keys. Derived from the
    -- customer's key for the same reason as a purchase reference: the approval
    -- entry may be posted before anything else, and a retry must reuse the key
    -- rather than pay twice.
    reference          TEXT            NOT NULL,
    idempotency_key    TEXT            NOT NULL,

    rate_card_id       BIGINT          NOT NULL REFERENCES giftcard_rate_cards(id),

    face_amount_minor  BIGINT          NOT NULL CHECK (face_amount_minor > 0),
    face_currency      TEXT            NOT NULL,

    -- What we agreed to pay, computed from the rate card at submission time
    -- and frozen here. Recomputing it at approval would let a rate change
    -- between the quote a customer accepted and the money they received.
    payout_amount_minor BIGINT         NOT NULL CHECK (payout_amount_minor > 0),
    payout_currency    TEXT            NOT NULL,

    -- THE CARD ITSELF. A bearer instrument, sealed with a key-versioned
    -- envelope exactly like a delivery payload, and for a stronger reason: a
    -- database dump containing these is a dump of spendable money belonging to
    -- customers who trusted us with it. The CHECK makes that structural.
    card_sealed        TEXT            NOT NULL CHECK (card_sealed ~ '^v[0-9]+:'),

    status             giftcard_status NOT NULL DEFAULT 'pending_review',

    -- Review
    reviewed_by        BIGINT          NULL REFERENCES users(id),
    reviewed_at        TIMESTAMPTZ     NULL,
    rejection_reason   TEXT            NULL,

    -- Hold
    hold_until         TIMESTAMPTZ     NULL,
    approval_entry_id  BIGINT          NULL REFERENCES journal_entries(id),
    release_entry_id   BIGINT          NULL REFERENCES journal_entries(id),
    clawback_reason    TEXT            NULL,

    created_at         TIMESTAMPTZ     NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ     NOT NULL DEFAULT now(),

    CONSTRAINT giftcard_submissions_uuid_key UNIQUE (uuid),
    CONSTRAINT giftcard_submissions_reference_key UNIQUE (reference),
    CONSTRAINT giftcard_submissions_user_key UNIQUE (user_id, idempotency_key),

    -- An approval that names no reviewer is an automatic payment, which is the
    -- one thing this table exists to prevent.
    CONSTRAINT approved_names_a_reviewer CHECK (
        status NOT IN ('approved', 'released', 'clawed_back')
        OR (reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL)
    ),
    -- An approval with no hold is a payout that was instantly spendable.
    CONSTRAINT approved_has_a_hold CHECK (
        status NOT IN ('approved', 'released', 'clawed_back') OR hold_until IS NOT NULL
    ),
    CONSTRAINT approved_has_an_entry CHECK (
        status NOT IN ('approved', 'released', 'clawed_back') OR approval_entry_id IS NOT NULL
    ),
    CONSTRAINT released_has_an_entry CHECK (
        status <> 'released' OR release_entry_id IS NOT NULL
    ),
    CONSTRAINT rejected_says_why CHECK (
        status <> 'rejected' OR rejection_reason IS NOT NULL
    ),
    CONSTRAINT clawback_says_why CHECK (
        status <> 'clawed_back' OR clawback_reason IS NOT NULL
    ),
    -- A reviewer approving their own submission is the simplest possible
    -- inside job, and the cheapest possible thing to forbid.
    CONSTRAINT nobody_reviews_their_own CHECK (reviewed_by IS NULL OR reviewed_by <> user_id)
);

CREATE INDEX giftcard_submissions_user  ON giftcard_submissions (user_id, created_at DESC);
CREATE INDEX giftcard_submissions_queue ON giftcard_submissions (created_at)
    WHERE status = 'pending_review';
CREATE INDEX giftcard_submissions_holds ON giftcard_submissions (hold_until)
    WHERE status = 'approved';

-- ---------------------------------------------------------------------------
-- The state machine, enforced here rather than in the service.
--
--   pending_review -> approved | rejected
--   approved       -> released | clawed_back
--   everything else is final
--
-- Written as an explicit table of legal transitions because the interesting
-- cases are the illegal ones: a rejected submission becoming approved after a
-- customer complains, a released payout being clawed back once the money is
-- already spent, a second approval paying twice.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION assert_giftcard_transition() RETURNS TRIGGER AS $$
BEGIN
    IF NEW.status IS DISTINCT FROM OLD.status THEN
        IF NOT (
            (OLD.status = 'pending_review' AND NEW.status IN ('approved', 'rejected'))
            OR (OLD.status = 'approved'   AND NEW.status IN ('released', 'clawed_back'))
        ) THEN
            RAISE EXCEPTION 'gift card % cannot go from % to %',
                OLD.id, OLD.status, NEW.status
                USING ERRCODE = 'check_violation';
        END IF;
    END IF;

    -- Identity, price and the card itself are fixed at submission. Letting the
    -- payout change after review would mean the number a reviewer approved and
    -- the number paid are different numbers.
    IF NEW.user_id             IS DISTINCT FROM OLD.user_id
       OR NEW.reference           IS DISTINCT FROM OLD.reference
       OR NEW.idempotency_key     IS DISTINCT FROM OLD.idempotency_key
       OR NEW.rate_card_id        IS DISTINCT FROM OLD.rate_card_id
       OR NEW.face_amount_minor   IS DISTINCT FROM OLD.face_amount_minor
       OR NEW.payout_amount_minor IS DISTINCT FROM OLD.payout_amount_minor
       OR NEW.card_sealed         IS DISTINCT FROM OLD.card_sealed THEN
        RAISE EXCEPTION 'gift card % identity, price and card are immutable', OLD.id
            USING ERRCODE = 'check_violation';
    END IF;

    -- A review, once recorded, is who reviewed it. Reassigning it afterwards
    -- would erase the accountability the column exists to create.
    IF OLD.reviewed_by IS NOT NULL AND NEW.reviewed_by IS DISTINCT FROM OLD.reviewed_by THEN
        RAISE EXCEPTION 'gift card % was already reviewed by %', OLD.id, OLD.reviewed_by
            USING ERRCODE = 'check_violation';
    END IF;

    -- Releasing early defeats the hold. The clock is the database's, not the
    -- application's -- a release scheduled by a worker with a wrong system
    -- clock is exactly the sort of thing that pays out a fraudulent card.
    IF NEW.status = 'released' AND OLD.hold_until > now() THEN
        RAISE EXCEPTION 'gift card % is held until %, which has not passed',
            OLD.id, OLD.hold_until
            USING ERRCODE = 'check_violation';
    END IF;

    NEW.updated_at := now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER giftcard_submissions_transition
    BEFORE UPDATE ON giftcard_submissions
    FOR EACH ROW EXECUTE FUNCTION assert_giftcard_transition();

-- The review queue. Every row is a customer waiting on a human.
CREATE OR REPLACE VIEW giftcard_review_queue AS
SELECT s.id AS submission_id,
       s.uuid AS submission_uuid,
       s.user_id,
       r.brand,
       r.country,
       r.card_type,
       s.face_amount_minor,
       s.face_currency,
       s.payout_amount_minor,
       s.payout_currency,
       s.created_at,
       now() - s.created_at AS waiting_for
  FROM giftcard_submissions s
  JOIN giftcard_rate_cards r ON r.id = s.rate_card_id
 WHERE s.status = 'pending_review'
 ORDER BY s.created_at;

-- Holds that have matured. Deliberately NOT auto-released by a trigger: the
-- release moves money and only the ledger service may do that.
CREATE OR REPLACE VIEW giftcard_holds_due AS
SELECT s.id AS submission_id,
       s.user_id,
       s.reference,
       s.payout_amount_minor,
       s.payout_currency,
       s.hold_until,
       s.approval_entry_id
  FROM giftcard_submissions s
 WHERE s.status = 'approved'
   AND s.hold_until <= now()
 ORDER BY s.hold_until;

COMMIT;
