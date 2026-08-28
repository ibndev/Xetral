-- ============================================================================
--  034 — A customer's right to their data, and to have it erased.
--
--  WHAT WAS MISSING. The privacy notice tells customers they can ask for a
--  copy of their data and ask for it to be erased. There was no way to do
--  either. A notice describing rights nothing implements is worse than one
--  that promises less: it is a commitment already being broken, in writing,
--  on a page a regulator will read first.
--
--  TWO LAWS PULL OPPOSITE WAYS, and this file is where they meet. 019 records
--  the same tension for retention: AML requires records of a relationship for
--  five years after it ends, and the NDPA forbids keeping personal data
--  longer than needed. So an erasure request CANNOT simply be granted, and
--  the wrong ways to handle that are both easy:
--
--    Grant it fully — and delete the financial record a regulator can demand
--    for five years, from a table 011 makes append-only for exactly that
--    reason.
--
--    Refuse it fully — and treat a legal right as an inconvenience, which is
--    the version that produces a finding.
--
--  So an erasure request is a REQUEST: what can lawfully go, goes; what must
--  be kept is NAMED, with the date it stops being kept. And the answer to
--  "what can go" is computed from `retention_decisions` — the same table the
--  deletion sweep reads — so the promise made to a customer and the job that
--  keeps it cannot describe different systems.
--
--  AN EXPORT IS A BEARER DOCUMENT the moment it is downloaded, which is why
--  the service assembling one names every column and why nothing secret is in
--  it. That belongs in the code; what belongs here is the record that it was
--  asked for and answered, because "we responded within the statutory window"
--  is a claim somebody has to be able to check.
-- ============================================================================

BEGIN;

CREATE TYPE data_request_kind AS ENUM ('export', 'erasure');

CREATE TYPE data_request_status AS ENUM ('open', 'completed', 'refused');

CREATE TABLE data_requests (
    id            BIGINT              GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    uuid          UUID                NOT NULL DEFAULT gen_random_uuid() UNIQUE,
    user_id       BIGINT              NOT NULL REFERENCES users(id),
    kind          data_request_kind   NOT NULL,
    status        data_request_status NOT NULL DEFAULT 'open',

    requested_at  TIMESTAMPTZ         NOT NULL DEFAULT now(),

    /** THE DATABASE'S CLOCK, and it cannot be supplied or moved — the rule 018
     *  applies to a dispute deadline and 028 to a reporting one. A process
     *  that can push its own deadline out has no deadline, and this one is a
     *  statutory window rather than a courtesy. */
    deadline_at   TIMESTAMPTZ         NOT NULL,

    completed_at  TIMESTAMPTZ,
    handled_by    BIGINT              REFERENCES users(id),

    /** What was actually done, in words a customer receives. For an erasure
     *  this is where "we deleted X and must keep Y until Z" is written down,
     *  which is the only part of the answer a regulator can inspect. */
    outcome       TEXT,

    CONSTRAINT data_request_outcome_is_explained
        CHECK (status = 'open' OR (outcome IS NOT NULL AND length(outcome) >= 20)),
    CONSTRAINT data_request_resolution_has_a_time
        CHECK ((status = 'open') = (completed_at IS NULL))
);

/** One open request of each kind per customer. A second is not a second
 *  right; it is the same right asked about twice, and answering them
 *  separately produces a record claiming two reviews happened. */
CREATE UNIQUE INDEX data_requests_one_open_per_kind
    ON data_requests (user_id, kind) WHERE status = 'open';

CREATE INDEX data_requests_by_deadline ON data_requests (deadline_at) WHERE status = 'open';

/**
 * The deadline is set here, never by the caller.
 *
 * `data_request_response_days` is a setting so an operator can tighten it,
 * and deliberately NOT so they can loosen it past what the law allows — the
 * CHECK on the setting is what makes that true.
 */
CREATE OR REPLACE FUNCTION set_data_request_deadline() RETURNS TRIGGER AS $$
DECLARE v_days INT;
BEGIN
    SELECT value::INT INTO v_days FROM platform_settings
     WHERE key = 'data_request_response_days';
    NEW.deadline_at := now() + make_interval(days => COALESCE(v_days, 30));
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER data_requests_deadline_is_ours
    BEFORE INSERT ON data_requests
    FOR EACH ROW EXECUTE FUNCTION set_data_request_deadline();

/**
 * An outcome is final, and a deadline cannot move.
 *
 * Reopening a completed erasure would describe a second review of a decision
 * already acted on — and the acting half deleted data, so there is nothing to
 * review. A new request is a new row.
 */
