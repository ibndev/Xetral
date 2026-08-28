-- ============================================================================
--  018 — Disputes and chargebacks.
--
--  WHAT WAS MISSING. A customer saying "I did not make this transfer" had
--  nowhere to go. There was no claim, no clock, no queue and no record — so
--  the answer depended entirely on which member of staff read the email and
--  what they decided to do about it, and six months later nobody could say
--  what had been decided or when. The CBN's consumer protection framework
--  requires a complaint to be acknowledged and resolved inside a stated
--  window; a process that lives in an inbox cannot demonstrate either.
--
--  WHAT A DISPUTE DOES TO THE MONEY, which is the part worth being careful
--  about:
--
--    Raise     (nothing)                            a claim, not a transaction
--    Accept    expense_dispute_loss -> wallet       we bear it; APPENDED
--    Reject    (nothing)                            no entry ever existed
--    Withdraw  (nothing)                            the customer changed their mind
--
--  RAISING POSTS NOTHING, deliberately. A claim is not a fact about money — it
--  is an assertion about one, and the assertion may be wrong or dishonest.
--  Crediting on the strength of it would make "dispute everything" a free
--  withdrawal, and reversing that credit later would take money from a
--  customer who had by then spent it. The gift card flow makes the same
--  distinction: a submission is an offer, and nothing is posted until a person
--  has approved it.
--
--  THERE IS NO CLAWBACK FROM THE RECIPIENT, and its absence is a decision
--  rather than an omission. A bank can reach into the other side of a fraudulent
--  transfer because both sides are inside one regulated system and a court or
--  the NIBSS process stands behind it. We cannot: the recipient of a disputed
--  transfer is our customer too, the money is very often already gone, and
--  debiting them on our own say-so would overdraw somebody who may have done
--  nothing wrong. That is the same reasoning that stops a gift card clawback
--  once the hold has matured. So an accepted dispute is OUR loss, posted to an
--  expense account where it can be counted — which also means somebody has to
--  look at the number, and a fraud rate nobody can see is a fraud rate nobody
--  manages.
--
--  THE DEADLINE IS THE DATABASE'S CLOCK. `due_at` is computed here, from
--  `now()`, and cannot be supplied by a caller. A deadline the application
--  sets is a deadline a bug can push into next year, and the whole value of
--  this table is that it can answer "what is late?" without trusting the
--  process that created the rows.
-- ============================================================================

-- Outside a transaction, and unusable in the same one. The same rule
-- 013_password_reset.sql, 015_error_events.sql and 017 all record.
ALTER TYPE entry_kind   ADD VALUE IF NOT EXISTS 'dispute_refund';
ALTER TYPE account_kind ADD VALUE IF NOT EXISTS 'expense_dispute_loss';
ALTER TYPE notification_kind ADD VALUE IF NOT EXISTS 'dispute_update';

BEGIN;

-- 'giftcard_reviewer' reviews gift cards; a dispute is a different job with a
-- different risk, so it gets its own role rather than borrowing one. Somebody
-- may hold both — that is a staffing decision, and it should be a decision.
ALTER TYPE staff_role ADD VALUE IF NOT EXISTS 'dispute_reviewer';

COMMIT;

BEGIN;

CREATE TYPE dispute_status AS ENUM (
  'open',       -- raised and acknowledged; being worked
  'accepted',   -- resolved in the customer's favour; a refund was posted
  'rejected',   -- resolved against the customer
  'withdrawn'   -- the customer changed their mind
);

/**
 * Why the customer says the entry is wrong.
 *
 * A closed list rather than free text, because the reason decides how the
 * claim is investigated and what evidence settles it — and because a reason
 * nobody can count is a fraud signal nobody can see. The customer's own words
 * go in `detail`, which is where they belong.
 */
CREATE TYPE dispute_reason AS ENUM (
  'not_authorised',  -- somebody else did this
  'not_received',    -- I paid and nothing arrived
  'wrong_amount',    -- this is not the amount I agreed to
  'duplicate'        -- I was charged twice for one thing
);

