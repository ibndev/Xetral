-- ===========================================================================
--  Xetral — Card spend protection
--  packages/ledger/sql/010_card_protection.sql
--
--  WHAT THIS IS FOR, AND WHAT IT CANNOT DO.
--
--  A Bitnob authorization webhook is a NOTIFICATION, not an approval request.
--  By the time it reaches us the card network has already said yes and the
--  money is committed. So nothing here "blocks" a charge, and any comment or
--  endpoint that claimed to would be lying about the one thing a customer
--  most wants to be true.
--
--  What it does instead, in order of how much it is worth:
--
--   1. NOTICES a duplicate the moment the second one lands, and STOPS THE
--      THIRD by freezing the card. A merchant that double-posts usually
--      triple-posts; the window between the second and the third is the only
--      one anybody can act in, and it is minutes wide.
--   2. Turns the first insufficient-funds decline into a frozen card, so a
--      subscription retry cascade cannot run a customer through a week of
--      declines and per-attempt merchant fees.
--   3. Caps what a card can spend in a day and how often it can be charged in
--      an hour, so a leaked PAN empties a card rather than a wallet.
--   4. Keeps a record of every authorization and every decline that is OURS,
--      so operations can answer "what happened on this card" without asking
--      the provider — the same reason the ledger holds balances rather than
--      trusting a provider figure.
--
--  THE MONEY IS ALWAYS RECORDED. Every guard here fires ALONGSIDE the journal
--  entry, never instead of it. A spend the network approved is a fact about
--  the world, and a policy that refused to write it down would leave the
--  books saying a customer has money they do not have. That is the same rule
--  the deposit path follows with `suspense`.
-- ===========================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. AUTHORIZATIONS
--
-- One row per authorization we accepted. This is the input to the duplicate
-- check and the velocity caps, and it is a card statement operations can read
-- without a provider call.
--
-- It is NOT the ledger. The journal entry is the money; this is the context
-- around it — who the merchant was, which attempt it was — which the ledger
-- deliberately does not model because a posting is an amount and an account.
-- ---------------------------------------------------------------------------
CREATE TABLE card_authorizations (
    id                     BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    card_id                BIGINT      NOT NULL REFERENCES cards(id),

    -- The provider's id for this transaction. UNIQUE per card, so a webhook
    -- redelivery cannot become a second authorization here even though the
    -- ledger's own idempotency key would already have made the posting a
    -- replay. Two guards, because this table is what the duplicate check
    -- counts and a double-counted redelivery would freeze a card over
    -- nothing.
    provider_txn_id        TEXT        NOT NULL,

    -- Normalised for comparison: case-folded, trimmed, whitespace collapsed.
    -- "AMZN Mktp US*2H4KL" and "AMZN MKTP US*2H4KL " are the same merchant to
    -- a customer and must be to the duplicate check. NULL when the provider
    -- sends no merchant, in which case the duplicate check cannot fire — see
    -- `card_duplicate_authorizations` below.
    merchant_key           TEXT        NULL,
    merchant_label         TEXT        NULL,

    amount_minor           BIGINT      NOT NULL CHECK (amount_minor > 0),
    currency               TEXT        NOT NULL,

    /** The journal entry that recorded it. Always present: see the header. */
    entry_id               BIGINT      NOT NULL REFERENCES journal_entries(id),

    /** Set when this row tripped a guard. The money still moved. */
    flagged_reason         TEXT        NULL,

    occurred_at            TIMESTAMPTZ NOT NULL,
    created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT card_authorizations_provider_unique UNIQUE (card_id, provider_txn_id)
);

-- The duplicate check and the velocity caps both read "this card, recently",
-- so that is the index. DESC because every query wants the newest first.
CREATE INDEX card_authorizations_recent
    ON card_authorizations (card_id, occurred_at DESC);

-- The duplicate check adds merchant and amount to that. Partial, because a
-- row with no merchant can never match this predicate and carrying it in the
-- index would only make the index bigger.
CREATE INDEX card_authorizations_duplicate_probe
    ON card_authorizations (card_id, merchant_key, amount_minor, occurred_at DESC)
    WHERE merchant_key IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 2. DECLINES
--
-- A decline moves no money, so it has no journal entry and the ledger has no
-- opinion about it. It is still the single most useful fraud signal a card
-- produces: card testing is a burst of small declines, and a subscription
-- cascade is the same decline repeating on a schedule.
--
-- `source` separates "the network refused" from "we refused" — the second
-- only happens on paths WE initiate, where refusing is actually possible.
-- Conflating them would make it impossible to tell a customer with no money
-- from a customer being attacked.
-- ---------------------------------------------------------------------------
CREATE TYPE card_decline_source AS ENUM ('provider', 'xetral');

CREATE TABLE card_declines (
    id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    card_id          BIGINT      NOT NULL REFERENCES cards(id),

    source           card_decline_source NOT NULL,

    -- NULL when we refused before any provider transaction existed.
    provider_txn_id  TEXT        NULL,

    merchant_key     TEXT        NULL,
    merchant_label   TEXT        NULL,
    amount_minor     BIGINT      NULL CHECK (amount_minor IS NULL OR amount_minor > 0),
    currency         TEXT        NULL,

    /** Our classification. The provider's own words go in `provider_reason`;
     *  this is the one the code branches on, so a provider rewording their
     *  message cannot silently change our behaviour. */
    reason           TEXT        NOT NULL CHECK (length(trim(reason)) > 0),
    provider_reason  TEXT        NULL,

    occurred_at      TIMESTAMPTZ NOT NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- Same reasoning as the authorization table: a redelivered decline
    -- webhook must not count twice toward the burst threshold.
    CONSTRAINT card_declines_provider_unique UNIQUE (card_id, provider_txn_id)
);

