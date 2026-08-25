-- ===========================================================================
--  Xetral — revealing a card number
--  packages/ledger/sql/016_card_reveals.sql
--
--  THE GAP THIS CLOSES. A virtual card whose number the customer cannot read
--  is not a product. `003_cards.sql` stores `last4` and an expiry and nothing
--  else — correctly, because a database dump must not contain PANs — with the
--  consequence that every card issued since Phase 5 has been unusable. There
--  was no reveal endpoint, no port method, and nothing to call.
--
--  WHAT THIS TABLE IS NOT. It does not hold card numbers. There is no column
--  here that could, and that is the point: the reveal is a PASS-THROUGH —
--  fetched from the provider, handed to the customer who proved a PIN, and
--  dropped. This table records THAT a reveal happened, never what it revealed.
--
--  It does two jobs, and doing both in one place is deliberate:
--
--   1. THE AUDIT TRAIL. "When was this card number last shown, and to a
--      session on which address?" is the first question asked after a card is
--      used fraudulently, and it cannot be answered retrospectively.
--
--   2. THE RATE LIMIT. A reveal endpoint is a PAN oracle for anybody holding a
--      stolen session, so it needs a ceiling — and the ceiling has to survive
--      a restart, because an attacker's loop does. Counting rows in a window
--      gets that for free, and gets it from the same rows an investigator
--      reads. An in-memory counter would give neither.
-- ===========================================================================

BEGIN;

CREATE TABLE card_reveals (
    id         BIGSERIAL PRIMARY KEY,
    card_id    BIGINT      NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
    -- Denormalised from the card deliberately. A reveal is evidence, and
    -- evidence that has to be joined through a mutable row to be interpreted
    -- is evidence that can be reinterpreted.
    user_id    BIGINT      NOT NULL REFERENCES users(id),

    -- Only as trustworthy as `trustProxyHops`, and recorded for an
    -- investigator rather than relied on for a decision.
    ip_address TEXT,
    revealed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX card_reveals_recent ON card_reveals (card_id, revealed_at DESC);
CREATE INDEX card_reveals_by_user ON card_reveals (user_id, revealed_at DESC);

-- ---------------------------------------------------------------------------
-- 1. APPEND-ONLY
--
-- Same rule as the audit log and for the same reason: a record of who looked
-- at a card number is worth exactly as much as its resistance to being edited
-- by whoever looked. If a row here could be deleted, the answer to "was this
-- number ever shown?" would be a claim about the present rather than about
-- history — and the one person motivated to change it is the one it names.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION assert_card_reveal_append_only() RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION
        'card_reveals is append-only: % is not permitted. A record of who saw a '
        'card number is worth what its immutability is worth.', TG_OP
        USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER card_reveals_append_only
    BEFORE UPDATE OR DELETE ON card_reveals
    FOR EACH STATEMENT EXECUTE FUNCTION assert_card_reveal_append_only();

-- ---------------------------------------------------------------------------
-- 2. A TERMINATED CARD HAS NOTHING TO REVEAL
--
-- Its number is dead at the provider, so a reveal would either fail or — worse
-- — return a number that no longer works, which a customer would then spend an
-- afternoon trying to use. Enforced here rather than only in the service,
-- because "this card is finished" is a fact about the row.
--
-- A FROZEN card CAN be revealed, and that asymmetry is deliberate. Freezing
-- stops spending, not looking; a customer who froze their card while
-- travelling still has a legitimate reason to read the number off it.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION assert_card_revealable() RETURNS TRIGGER AS $$
DECLARE
    v_status card_status;
    v_owner  BIGINT;
BEGIN
    SELECT status, user_id INTO v_status, v_owner FROM cards WHERE id = NEW.card_id;

    IF v_status = 'terminated' THEN
        RAISE EXCEPTION 'card % is terminated; its number is dead at the provider',
            NEW.card_id
            USING ERRCODE = 'check_violation';
    END IF;

    -- The owner on the row must be the card's owner. A reveal attributed to
    -- the wrong customer is worse than no record at all: it is a record that
    -- points an investigation at somebody who did nothing.
    IF v_owner IS DISTINCT FROM NEW.user_id THEN
        RAISE EXCEPTION 'card % does not belong to user %', NEW.card_id, NEW.user_id
            USING ERRCODE = 'check_violation';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER card_reveal_allowed
    BEFORE INSERT ON card_reveals
    FOR EACH ROW EXECUTE FUNCTION assert_card_revealable();

-- ---------------------------------------------------------------------------
-- 3. WHAT AN INVESTIGATOR READS
--
-- A card revealed many times in a short window is the pattern worth looking
-- at: a legitimate customer reads their number once when they save it
-- somewhere, and occasionally again. Repeated reveals are somebody either
-- testing a session or copying a number they do not intend to keep.
-- ---------------------------------------------------------------------------
CREATE VIEW card_reveal_activity AS
SELECT c.uuid           AS card_uuid,
       c.user_id,
       c.last4,
       count(*)         AS reveals,
       max(r.revealed_at) AS last_revealed_at,
       count(DISTINCT r.ip_address) AS distinct_addresses
  FROM card_reveals r
  JOIN cards c ON c.id = r.card_id
 WHERE r.revealed_at > now() - interval '30 days'
 GROUP BY c.uuid, c.user_id, c.last4
 ORDER BY count(*) DESC;

COMMIT;
