-- ============================================================================
--  028 — The case file.
--
--  WHAT WAS MISSING. 027 produces signals, and a signal is about ONE
--  transaction. A reviewer looking at a customer with five of them has one
--  story and five rows, and the only thing they can do is close each
--  separately with the same sentence typed five times — which produces a
--  record that says five unrelated things were reviewed rather than that one
--  investigation happened. There was also nowhere at all to write down what
--  was found on the way to a decision.
--
--  A CASE IS ONE INVESTIGATION ABOUT ONE CUSTOMER. Signals attach to it, notes
--  accumulate on it, and closing it resolves everything attached in one act —
--  which is the ergonomic point and also the honest one: the reviewer looked
--  at the set and decided about the set.
--
--  TIPPING OFF IS AN OFFENCE, and it shapes this schema. Where a case ends in
--  a report to the NFIU, the customer must not learn that — not from an email,
--  not from a status on a screen, not from a support agent reading a note. So
--  nothing here has a customer-facing surface: there is no endpoint that
--  returns a case to its subject, no notification kind, and the outcome is
--  never reflected in anything the customer can see. Freezing an account is a
--  separate, visible act taken for its own stated reason.
--
--  THE DISPUTE SCHEMA IS THE MODEL, deliberately, because the shape is the
--  same: a deadline the database owns, an outcome that is final, and new
--  information raising a NEW case rather than reopening a closed one.
-- ============================================================================

BEGIN;

CREATE TYPE risk_case_status AS ENUM ('open', 'closed');

CREATE TYPE risk_case_outcome AS ENUM (
    /** Looked at, explained, nothing to do. */
    'no_action',
    /** A Suspicious Transaction Report was filed. Requires its reference. */
    'reported',
    /** The account was restricted or closed, as its own recorded action. */
    'account_restricted'
);

CREATE TABLE risk_cases (
    id           BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    uuid         UUID        NOT NULL DEFAULT gen_random_uuid(),
    user_id      BIGINT      NOT NULL REFERENCES users(id),

    /** Why it was opened, in the opener's words. NULL when the sweep opened it
     *  — it says so in `opened_by` being NULL, which is a fact rather than a
     *  gap. */
    reason       TEXT        NULL,

    status       risk_case_status NOT NULL DEFAULT 'open',

    /** NULL when the monitoring sweep opened it because a customer accrued
     *  enough signals to be a pattern rather than a transaction. */
    opened_by    BIGINT      NULL REFERENCES users(id),
    opened_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

    /**
     * When this has to be decided by.
     *
     * The DATABASE's clock, and it cannot be supplied or moved — the same rule
     * `018_disputes.sql` applies, and for the same reason: a process that can
     * push its own deadline out has no deadline. A regulator's reporting
     * window is not something a busy afternoon may extend.
     */
    due_at       TIMESTAMPTZ NOT NULL,

    outcome      risk_case_outcome NULL,
    /** What was found and why it ended this way. Becomes the resolution on
     *  every signal attached, so it has to say something. */
    summary      TEXT        NULL,
    /** The STR's reference at the regulator. A report nobody can point at is
     *  one nobody can prove was filed. */
    report_reference TEXT    NULL,
    closed_by    BIGINT      NULL REFERENCES users(id),
    closed_at    TIMESTAMPTZ NULL,

    CONSTRAINT risk_cases_uuid_key UNIQUE (uuid),

    CONSTRAINT risk_case_closure_is_complete CHECK (
        (status = 'open') = (closed_at IS NULL)
        AND (closed_at IS NULL) = (closed_by IS NULL)
        AND (closed_at IS NULL) = (outcome IS NULL)
        AND (closed_at IS NULL) = (summary IS NULL)
    ),

    -- An STR with no reference is a claim rather than a record.
    CONSTRAINT reported_cases_carry_a_reference CHECK (
        outcome IS DISTINCT FROM 'reported' OR report_reference IS NOT NULL
    ),

    -- "Reviewed" is not a summary. The same reasoning as the resolution length
    -- on a signal: a file closed with one word is indistinguishable from one
    -- nobody worked, and this text is what a regulator reads.
    CONSTRAINT risk_case_summary_says_something CHECK (
        summary IS NULL OR length(trim(summary)) >= 20
    )
);

/**
 * ONE OPEN CASE PER CUSTOMER.
 *
 * Two reviewers investigating the same person separately, each seeing half the
 * signals, is precisely the failure a case file exists to prevent — and it is
 * also what makes "attach this signal" unambiguous. Closed ones accumulate as
 * history, so a customer investigated three times has three files rather than
 * one that was edited.
 */