CREATE OR REPLACE FUNCTION guard_data_request_change() RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'a data request cannot be deleted'
            USING ERRCODE = 'restrict_violation';
    END IF;

    IF OLD.status <> 'open' THEN
        RAISE EXCEPTION 'request % is already %; open a new one', OLD.uuid, OLD.status
            USING ERRCODE = 'restrict_violation';
    END IF;

    IF ROW(NEW.user_id, NEW.kind, NEW.requested_at, NEW.deadline_at)
       IS DISTINCT FROM
       ROW(OLD.user_id, OLD.kind, OLD.requested_at, OLD.deadline_at)
    THEN
        RAISE EXCEPTION 'who asked, for what, and by when are all immutable'
            USING ERRCODE = 'restrict_violation';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER data_requests_resolve_once
    BEFORE UPDATE OR DELETE ON data_requests
    FOR EACH ROW EXECUTE FUNCTION guard_data_request_change();

INSERT INTO platform_settings
  (key, value, value_type, min_value, max_value, label, description, category, sensitive)
VALUES
  ('data_request_response_days', '30', 'integer', 1, 30,
   'Days to answer a data request',
   'The NDPA allows one month. The maximum here is 30 and NOT higher, so this '
   'setting can only be used to answer faster — a deadline an operator can '
   'extend is not a deadline. Confirm against current NDPC guidance.',
   'compliance', FALSE)
ON CONFLICT (key) DO NOTHING;

COMMIT;

BEGIN;

/**
 * What an erasure request can and cannot reach.
 *
 * COMPUTED FROM `retention_decisions`, which is the point rather than a
 * convenience: the promise made to a customer and the sweep that keeps it
 * then cannot describe different systems. A hand-written list here would be a
 * second opinion about the same schema, and the one that drifts is the one
 * quoted in a letter.
 *
 * `keep` is not "we would rather not"; it is a table whose rationale states
 * why the record has to outlive the relationship, and that rationale is what
 * the customer is told.
 *
 * `derive` IS NOT ERASABLE, and the first version of this view said it was.
 * A derived table has no independent lifetime — it goes when its parent goes
 * — so its fate is its parent's, and every parent here is `keep`. Reading it
 * as erasable would have promised a customer that `account_balances` could be
 * deleted, which is the ledger restated and append-only for that reason.
 *
 * This describes the SCHEMA'S disposition, not what one request deletes:
 * `erase_customer_personal_data` names the rows it touches, because a
 * deletion driven by a table this view returns would be a deletion job whose
 * behaviour is changed by an INSERT — the reason `apply_retention()` contains
 * no dynamic SQL either.
 */
CREATE VIEW erasure_scope AS
SELECT d.table_name,
       CASE d.decision
         WHEN 'purge'  THEN 'erasable'
         WHEN 'derive' THEN 'follows_parent'
         ELSE 'retained'
       END AS scope,
       d.rationale
  FROM retention_decisions d
 ORDER BY 1;

/**
 * Requests nobody has answered yet, worst first.
 *
 * A statutory window is one of the few deadlines here that produces a
 * regulatory consequence rather than an unhappy customer, so this is ordered
 * by how close it is rather than by when it arrived.
 */
CREATE VIEW data_requests_due AS
SELECT r.uuid, r.kind::TEXT AS kind, r.requested_at, r.deadline_at,
       u.uuid AS user_uuid, u.email,
       r.deadline_at < now() AS overdue
  FROM data_requests r
  JOIN users u ON u.id = r.user_id
 WHERE r.status = 'open'
 ORDER BY r.deadline_at;

/**
 * Erases what can lawfully go, and reports what stayed.
 *
 * REFUSES OUTRIGHT while the customer still has money here or is under
 * investigation, and both refusals are the interesting part:
 *
 *   A BALANCE is money we owe them. Erasing the person we owe it to does not
 *   discharge the debt, it loses the creditor — so the account is emptied
 *   first, which is a payment with its own path and its own PIN.
 *
 *   AN OPEN CASE is an obligation to a regulator that outranks the request,
 *   and 028 forbids telling the customer it exists. So the refusal is
 *   deliberately the same one a balance produces: a customer cannot learn
 *   from the difference that they are being investigated.
 *
 * What it does NOT do is touch the ledger. `journal_entries` and `postings`
 * are append-only by trigger and named `keep` here, and a function that could
 * delete them would be a function an intruder could use to erase what they
 * did.
 */
CREATE OR REPLACE FUNCTION erase_customer_personal_data(p_user_id BIGINT)
RETURNS TEXT AS $$
DECLARE
    v_balance BIGINT;
    v_cases   INT;
    v_erased  TEXT[] := ARRAY[]::TEXT[];
    v_n       INT;
