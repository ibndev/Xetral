-- ============================================================================
--  030 — What happened to a card, and who did it.
--
--  WHAT WAS MISSING. `cards` carries `created_at`, `updated_at` and
--  `terminated_at`: three timestamps and no actor. A card frozen on Monday,
--  unfrozen on Tuesday and frozen again on Wednesday has ONE `updated_at`, and
--  nothing anywhere says which of those happened, in what order, or whether it
--  was the customer, a support agent or an automatic protection.
--
--  That is the wrong record for the object it describes. A virtual card is the
--  instrument a customer disputes charges on, and the first question in every
--  dispute — "was this card frozen at the time, and who unfroze it?" — had no
--  answer. `card_freezes` from 010 records the AUTOMATIC ones only, which is a
--  fraction of the story and reads like the whole of it.
--
--  REISSUE IS THE SECOND HALF, and it is why this is one migration rather than
--  two. A card whose number has leaked has to be replaced, and replacing it is
--  a termination and an issue that are ONE event from the customer's side.
--  Without a link between them their history reads as an unexplained
--  termination followed by an unrelated new card, and the balance that moved
--  between the two looks like two transactions rather than one continuation.
-- ============================================================================

BEGIN;

CREATE TYPE card_event_kind AS ENUM (
    'issued',
    'activated',
    'frozen',
    'unfrozen',
    'terminated',
    /** Terminated because a replacement was issued. A distinct kind, because
     *  "the customer stopped using this card" and "we replaced a card whose
     *  number leaked" are different facts about the same status. */
    'reissued'
);

/** Who acted. Not derivable from `actor_id` being NULL: a customer and a
 *  support agent are both users, and only this says which capacity they were
 *  acting in. */
CREATE TYPE card_actor AS ENUM ('customer', 'staff', 'system');

CREATE TABLE card_events (
    id         BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    card_id    BIGINT      NOT NULL REFERENCES cards(id),
    kind       card_event_kind NOT NULL,

    /**
     * NULL only for `system`, which is the automatic protection in 010 and the
     * provider's own events. Every human action names its human.
     */
    actor_id   BIGINT      NULL REFERENCES users(id),
    actor      card_actor  NOT NULL,

    /** Required of staff, by the CHECK below. A support agent freezing
     *  somebody's card without saying why is the action a customer will ask
     *  about and nobody can explain. */
    reason     TEXT        NULL,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT card_event_actor_is_consistent CHECK (
        (actor = 'system') = (actor_id IS NULL)
    ),
    CONSTRAINT staff_actions_say_why CHECK (
        actor <> 'staff' OR (reason IS NOT NULL AND length(trim(reason)) >= 5)
    )
);

CREATE INDEX card_events_card ON card_events (card_id, created_at);

/**
 * Append-only, and for a sharper reason than most tables here: this is the
 * record consulted when a customer disputes a charge, and the party with the
 * most interest in editing it is whoever made the change being asked about.
 */
CREATE OR REPLACE FUNCTION refuse_card_event_change() RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'card_events is append-only; % is refused', TG_OP
        USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER card_events_append_only
    BEFORE DELETE ON card_events
    FOR EACH ROW EXECUTE FUNCTION refuse_card_event_change();

/**
 * An event is written for EVERY status change, by trigger.
 *
 * By trigger and not by the service, so no path can change a card's status
 * without the change being recorded — including a psql prompt, which is
 * exactly the case a service-side write does not cover. The same division
 * `provider_credential_rotations` and `kyc_tier_changes` make.
 *
 * The trigger cannot know WHO, so it writes `system` and the service that
 * caused the change completes the row inside the same transaction. A change
 * nobody completes stays `system`, which is the honest answer: something
 * changed this and did not say who.
 */
CREATE OR REPLACE FUNCTION record_card_status_change() RETURNS TRIGGER AS $$
DECLARE v_kind card_event_kind;
BEGIN
    IF NEW.status = OLD.status THEN RETURN NEW; END IF;

    v_kind := CASE NEW.status
        WHEN 'active'     THEN CASE WHEN OLD.status = 'frozen'
                                    THEN 'unfrozen'::card_event_kind
                                    ELSE 'activated'::card_event_kind END
        WHEN 'frozen'     THEN 'frozen'::card_event_kind
        WHEN 'terminated' THEN 'terminated'::card_event_kind
        -- Nothing moves back to 'pending'; the state machine in 003 has no
        -- path to it. A CASE arm that cannot be reached would still have to
        -- produce a value, so this raises instead of inventing one.
        ELSE NULL
    END;

    IF v_kind IS NULL THEN
        RAISE EXCEPTION 'card % moved from % to %, which is not a transition this '
                        'schema describes', OLD.id, OLD.status, NEW.status
            USING ERRCODE = 'restrict_violation';
    END IF;

    INSERT INTO card_events (card_id, kind, actor) VALUES (NEW.id, v_kind, 'system');
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER cards_status_recorded
    BEFORE UPDATE OF status ON cards
    FOR EACH ROW EXECUTE FUNCTION record_card_status_change();