CREATE INDEX card_declines_recent ON card_declines (card_id, occurred_at DESC);

-- ---------------------------------------------------------------------------
-- 3. WHY A CARD WAS FROZEN
--
-- `cards.status` says frozen. It does not say whether the customer tapped
-- freeze or whether we froze it at 3am because a merchant double-posted, and
-- those need completely different words on the customer's screen — one is
-- "you froze this", the other is "we stopped something and here is what".
--
-- Append-only, by trigger. A freeze history a privileged user can edit tells
-- you what the last person with access wanted you to believe, which is the
-- same rule the audit log follows.
-- ---------------------------------------------------------------------------
CREATE TYPE card_freeze_actor AS ENUM ('customer', 'staff', 'automatic');

CREATE TABLE card_freezes (
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    card_id      BIGINT      NOT NULL REFERENCES cards(id),
    actor        card_freeze_actor NOT NULL,

    /** Machine-readable, so the client can choose the wording. */
    reason       TEXT        NOT NULL CHECK (length(trim(reason)) > 0),
    detail       TEXT        NULL,

    /** Set when the card is unfrozen again. A live freeze is one with no
     *  `lifted_at`, which is also what makes "was this card ever frozen
     *  automatically" answerable months later. */
    lifted_at    TIMESTAMPTZ NULL,
    lifted_by    BIGINT      NULL REFERENCES users(id),

    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX card_freezes_live ON card_freezes (card_id) WHERE lifted_at IS NULL;

CREATE OR REPLACE FUNCTION card_freezes_append_only() RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'card_freezes is append-only: a freeze cannot be deleted';
    END IF;

    -- Lifting a freeze is the ONLY permitted update, and only once. Everything
    -- else about the row is a statement about a moment that has passed.
    IF OLD.card_id IS DISTINCT FROM NEW.card_id
       OR OLD.actor IS DISTINCT FROM NEW.actor
       OR OLD.reason IS DISTINCT FROM NEW.reason
       OR OLD.detail IS DISTINCT FROM NEW.detail
       OR OLD.created_at IS DISTINCT FROM NEW.created_at THEN
        RAISE EXCEPTION 'card_freezes is append-only: only lifted_at/lifted_by may be set';
    END IF;

    IF OLD.lifted_at IS NOT NULL AND NEW.lifted_at IS DISTINCT FROM OLD.lifted_at THEN
        RAISE EXCEPTION 'this freeze was already lifted at %', OLD.lifted_at;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER card_freezes_immutable
    BEFORE UPDATE OR DELETE ON card_freezes
    FOR EACH ROW EXECUTE FUNCTION card_freezes_append_only();

-- ---------------------------------------------------------------------------
-- 4. THE DUPLICATE PROBE
--
-- "Has this exact charge already landed on this card, from this merchant, in
-- the last N seconds?"
--
-- Matching on merchant AND amount AND a short window, rather than on any one
-- of them, is what keeps this from firing on ordinary behaviour: buying two
-- coffees at the same shop an hour apart is not a duplicate, and two
-- different amounts at the same merchant in the same minute is a customer
-- with a basket. The same merchant, to the cent, twice inside ninety seconds
-- is not something a person does.
--
-- A row with no merchant NEVER matches. A provider that omits the merchant
-- would otherwise make every same-amount charge on a card look like a
-- duplicate of every other, and freezing a card because someone topped up
-- twice is a worse failure than missing a duplicate.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION card_duplicate_authorizations(
    p_card_id        BIGINT,
    p_merchant_key   TEXT,
    p_amount_minor   BIGINT,
    p_occurred_at    TIMESTAMPTZ,
    p_window_seconds INT
) RETURNS INT AS $$
    SELECT count(*)::INT
    FROM card_authorizations
    WHERE card_id = p_card_id
      AND p_merchant_key IS NOT NULL
      AND merchant_key = p_merchant_key
      AND amount_minor = p_amount_minor
      AND occurred_at >  p_occurred_at - make_interval(secs => p_window_seconds)
      AND occurred_at <= p_occurred_at;
$$ LANGUAGE sql STABLE;

-- ---------------------------------------------------------------------------
-- 5. THE OPERATIONS QUEUES
--
-- Both are ASSERTIONS, not reports: something in here is something a person
-- has to look at, and a view that nobody queries is a queue that silently
-- grows. The admin overview reads them.
-- ---------------------------------------------------------------------------

/** Cards frozen by us, still frozen, that nobody has looked at. */
CREATE VIEW cards_frozen_automatically AS
SELECT c.uuid              AS card_uuid,
       c.user_id,
       c.last4,
       f.reason,
       f.detail,
       f.created_at        AS frozen_at,
       now() - f.created_at AS frozen_for
FROM card_freezes f
JOIN cards c ON c.id = f.card_id
WHERE f.lifted_at IS NULL
  AND f.actor = 'automatic'
  AND c.status = 'frozen'
ORDER BY f.created_at;

/** Charges that landed and should not have. The money moved — these are for
 *  a human to dispute with the merchant, not for a job to reverse. */
CREATE VIEW card_flagged_authorizations AS
SELECT c.uuid       AS card_uuid,
       c.user_id,
       c.last4,
       a.merchant_label,
       a.amount_minor,
       a.currency,
       a.flagged_reason,
       a.occurred_at
FROM card_authorizations a
JOIN cards c ON c.id = a.card_id
WHERE a.flagged_reason IS NOT NULL
ORDER BY a.occurred_at DESC;

COMMIT;