BEGIN
    SELECT COALESCE(sum(b.balance_minor), 0) INTO v_balance
      FROM accounts a JOIN account_balances b ON b.account_id = a.id
     WHERE a.owner_id = p_user_id
       AND a.kind IN ('customer_wallet', 'customer_card', 'customer_pending');

    IF v_balance <> 0 THEN
        RAISE EXCEPTION 'cannot erase a customer with a balance'
            USING ERRCODE = 'restrict_violation';
    END IF;

    SELECT count(*) INTO v_cases FROM risk_cases
     WHERE user_id = p_user_id AND status = 'open';
    IF v_cases > 0 THEN
        -- DELIBERATELY THE SAME MESSAGE. Tipping off is an offence, and a
        -- distinguishable refusal is a way to learn you are under review.
        RAISE EXCEPTION 'cannot erase a customer with a balance'
            USING ERRCODE = 'restrict_violation';
    END IF;

    -- Devices, sessions and biometrics: how they signed in, which is of no
    -- use to anybody once they no longer can.
    DELETE FROM biometric_enrollments WHERE user_id = p_user_id;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n > 0 THEN v_erased := v_erased || 'biometric enrolments'::TEXT; END IF;

    DELETE FROM refresh_tokens WHERE session_id IN (
        SELECT id FROM auth_sessions WHERE user_id = p_user_id);
    DELETE FROM password_reset_tokens WHERE user_id = p_user_id;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n > 0 THEN v_erased := v_erased || 'password reset tokens'::TEXT; END IF;

    /* SIGN-IN HISTORY IS NOT DELETED HERE, and 019's trigger is what said so
       — it refuses a DELETE of a row still inside the retention window,
       because that table is the record somebody reads to reconstruct an
       incident, and a trail an intruder can prune is not a trail.

       The right answer is not to relax that trigger for this path. It is that
       sign-in events are `purge`: they DO age out, on a period the customer
       can be told. So this is a case of "we must keep X until Z" rather than
       a refusal, which is the shape of this whole feature — and the erasure
       outcome names it. Deleting it here would also mean an erasure request
       could be used to erase the evidence of a takeover, by the person who
       committed it. */

    -- The login credential itself. Nothing can be signed into afterwards,
    -- which is what closing the account means.
    DELETE FROM transaction_pins WHERE user_id = p_user_id;
    DELETE FROM user_credentials WHERE user_id = p_user_id;
    v_erased := v_erased || 'sign-in credentials'::TEXT;

    -- Revoking a device revokes its live sessions, by 002's own trigger. So
    -- this is the whole sign-out rather than half of one, and it is deliberately
    -- not a DELETE: `devices` is `keep`, because which hardware an account was
    -- used from is part of reconstructing an incident.
    UPDATE devices SET status = 'revoked' WHERE user_id = p_user_id AND status <> 'revoked';

    /* The email address, which is the identifier everything else was found
       by. Replaced rather than nulled: `users.email` is how a duplicate
       account is refused, and a null would let the same address open a second
       one while the first is still on record. The tombstone is derived from
       the uuid, which is already in the ledger's metadata and reveals
       nothing. */
    UPDATE users
       SET email = 'erased+' || uuid || '@invalid',
           status = 'closed'
     WHERE id = p_user_id;
    v_erased := v_erased || 'email address'::TEXT;

    RETURN array_to_string(v_erased, ', ');
END;
$$ LANGUAGE plpgsql;

/*
 * ERASING SOMEBODY'S DATA IS DESTRUCTIVE, so it joins the actions 009 requires
 * a reason for. That list is what stands between a privileged action and a log
 * saying only that it happened — and this is the one action here that cannot
 * be undone by appending, so it is the last one that should be exempt.
 *
 * The reason recorded is the OUTCOME: what went and what had to stay. Anything
 * shorter would be a note to ourselves rather than the answer a customer was
 * given.
 */
ALTER TABLE admin_audit_log DROP CONSTRAINT destructive_actions_say_why;
ALTER TABLE admin_audit_log ADD CONSTRAINT destructive_actions_say_why CHECK (
    action NOT IN ('user.freeze', 'user.close', 'deposit.return', 'giftcard.clawback',
                   'data.erase')
    OR reason IS NOT NULL
);

INSERT INTO retention_decisions (table_name, decision, rationale) VALUES
  ('data_requests', 'keep',
   'That a right was exercised and answered within the statutory window. The '
   'evidence of having complied has to outlive the request, and an erasure '
   'request is the one record erasure itself must not remove.')
ON CONFLICT (table_name) DO NOTHING;

COMMIT;