/** Issuing is a status change nothing sees, because the row arrives at
 *  'pending' rather than moving to it. Recorded on INSERT for the same reason
 *  every other transition is recorded: a card's history has to start
 *  somewhere. */
CREATE OR REPLACE FUNCTION record_card_issued() RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO card_events (card_id, kind, actor) VALUES (NEW.id, 'issued', 'system');
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER cards_issued_recorded
    AFTER INSERT ON cards
    FOR EACH ROW EXECUTE FUNCTION record_card_issued();

COMMIT;

BEGIN;

/**
 * The card this one replaces.
 *
 * On the NEW card rather than the old, so the link is written once, at the
 * moment the replacement exists — the old card is already terminated and
 * immutable by then, and 003's trigger would refuse the write.
 */
ALTER TABLE cards ADD COLUMN replaces_card_id BIGINT NULL REFERENCES cards(id);

/** One replacement per card. Two cards both claiming to replace a third is a
 *  history that cannot be read in either direction. */
CREATE UNIQUE INDEX cards_one_replacement ON cards (replaces_card_id)
    WHERE replaces_card_id IS NOT NULL;

/**
 * A replacement must belong to the SAME customer, and may only replace a card
 * that is already terminated.
 *
 * The ownership half is the control: without it a mistyped id makes one
 * customer's new card the stated continuation of another customer's, and the
 * balance that moved between them reads as a transfer nobody made.
 *
 * The termination half is what stops a customer holding two live cards where
 * one is described as the successor of the other — which would leave the
 * leaked number spendable while the record says it was replaced.
 */
CREATE OR REPLACE FUNCTION assert_replacement_is_valid() RETURNS TRIGGER AS $$
DECLARE v_owner BIGINT; v_status card_status;
BEGIN
    IF NEW.replaces_card_id IS NULL THEN RETURN NEW; END IF;

    IF NEW.replaces_card_id = NEW.id THEN
        RAISE EXCEPTION 'a card cannot replace itself'
            USING ERRCODE = 'restrict_violation';
    END IF;

    SELECT user_id, status INTO v_owner, v_status
      FROM cards WHERE id = NEW.replaces_card_id;

    IF v_owner IS DISTINCT FROM NEW.user_id THEN
        RAISE EXCEPTION 'a card can only replace one belonging to the same customer'
            USING ERRCODE = 'restrict_violation';
    END IF;

    IF v_status <> 'terminated' THEN
        RAISE EXCEPTION 'card % is still %; terminate it before issuing its replacement',
            NEW.replaces_card_id, v_status
            USING ERRCODE = 'restrict_violation';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER cards_replacement_is_valid
    BEFORE INSERT OR UPDATE OF replaces_card_id ON cards
    FOR EACH ROW EXECUTE FUNCTION assert_replacement_is_valid();

/**
 * A card's whole life, for the screen support actually looks at.
 *
 * Carries `last4` and never anything more of the number — the same amount 003
 * is willing to store, and for the same reason: a support screen is read over
 * shoulders and screenshotted into tickets.
 */
CREATE VIEW card_history AS
SELECT c.uuid              AS card_id,
       c.user_id,
       u.uuid              AS user_uuid,
       u.email,
       c.last4,
       c.currency,
       c.status::TEXT      AS status,
       c.created_at,
       c.terminated_at,
       prev.uuid           AS replaces_card_id,
       next.uuid           AS replaced_by_card_id,
       (SELECT count(*) FROM card_events e WHERE e.card_id = c.id) AS events
  FROM cards c
  JOIN users u       ON u.id = c.user_id
  LEFT JOIN cards prev ON prev.id = c.replaces_card_id
  LEFT JOIN cards next ON next.replaces_card_id = c.id
 ORDER BY c.created_at DESC;

INSERT INTO retention_decisions (table_name, decision, rationale) VALUES
  ('card_events', 'keep',
   'Who froze, unfroze or terminated a card and when. This is the record '
   'consulted when a customer disputes a charge, and the party with the most '
   'interest in editing it is whoever made the change being asked about.')
ON CONFLICT (table_name) DO NOTHING;

COMMIT;