CREATE TABLE disputes (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    uuid          UUID           NOT NULL DEFAULT gen_random_uuid() UNIQUE,

    user_id       BIGINT         NOT NULL REFERENCES users(id),

    -- WHAT is disputed. A journal entry, not a free-form description: the
    -- claim has to point at something that actually happened, and the entry is
    -- immutable, so the thing being disputed cannot change underneath the
    -- dispute. A trigger below refuses an entry this customer has no leg in.
    entry_id      BIGINT         NOT NULL REFERENCES journal_entries(id),

    reason        dispute_reason NOT NULL,
    -- The customer's own account, in their words. Bounded, because a text
    -- column with no limit is a place to paste a megabyte.
    detail        TEXT           NOT NULL,

    status        dispute_status NOT NULL DEFAULT 'open',

    raised_at     TIMESTAMPTZ    NOT NULL DEFAULT now(),

    /**
     * When the answer is owed.
     *
     * Set by the DATABASE from `now()`, never supplied. A deadline the
     * application computes is one a bug can push into next year, and the whole
     * point of this column is to answer "what is late?" without trusting the
     * code that wrote the row.
     */
    due_at        TIMESTAMPTZ    NOT NULL,

    resolved_at   TIMESTAMPTZ    NULL,
    resolved_by   BIGINT         NULL REFERENCES users(id),
    -- Why. Required on every resolution by the CHECK below, for the same
    -- reason 009_admin.sql requires a reason on a destructive action: an
    -- outcome with no stated reason is one nobody can review afterwards.
    resolution    TEXT           NULL,

    -- Set if and only if the dispute was accepted. The refund is an ordinary
    -- appended entry; the disputed entry is never touched, because the ledger
    -- is append-only and because it remains a true statement about what
    -- happened whatever we later decide about who should bear it.
    refund_entry_id BIGINT       NULL REFERENCES journal_entries(id),

    CONSTRAINT dispute_detail_is_bounded CHECK (
        length(detail) BETWEEN 1 AND 2000
    ),

    -- An outcome carries its resolution; an open dispute carries none.
    CONSTRAINT dispute_resolution_is_complete CHECK (
        (status = 'open'
           AND resolved_at IS NULL AND resolved_by IS NULL AND resolution IS NULL)
        OR
        (status <> 'open'
           AND resolved_at IS NOT NULL AND resolution IS NOT NULL)
    ),

    -- A refund exists exactly when the dispute was accepted. Without this an
    -- 'accepted' row with no refund is a customer told they won and never
    -- paid, and a 'rejected' row WITH one is money out the door against a
    -- decision that went the other way.
    CONSTRAINT dispute_refund_matches_outcome CHECK (
        (status = 'accepted' AND refund_entry_id IS NOT NULL)
        OR
        (status <> 'accepted' AND refund_entry_id IS NULL)
    ),

    -- A resolution needs a person. `resolved_by` is nullable only so the
    -- column can be absent while open.
    CONSTRAINT dispute_resolver_is_named CHECK (
        status = 'open' OR resolved_by IS NOT NULL
    )
);

/**
 * ONE LIVE DISPUTE PER CUSTOMER PER ENTRY.
 *
 * A partial UNIQUE INDEX rather than an EXCLUDE constraint, because
 * `ON CONFLICT` cannot target an exclusion — the lesson 006_funding.sql
 * recorded when two racing requests for a virtual account got an error instead
 * of one of them reading the other's row.
 *
 * Resolved disputes are excluded, so a customer whose claim was rejected can
 * raise it again with new evidence. That is deliberate: a complaints process
 * that permanently bars a second attempt is one that turns a mistaken refusal
 * into a final one.
 */
CREATE UNIQUE INDEX disputes_one_live_per_entry
    ON disputes (user_id, entry_id) WHERE status = 'open';

CREATE INDEX disputes_queue    ON disputes (due_at) WHERE status = 'open';
CREATE INDEX disputes_by_user  ON disputes (user_id, raised_at DESC);

COMMIT;

BEGIN;

/**
 * How long there is to answer, and how far back a customer may reach.
 *
 * Rows rather than constants, so an operator can tighten the window during an
 * incident without a deploy — the same reasoning as every other limit in
 * `platform_settings`. The bounds are what stop a typo turning the deadline
 * off: 720 hours entered where 72 was meant is refused.
 */
INSERT INTO platform_settings
  (key, value, value_type, min_value, max_value, label, description, category, sensitive)