CREATE UNIQUE INDEX risk_cases_one_open_per_user
    ON risk_cases (user_id) WHERE status = 'open';

CREATE INDEX risk_cases_queue ON risk_cases (due_at) WHERE status = 'open';

/**
 * The deadline is set here, from the database's clock and a setting, and
 * cannot be supplied by a caller.
 */
CREATE OR REPLACE FUNCTION set_risk_case_deadline() RETURNS TRIGGER AS $$
DECLARE v_hours INT;
BEGIN
    SELECT value::INT INTO v_hours FROM platform_settings
     WHERE key = 'risk_case_deadline_hours';
    IF v_hours IS NULL THEN
        RAISE EXCEPTION 'risk_case_deadline_hours is not configured; refusing to open a case '
                        'with no deadline';
    END IF;
    NEW.due_at := now() + make_interval(hours => v_hours);
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER risk_cases_deadline
    BEFORE INSERT ON risk_cases
    FOR EACH ROW EXECUTE FUNCTION set_risk_case_deadline();

/**
 * A closed case is final, and what it recorded is immutable.
 *
 * New information raises a NEW case — the same line `018_disputes.sql` draws.
 * Reopening one in place would erase that somebody looked and decided, which
 * is the only part of this a regulator can inspect.
 */
CREATE OR REPLACE FUNCTION assert_risk_case_transition() RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'a risk case cannot be deleted'
            USING ERRCODE = 'restrict_violation';
    END IF;

    IF OLD.status = 'closed' THEN
        RAISE EXCEPTION 'risk case % is closed; new information opens a new case', OLD.uuid
            USING ERRCODE = 'restrict_violation';
    END IF;

    IF NEW.user_id <> OLD.user_id OR NEW.opened_at <> OLD.opened_at
       OR NEW.due_at <> OLD.due_at THEN
        RAISE EXCEPTION 'a case''s subject, opening and deadline are immutable'
            USING ERRCODE = 'restrict_violation';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER risk_cases_transition
    BEFORE UPDATE OR DELETE ON risk_cases
    FOR EACH ROW EXECUTE FUNCTION assert_risk_case_transition();

COMMIT;

BEGIN;

/**
 * What a reviewer found on the way to a decision.
 *
 * Append-only, like every other trail here: a note somebody can edit tells you
 * what the last person with access wanted you to believe, and this is a file a
 * regulator may read years later.
 *
 * Notes cannot be added to a CLOSED case. That is not tidiness — it is the
 * same line the outcome draws. A closed file plus later notes is a file that
 * was decided on one set of facts and now reads as though it was decided on
 * another; new information opens a new case.
 */
