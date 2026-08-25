-- ===========================================================================
--  Xetral — a second factor for staff
--  packages/identity/sql/014_staff_totp.sql
--
--  WHY STAFF AND NOT CUSTOMERS.
--
--  A customer's password protects one balance. A staff account protects EVERY
--  balance: the operations surface can approve gift card payouts, attribute
--  suspense deposits to a named person, change the transfer fee for everybody
--  at once, freeze accounts, and grant roles — including its own. One phished
--  staff password is a different order of event from one phished customer
--  password, and it is the failure that ends companies rather than costing
--  them a refund.
--
--  So the second factor goes here first. Customers get one when there is a
--  recovery story for a lost phone that does not reduce to "email a support
--  address", which is the factor it was meant to replace.
--
--  THE REPLAY TABLE IS THE POINT.
--
--  A TOTP code is valid for a 90-second window, which is ample time to read
--  six digits off somebody's screen during a call, a screen share, or over a
--  shoulder. Verifying the code and stopping there leaves it usable for the
--  rest of that window by whoever else saw it.
--
--  `staff_totp_used_steps` makes a code single-use: the counter value it
--  belonged to is recorded, and a UNIQUE constraint refuses the second
--  attempt. That is the same shape as the ledger's `idempotency_key` and the
--  refresh token's `consumed_at` — the check that matters is a race, and only
--  the database can win a race.
-- ===========================================================================

BEGIN;

CREATE TABLE staff_totp (
    user_id         BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,

    -- SEALED, not hashed, and that difference is forced by the algorithm: TOTP
    -- verification recomputes the code from the secret, so the server must be
    -- able to read it back. A hash would make it useless.
    --
    -- That is exactly why the `^v[0-9]+:` CHECK is here. This column holds the
    -- one recoverable credential in the identity schema — everything else is a
    -- one-way hash — so it is the column where a plaintext write does the most
    -- damage, and the constraint is what stops one reaching a row.
    secret_sealed   TEXT NOT NULL CHECK (secret_sealed ~ '^v[0-9]+:'),

    -- Enrolment is two steps. A row exists as soon as a secret is issued, and
    -- is only trusted once the operator has proved they can generate a code
    -- from it. Without the second step, an operator who scanned nothing would
    -- be locked out of the admin surface by their own enrolment — discovered
    -- during whatever incident made them open it.
    confirmed_at    TIMESTAMPTZ,

    -- Brute force protection. Six digits is a million guesses, which is a
    -- weekend at any useful request rate, so a lockout is not optional. Same
    -- shape as `transaction_pins`, deliberately: an operator hitting this
    -- should recognise the behaviour.
    failed_attempts INTEGER NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
    locked_until    TIMESTAMPTZ,

    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_used_at    TIMESTAMPTZ
);

-- ---------------------------------------------------------------------------
-- 1. A CONFIRMED SECRET CANNOT BE SWAPPED
--
-- The attack this closes is quiet and complete: somebody with a stolen staff
-- session re-enrols the second factor onto their own authenticator, and from
-- then on they hold both factors and the real operator holds neither. Nothing
-- in the audit log would look unusual, because re-enrolling is a thing
-- operators legitimately do when they change phones.
--
-- Replacing a confirmed factor therefore requires DELETING the row, which is
-- an admin action against another person's account and is audited as one. An
-- operator cannot do it to themselves with the session they are holding.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION assert_staff_totp_transition() RETURNS TRIGGER AS $$
BEGIN
    IF OLD.confirmed_at IS NOT NULL
       AND NEW.secret_sealed IS DISTINCT FROM OLD.secret_sealed THEN
        RAISE EXCEPTION
            'the second factor for user % is confirmed; it must be removed by an '
            'administrator before a new one can be enrolled', OLD.user_id
            USING ERRCODE = 'check_violation';
    END IF;

    -- Confirmation is one-way too. Un-confirming would reopen the swap above
    -- through a second door.
    IF OLD.confirmed_at IS NOT NULL AND NEW.confirmed_at IS NULL THEN
        RAISE EXCEPTION 'the second factor for user % cannot be un-confirmed', OLD.user_id
            USING ERRCODE = 'check_violation';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER staff_totp_transition
    BEFORE UPDATE ON staff_totp
    FOR EACH ROW EXECUTE FUNCTION assert_staff_totp_transition();

-- ---------------------------------------------------------------------------
-- 2. A CODE IS USED ONCE
--
-- One row per (operator, counter value). The UNIQUE constraint IS the guard —
-- the service inserts before it acts, and a duplicate key means the code has
-- already been spent.
--
-- Rows are prunable: a step older than the acceptance window can never be
-- presented again, because `verifyTotp` would reject it on time before this
-- table was consulted. Nothing prunes them yet, and at staff volumes that is
-- a few thousand rows a year.
-- ---------------------------------------------------------------------------
CREATE TABLE staff_totp_used_steps (
    user_id   BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    time_step BIGINT NOT NULL,
    used_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

    PRIMARY KEY (user_id, time_step)
);

-- ---------------------------------------------------------------------------
-- 3. A USED STEP IS NEVER UNUSED
--
-- Same rule as a consumed refresh token. If a row here could be deleted or
-- re-pointed, "this code has already been used" would be a claim about the
-- present rather than about history — and one DELETE would make a captured
-- code live again.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION assert_totp_step_append_only() RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION
        'a spent one-time code cannot be % — the record of its use is what makes it '
        'single-use', lower(TG_OP)
        USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER totp_steps_append_only
    BEFORE UPDATE OR DELETE ON staff_totp_used_steps
    FOR EACH STATEMENT EXECUTE FUNCTION assert_totp_step_append_only();

-- ---------------------------------------------------------------------------
-- 4. ELEVATION — WHY A CODE IS NOT DEMANDED ON EVERY SINGLE ACTION
--
-- The first shape of this required a fresh code on every acting request. It is
-- the stronger-sounding design and it is unusable: codes change every thirty
-- seconds and are single-use, so a reviewer working through a queue of gift
-- cards would be refused on their second approval and made to wait for the
-- next code. An operations team that has to wait half a minute between clicks
-- does not get a better second factor — it gets a shared authenticator on a
-- desk, which is worse than none because it looks like control.
--
-- So a verified code ELEVATES THE SESSION for a short window, and acting
-- routes inside that window need only the transaction PIN they already
-- needed. This is the "sudo mode" arrangement, and the three properties that
-- make it safe are all structural:
--
--   - it lives ON THE SESSION, so revoking the session revokes it too;
--   - it is short, and the column records when rather than whether, so the
--     window is evaluated fresh on every request rather than trusted;
--   - the transaction PIN is STILL required on every acting request, so a
--     stolen access token inside an elevated window still cannot act.
-- ---------------------------------------------------------------------------
ALTER TABLE auth_sessions ADD COLUMN totp_verified_at TIMESTAMPTZ;

-- ---------------------------------------------------------------------------
-- 5. WHO IS PROTECTED, AND WHO IS NOT
--
-- The list an operator reads to answer "does every person who can approve a
-- payout have a second factor?". It is a view rather than a report somebody
-- writes each quarter, because the answer changes every time a role is
-- granted.
-- ---------------------------------------------------------------------------
CREATE VIEW staff_without_second_factor AS
SELECT DISTINCT r.user_id,
       u.email,
       r.role
  FROM staff_roles r
  JOIN users u ON u.id = r.user_id
  LEFT JOIN staff_totp t ON t.user_id = r.user_id AND t.confirmed_at IS NOT NULL
 WHERE r.revoked_at IS NULL
   AND t.user_id IS NULL;

COMMIT;