VALUES
  ('dispute_resolution_hours', '72', 'integer', 1, 720,
   'Hours to resolve a dispute',
   'How long staff have to answer a raised dispute before it is late. The '
   'deadline is stamped on the row by the database when the dispute is '
   'raised, so changing this affects new disputes and never moves an existing '
   'one.',
   'limits', TRUE),

  ('dispute_window_days', '90', 'integer', 1, 365,
   'How far back a customer may dispute',
   'A customer may raise a dispute against an entry up to this many days old. '
   'Long enough to cover a statement somebody reads late, short enough that a '
   'claim can still be investigated with the provider.',
   'limits', TRUE)
ON CONFLICT (key) DO NOTHING;

/**
 * Stamps the deadline, and refuses a claim against somebody else's money.
 *
 * THE OWNERSHIP CHECK IS THE SECURITY CONTROL HERE, and it is a trigger rather
 * than a check in the endpoint for the usual reason: an endpoint is one code
 * path and this is a property of the row. Without it, a customer could raise a
 * dispute against any entry id and learn from the response whether it exists —
 * turning a complaints form into a way to enumerate other people's
 * transactions, and putting a stranger's entry into a queue a member of staff
 * will then go and read.
 *
 * "A leg in the entry" means an account this customer owns was moved by it.
 * That is read from POSTINGS, not from the entry's metadata, for the same
 * reason the transfer velocity rules are: metadata is a blob our own code
 * fills in, and a control that depends on a key some flow remembered to set is
 * a control that switches itself off quietly.
 */
CREATE OR REPLACE FUNCTION assert_disputable() RETURNS TRIGGER AS $$
DECLARE
    v_has_leg    BOOLEAN;
    v_occurred   TIMESTAMPTZ;
    v_window     INT;
    v_hours      INT;
BEGIN
    SELECT EXISTS (
        SELECT 1
          FROM postings p
          JOIN accounts a ON a.id = p.account_id
         WHERE p.journal_entry_id = NEW.entry_id
           AND a.owner_type = 'user'
           AND a.owner_id   = NEW.user_id
    ) INTO v_has_leg;

    IF NOT v_has_leg THEN
        RAISE EXCEPTION 'entry % does not belong to user %', NEW.entry_id, NEW.user_id
            USING ERRCODE = 'check_violation';
    END IF;

    SELECT occurred_at INTO v_occurred FROM journal_entries WHERE id = NEW.entry_id;

    SELECT value::INT INTO v_window
      FROM platform_settings WHERE key = 'dispute_window_days';
    -- A missing row means the migration did not run. Refusing is the safe
    -- direction: a dispute window defaulting to infinity would let a claim be
    -- raised against a five-year-old entry no provider will still discuss.
    IF v_window IS NULL THEN
        RAISE EXCEPTION 'dispute_window_days is not configured'
            USING ERRCODE = 'check_violation';
    END IF;

    IF v_occurred < now() - make_interval(days => v_window) THEN
        RAISE EXCEPTION 'entry % is older than the % day dispute window',
              NEW.entry_id, v_window
            USING ERRCODE = 'check_violation';
    END IF;

    SELECT value::INT INTO v_hours
      FROM platform_settings WHERE key = 'dispute_resolution_hours';
    IF v_hours IS NULL THEN
        RAISE EXCEPTION 'dispute_resolution_hours is not configured'
            USING ERRCODE = 'check_violation';
    END IF;

    -- Stamped here, from the database's clock, whatever the caller supplied.
    NEW.due_at := now() + make_interval(hours => v_hours);
    NEW.raised_at := now();

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER disputes_are_disputable
    BEFORE INSERT ON disputes
    FOR EACH ROW EXECUTE FUNCTION assert_disputable();

/**
 * The state machine.
 *
 * AN OUTCOME IS FINAL, by trigger. Reopening an accepted dispute would let a
 * refund be paid twice; reopening a rejected one in place would erase the fact
 * that it was ever refused. A customer with new evidence raises a NEW dispute,
 * which the partial unique index above deliberately permits — and the two rows
 * then tell the whole story rather than the last edit of it.
 *
 * The identity of the claim is immutable too: who raised it, against what, and
 * why. Re-pointing a dispute at a different entry after it was raised would
 * make every note written about it a note about something else.
 */