CREATE TABLE risk_case_notes (
    id         BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    case_id    BIGINT      NOT NULL REFERENCES risk_cases(id),
    author_id  BIGINT      NOT NULL REFERENCES users(id),
    note       TEXT        NOT NULL CHECK (length(trim(note)) >= 3),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX risk_case_notes_case ON risk_case_notes (case_id, created_at);

CREATE OR REPLACE FUNCTION refuse_risk_case_note_change() RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'a case note is append-only; % is refused', TG_OP
        USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER risk_case_notes_append_only
    BEFORE UPDATE OR DELETE ON risk_case_notes
    FOR EACH ROW EXECUTE FUNCTION refuse_risk_case_note_change();

CREATE OR REPLACE FUNCTION assert_case_is_open_for_notes() RETURNS TRIGGER AS $$
BEGIN
    IF (SELECT status FROM risk_cases WHERE id = NEW.case_id) = 'closed' THEN
        RAISE EXCEPTION 'case is closed; new information opens a new case'
            USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER risk_case_notes_only_while_open
    BEFORE INSERT ON risk_case_notes
    FOR EACH ROW EXECUTE FUNCTION assert_case_is_open_for_notes();

/**
 * Which signals this case is about.
 *
 * A JOIN TABLE rather than a `case_id` column on `risk_signals`, and that is
 * the point rather than a preference. A signal records what a rule saw and 027
 * makes it immutable; adding a column would mean relaxing that trigger to
 * permit a write, and "immutable except for the fields we later needed to
 * change" is how immutability stops being a property. The association is its
 * own fact, with its own author and its own timestamp.
 *
 * UNIQUE on the signal: one transaction belongs to at most one investigation,
 * so "which case covers this?" has one answer.
 */
CREATE TABLE risk_case_signals (
    case_id     BIGINT      NOT NULL REFERENCES risk_cases(id),
    signal_id   BIGINT      NOT NULL REFERENCES risk_signals(id),
    attached_by BIGINT      NULL REFERENCES users(id),
    attached_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    PRIMARY KEY (case_id, signal_id),
    CONSTRAINT risk_case_signals_one_case UNIQUE (signal_id)
);

/**
 * A signal may only be attached to a case about the SAME customer.
 *
 * The same control `018_disputes.sql` applies to an entry, and the same
 * failure without it: a mistyped id attaches one customer's transaction to
 * another customer's investigation, and the case file then describes somebody
 * who was never involved. Enforced here rather than in the endpoint, because
 * the endpoint is one code path and this is a property of the row.
 */
CREATE OR REPLACE FUNCTION assert_signal_belongs_to_case_subject() RETURNS TRIGGER AS $$
DECLARE v_case_user BIGINT; v_signal_user BIGINT; v_status risk_case_status;
BEGIN
    SELECT user_id, status INTO v_case_user, v_status
      FROM risk_cases WHERE id = NEW.case_id;
    SELECT user_id INTO v_signal_user FROM risk_signals WHERE id = NEW.signal_id;

    IF v_status = 'closed' THEN
        RAISE EXCEPTION 'case is closed; it cannot take on new signals'
            USING ERRCODE = 'restrict_violation';
    END IF;

    IF v_case_user IS DISTINCT FROM v_signal_user THEN
        RAISE EXCEPTION 'signal belongs to a different customer than this case'
            USING ERRCODE = 'restrict_violation';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER risk_case_signals_same_customer
    BEFORE INSERT ON risk_case_signals
    FOR EACH ROW EXECUTE FUNCTION assert_signal_belongs_to_case_subject();

/**
 * Closing a case resolves every signal attached to it.
 *
 * THIS IS THE WHOLE POINT OF A CASE FILE. A reviewer with five signals and one
 * story should say it once — and the alternative is five separately typed
 * resolutions, which produces a record claiming five unrelated reviews
 * happened. The summary becomes each signal's resolution, so the trail still
 * says why each was closed and says the same true thing about all of them.
 *
 * By TRIGGER rather than by the endpoint, so a case cannot be closed with its
 * signals left open by any path — including a psql prompt. Signals a reviewer
 * resolved individually before closing are left alone: 027's own trigger
 * refuses re-resolving, and re-writing somebody's stated reason would be the
 * edit that rule exists to prevent.
 */
CREATE OR REPLACE FUNCTION resolve_signals_with_case() RETURNS TRIGGER AS $$
BEGIN
    IF NEW.status = 'closed' AND OLD.status <> 'closed' THEN
        UPDATE risk_signals s
           SET resolved_at = now(),
               resolved_by = NEW.closed_by,
               resolution  = 'case ' || NEW.uuid || ': ' || NEW.summary
          FROM risk_case_signals l
         WHERE l.signal_id = s.id
           AND l.case_id = NEW.id
           AND s.resolved_at IS NULL;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER risk_cases_close_signals
    AFTER UPDATE ON risk_cases
    FOR EACH ROW EXECUTE FUNCTION resolve_signals_with_case();

INSERT INTO platform_settings
  (key, value, value_type, min_value, max_value, label, description, category, sensitive)
VALUES
  ('risk_case_deadline_hours', '72', 'integer', 1, 720,
   'Decide a case within (hours)',
   'How long a compliance case may stay open before it is overdue. CONFIRM '
   'THIS AGAINST THE CURRENT NFIU REPORTING WINDOW: the figure here is a '
   'working default, and a reporting obligation missed because a queue was '
   'busy is not an excuse anybody accepts.',
   'risk', TRUE),

  ('risk_case_auto_open_signals', '3', 'integer', 2, 50,
   'Signals that open a case by themselves',
   'How many open signals one customer must have before the monitoring sweep '
   'opens a case without being asked. One signal is a transaction; several is '
   'a pattern, and a pattern sitting in a queue as separate rows is what '
   'nobody notices.',
   'risk', TRUE)
ON CONFLICT (key) DO NOTHING;

/** The case queue, oldest deadline first, with what a reviewer needs to
 *  triage without opening each one. */
CREATE VIEW risk_cases_open AS
SELECT c.uuid, c.user_id, u.uuid AS user_uuid, u.email,
       u.status::TEXT AS user_status,
       c.reason, c.opened_at, c.due_at,
       (c.due_at < now())                         AS overdue,
       (c.opened_by IS NULL)                      AS opened_by_the_sweep,
       opener.email                               AS opened_by_email,
       (SELECT count(*) FROM risk_case_signals l WHERE l.case_id = c.id) AS signals,
       (SELECT count(*) FROM risk_case_notes n   WHERE n.case_id = c.id) AS notes
  FROM risk_cases c
  JOIN users u          ON u.id = c.user_id
  LEFT JOIN users opener ON opener.id = c.opened_by
 WHERE c.status = 'open'
 ORDER BY c.due_at;

INSERT INTO retention_decisions (table_name, decision, rationale) VALUES
  ('risk_cases', 'keep',
   'The AML investigation record: what was looked at, by whom, and what was '
   'decided. This is the file a regulator asks for, and the years it must '
   'cover are exactly the years a retention sweep would delete.'),
  ('risk_case_notes', 'keep',
   'What a reviewer found on the way to a decision. Append-only for the same '
   'reason the audit log is, and kept for as long as the case it belongs to.'),
  ('risk_case_signals', 'derive',
   'Which transactions an investigation covered. It has no independent '
   'lifetime; it goes when the case and the signals do, which is never.')
ON CONFLICT (table_name) DO NOTHING;

COMMIT;

BEGIN;

/**
 * Opens a case for any customer whose open signals have become a pattern, and
 * attaches them.
 *
 * WHY THE SWEEP AND NOT A REVIEWER. A customer with five signals in the queue
 * is already a pattern; noticing it requires somebody to sort the queue by
 * customer and count, which is exactly the work nobody does at four in the
 * afternoon. A case opening itself is what turns five rows into one thing
 * somebody has to decide about, with a deadline attached.
 *
 * `opened_by` is NULL, and that is a fact rather than a gap: the queue shows
 * "opened by the sweep", which tells a reviewer this was noticed by counting
 * rather than by judgement — a different starting point.
 *
 * Signals already attached to another case are left alone. A customer can only
 * have one open case, so in practice that means signals from a closed
 * investigation stay with it; re-attaching them would rewrite what that file
 * covered.
 */
CREATE OR REPLACE FUNCTION open_risk_cases_for_patterns()
RETURNS TABLE (opened BIGINT, attached BIGINT) AS $$
DECLARE
    v_threshold INT;
    v_opened    BIGINT := 0;
    v_attached  BIGINT := 0;
    v_batch     BIGINT;
    v_user      BIGINT;
    v_case      BIGINT;
BEGIN
    SELECT value::INT INTO v_threshold FROM platform_settings
     WHERE key = 'risk_case_auto_open_signals';
    IF v_threshold IS NULL THEN
        RAISE EXCEPTION 'risk_case_auto_open_signals is not configured';
    END IF;

    FOR v_user IN
        SELECT s.user_id
          FROM risk_signals s
          LEFT JOIN risk_case_signals l ON l.signal_id = s.id
         WHERE s.resolved_at IS NULL AND l.signal_id IS NULL
         GROUP BY s.user_id
        HAVING count(*) >= v_threshold
           -- Not while one is already open. A second case about the same
           -- customer is the split investigation the unique index refuses
           -- anyway; skipping here means the sweep does not spend every pass
           -- raising the same constraint violation.
           AND NOT EXISTS (
             SELECT 1 FROM risk_cases c
              WHERE c.user_id = s.user_id AND c.status = 'open'
           )
    LOOP
        INSERT INTO risk_cases (user_id, reason, due_at)
        VALUES (v_user,
                'opened automatically: ' || v_threshold ||
                ' or more open signals on one customer',
                -- Overwritten by the deadline trigger. Supplied only because
                -- the column is NOT NULL, and the trigger is what makes the
                -- value the database's rather than a caller's.
                now())
        RETURNING id INTO v_case;
        v_opened := v_opened + 1;

        INSERT INTO risk_case_signals (case_id, signal_id)
        SELECT v_case, s.id
          FROM risk_signals s
          LEFT JOIN risk_case_signals l ON l.signal_id = s.id
         WHERE s.user_id = v_user AND s.resolved_at IS NULL AND l.signal_id IS NULL;
        -- Accumulated, not assigned. The first version of this wrote
        -- `v_attached = ROW_COUNT` inside the loop, so the report described
        -- the last customer rather than the pass — a count that is wrong only
        -- when more than one case opens, which is exactly when somebody reads
        -- it.
        GET DIAGNOSTICS v_batch = ROW_COUNT;
        v_attached := v_attached + v_batch;
    END LOOP;

    RETURN QUERY SELECT v_opened, v_attached;
END;
$$ LANGUAGE plpgsql;

COMMIT;