CREATE OR REPLACE FUNCTION assert_dispute_transition() RETURNS TRIGGER AS $$
BEGIN
    IF OLD.status <> 'open' THEN
        RAISE EXCEPTION 'dispute % is already % and cannot be changed', OLD.id, OLD.status
            USING ERRCODE = 'check_violation';
    END IF;

    IF NEW.user_id  IS DISTINCT FROM OLD.user_id
       OR NEW.entry_id IS DISTINCT FROM OLD.entry_id
       OR NEW.reason   IS DISTINCT FROM OLD.reason
       OR NEW.raised_at IS DISTINCT FROM OLD.raised_at THEN
        RAISE EXCEPTION 'a dispute''s identity is immutable'
            USING ERRCODE = 'check_violation';
    END IF;

    -- The deadline cannot be moved either. A dispute that is late is late; a
    -- process that can push its own deadline out has no deadline.
    IF NEW.due_at IS DISTINCT FROM OLD.due_at THEN
        RAISE EXCEPTION 'a dispute''s deadline cannot be moved'
            USING ERRCODE = 'check_violation';
    END IF;

    -- The refund must be a real refund for this customer. A stale or
    -- mistyped entry id here would mark a dispute paid against somebody
    -- else's entry, and the CHECK above only knows that the column is set.
    IF NEW.status = 'accepted' THEN
        IF NOT EXISTS (
            SELECT 1
              FROM journal_entries e
              JOIN postings p ON p.journal_entry_id = e.id
              JOIN accounts a ON a.id = p.account_id
             WHERE e.id = NEW.refund_entry_id
               AND e.kind = 'dispute_refund'
               AND a.owner_type = 'user'
               AND a.owner_id   = NEW.user_id
               AND p.amount_minor > 0
        ) THEN
            RAISE EXCEPTION 'entry % is not a dispute refund crediting user %',
                  NEW.refund_entry_id, NEW.user_id
                USING ERRCODE = 'check_violation';
        END IF;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER disputes_state_machine
    BEFORE UPDATE ON disputes
    FOR EACH ROW EXECUTE FUNCTION assert_dispute_transition();

/** A dispute is never deleted. A complaints record that can be removed is one
 *  that says whatever the last person with access wanted it to say — the same
 *  rule the audit log follows. */
CREATE OR REPLACE FUNCTION refuse_dispute_delete() RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'disputes are append-only; resolve one, never delete it'
        USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER disputes_no_delete
    BEFORE DELETE ON disputes
    EXECUTE FUNCTION refuse_dispute_delete();

/**
 * The work queue, and the thing an operator reads first.
 *
 * `overdue` is computed from the database clock rather than stored, so a row
 * cannot be late in the table and on time on the screen.
 */
CREATE VIEW disputes_open AS
SELECT d.uuid,
       d.user_id,
       u.email,
       d.reason,
       d.detail,
       d.raised_at,
       d.due_at,
       now() > d.due_at                                    AS overdue,
       EXTRACT(EPOCH FROM (d.due_at - now()))::BIGINT      AS seconds_remaining,
       e.uuid                                              AS entry_uuid,
       e.kind::text                                        AS entry_kind
  FROM disputes d
  JOIN users u           ON u.id = d.user_id
  JOIN journal_entries e ON e.id = d.entry_id
 WHERE d.status = 'open'
 -- Oldest deadline first. A queue ordered by when it arrived buries the one
 -- that is about to breach behind the ones that are not.
 ORDER BY d.due_at;

/** What accepting disputes has cost, which is the number that says whether the
 *  fraud controls are working. A loss rate nobody can see is one nobody
 *  manages. */
CREATE VIEW dispute_losses AS
SELECT date_trunc('month', d.resolved_at) AS month,
       a.currency,
       count(*)                           AS accepted,
       SUM(p.amount_minor)                AS refunded_minor
  FROM disputes d
  JOIN postings p ON p.journal_entry_id = d.refund_entry_id AND p.amount_minor > 0
  JOIN accounts a ON a.id = p.account_id
 WHERE d.status = 'accepted'
 GROUP BY 1, 2
 ORDER BY 1 DESC, 2;

COMMIT;
