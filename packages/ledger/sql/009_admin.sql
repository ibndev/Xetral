-- ===========================================================================
--  Xetral — Operations: settings, audit, KYC, account status
--  packages/ledger/sql/009_admin.sql
--
--  Everything here exists so that running the platform does not require a
--  developer. Before this, changing a transfer fee meant editing an
--  environment variable and redeploying; freezing a fraudulent account was not
--  possible at all; and an unattributable deposit could enter suspense with no
--  way for anyone to get it out.
--
--  THE DIVIDING LINE between what lives in the environment and what lives
--  here: SECRETS stay in the environment, because a database row is readable
--  by anyone with a database connection and a signing key must not be. POLICY
--  lives here, because policy changes at the speed of a business decision and
--  should leave an audit trail rather than a deploy.
-- ===========================================================================

ALTER TYPE staff_role ADD VALUE IF NOT EXISTS 'compliance';
ALTER TYPE staff_role ADD VALUE IF NOT EXISTS 'support';
ALTER TYPE staff_role ADD VALUE IF NOT EXISTS 'finance';

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. RUNTIME SETTINGS
--
-- Typed, BOUNDED, and audited. The bounds are the important part: a fee is a
-- number an administrator types under time pressure, and `1500` meant as 1.5%
-- is 15% if the units are basis points and nobody checked. A CHECK that
-- refuses it costs nothing and catches the one mistake that takes money from
-- every customer at once.
-- ---------------------------------------------------------------------------

CREATE TYPE setting_type AS ENUM ('integer', 'boolean', 'text');

CREATE TABLE platform_settings (
    key           TEXT         PRIMARY KEY,
    value         TEXT         NOT NULL,
    value_type    setting_type NOT NULL,

    -- Bounds for numeric settings. NULL for the rest. Enforced by trigger
    -- rather than left to the endpoint, because the endpoint is one code path
    -- and this is a property of the setting.
    min_value     BIGINT       NULL,
    max_value     BIGINT       NULL,

    -- Shown in the admin UI. A settings screen whose rows are bare keys is a
    -- settings screen people change by guessing.
    label         TEXT         NOT NULL,
    description   TEXT         NOT NULL,
    /** Groups rows on the settings page: 'fees', 'limits', 'features', … */
    category      TEXT         NOT NULL,

    /**
     * Whether changing this needs the `admin` role rather than `finance`.
     *
     * Anything that moves money or opens a fraud surface is sensitive. The
     * distinction exists so a finance operator can adjust a fee without also
     * being able to enable gift card trading.
     */
    sensitive     BOOLEAN      NOT NULL DEFAULT FALSE,

    updated_by    BIGINT       NULL REFERENCES users(id),
    updated_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),

    CONSTRAINT bounds_are_ordered CHECK (
        min_value IS NULL OR max_value IS NULL OR min_value <= max_value
    )
);

-- Every value this setting has ever held. Append-only: "who set the fee to 5%
-- last March" is a question that gets asked exactly once, during an incident,
-- and the answer has to exist.
CREATE TABLE platform_settings_history (
    id          BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    key         TEXT        NOT NULL,
    old_value   TEXT        NULL,
    new_value   TEXT        NOT NULL,
    changed_by  BIGINT      NULL REFERENCES users(id),
    changed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    reason      TEXT        NULL
);

CREATE INDEX platform_settings_history_key ON platform_settings_history (key, changed_at DESC);

CREATE OR REPLACE FUNCTION assert_setting_valid() RETURNS TRIGGER AS $$
BEGIN
    -- The value must actually be what it claims to be. A settings table where
    -- `integer` rows can hold 'yes' is a settings table that crashes the app
    -- at read time, in whichever request happens to read it first.
    IF NEW.value_type = 'integer' THEN
        IF NEW.value !~ '^-?[0-9]+$' THEN
            RAISE EXCEPTION 'setting % is an integer; ''%'' is not', NEW.key, NEW.value
                USING ERRCODE = 'check_violation';
        END IF;
        IF NEW.min_value IS NOT NULL AND NEW.value::BIGINT < NEW.min_value THEN
            RAISE EXCEPTION 'setting % must be at least %', NEW.key, NEW.min_value
                USING ERRCODE = 'check_violation';
        END IF;
        IF NEW.max_value IS NOT NULL AND NEW.value::BIGINT > NEW.max_value THEN
            RAISE EXCEPTION 'setting % must be at most %', NEW.key, NEW.max_value
                USING ERRCODE = 'check_violation';
        END IF;
    ELSIF NEW.value_type = 'boolean' THEN
        -- Exactly 'true' or 'false'. Not 'yes', not '1'. A permissive parser
        -- here is how a typo enables the highest-fraud surface in the product.
        IF NEW.value NOT IN ('true', 'false') THEN
            RAISE EXCEPTION 'setting % is a boolean; use ''true'' or ''false''', NEW.key
                USING ERRCODE = 'check_violation';
        END IF;
    END IF;

    -- The key and its type are fixed at creation. Changing either would make
    -- every reader's assumption about this row wrong at once.
    IF TG_OP = 'UPDATE' THEN
        IF NEW.key IS DISTINCT FROM OLD.key OR NEW.value_type IS DISTINCT FROM OLD.value_type THEN
            RAISE EXCEPTION 'setting % has a fixed key and type', OLD.key
                USING ERRCODE = 'check_violation';
        END IF;

        IF NEW.value IS DISTINCT FROM OLD.value THEN
            INSERT INTO platform_settings_history (key, old_value, new_value, changed_by)
            VALUES (OLD.key, OLD.value, NEW.value, NEW.updated_by);
            NEW.updated_at := now();
        END IF;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER platform_settings_valid
    BEFORE INSERT OR UPDATE ON platform_settings
    FOR EACH ROW EXECUTE FUNCTION assert_setting_valid();

-- ---------------------------------------------------------------------------
-- 2. WHAT STAFF DID
--
-- Every privileged action, append-only. Not for tidiness: a fintech is asked
-- "who moved this, and when" by regulators, by disputing customers, and by
-- itself after an incident. An action nobody recorded is an action that did
-- not happen as far as any of them are concerned.
-- ---------------------------------------------------------------------------

CREATE TABLE admin_audit_log (
    id          BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    uuid        UUID        NOT NULL DEFAULT gen_random_uuid(),

    actor_id    BIGINT      NOT NULL REFERENCES users(id),
    action      TEXT        NOT NULL,
    /** What it was done to: 'user', 'deposit', 'setting', 'giftcard'. */
    subject_type TEXT       NOT NULL,
    subject_id   TEXT       NOT NULL,

    /**
     * Context, as JSON. NEVER secrets: no PINs, no card codes, no tokens. The
     * redaction rule that applies to logs applies here with more force,
     * because this table is append-only and cannot be scrubbed afterwards.
     */
    detail      JSONB       NOT NULL DEFAULT '{}'::jsonb,
    /** Why. Required for the actions that need a reason; see the CHECK. */
    reason      TEXT        NULL,

    ip_address  INET        NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT admin_audit_log_uuid_key UNIQUE (uuid),

    -- Actions that take something away from a customer must say why. A frozen
    -- account with no recorded reason is one nobody can safely unfreeze.
    CONSTRAINT destructive_actions_say_why CHECK (
        action NOT IN ('user.freeze', 'user.close', 'deposit.return', 'giftcard.clawback')
        OR reason IS NOT NULL
    )
);

CREATE INDEX admin_audit_actor   ON admin_audit_log (actor_id, created_at DESC);
CREATE INDEX admin_audit_subject ON admin_audit_log (subject_type, subject_id, created_at DESC);
CREATE INDEX admin_audit_time    ON admin_audit_log (created_at DESC);

-- Append-only, enforced. An audit log a privileged user can edit is a log that
-- tells you what the last person with access wanted you to believe.
CREATE OR REPLACE FUNCTION assert_audit_append_only() RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'the audit log is append-only'
        USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER admin_audit_log_immutable
    BEFORE UPDATE OR DELETE ON admin_audit_log
    FOR EACH ROW EXECUTE FUNCTION assert_audit_append_only();

-- ---------------------------------------------------------------------------
-- 3. KNOWING WHO A CUSTOMER IS
--
-- `provider_customers` has gated cards, funding and crypto since Phase 5, and
-- nothing wrote to it — so every customer was permanently refused. This is the
-- path that fills it: the customer submits, a compliance reviewer approves,
-- and approval is what registers them with the provider.
--
-- The BVN is sealed, not stored. It is the single most sensitive identifier a
-- Nigerian fintech holds, and CLAUDE.md's rule against logging one is weaker
-- than a CHECK that stops a plaintext one reaching a row at all.
-- ---------------------------------------------------------------------------

CREATE TYPE kyc_status AS ENUM ('pending', 'approved', 'rejected');

CREATE TABLE kyc_submissions (
    id            BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    uuid          UUID        NOT NULL DEFAULT gen_random_uuid(),
    user_id       BIGINT      NOT NULL REFERENCES users(id),

    full_name     TEXT        NOT NULL CHECK (length(trim(full_name)) >= 3),
    date_of_birth DATE        NOT NULL,
    phone         TEXT        NOT NULL CHECK (phone ~ '^\+?[0-9]{10,15}$'),

    -- Sealed with a key-versioned envelope, exactly like a gift card code.
    bvn_sealed    TEXT        NOT NULL CHECK (bvn_sealed ~ '^v[0-9]+:'),
    /** Last four only, so support can confirm a BVN without revealing one. */
    bvn_last4     TEXT        NOT NULL CHECK (bvn_last4 ~ '^[0-9]{4}$'),

    address       TEXT        NOT NULL,

    status        kyc_status  NOT NULL DEFAULT 'pending',
    reviewed_by   BIGINT      NULL REFERENCES users(id),
    reviewed_at   TIMESTAMPTZ NULL,
    rejection_reason TEXT     NULL,

    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT kyc_submissions_uuid_key UNIQUE (uuid),
    CONSTRAINT kyc_rejection_says_why CHECK (
        status <> 'rejected' OR rejection_reason IS NOT NULL
    ),
    CONSTRAINT kyc_review_is_recorded CHECK (
        status = 'pending' OR (reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL)
    ),
    -- Nobody approves their own identity documents.
    CONSTRAINT kyc_nobody_reviews_their_own CHECK (
        reviewed_by IS NULL OR reviewed_by <> user_id
    )
);

-- One live submission per customer. A rejected one stays as history and can be
-- resubmitted; two pending ones would let a reviewer approve the flattering
-- copy.
CREATE UNIQUE INDEX kyc_one_open_per_user
    ON kyc_submissions (user_id) WHERE (status IN ('pending', 'approved'));

CREATE INDEX kyc_queue ON kyc_submissions (created_at) WHERE status = 'pending';

CREATE OR REPLACE FUNCTION assert_kyc_transition() RETURNS TRIGGER AS $$
BEGIN
    IF NEW.status IS DISTINCT FROM OLD.status
       AND NOT (OLD.status = 'pending' AND NEW.status IN ('approved', 'rejected')) THEN
        RAISE EXCEPTION 'kyc submission % cannot go from % to %',
            OLD.id, OLD.status, NEW.status
            USING ERRCODE = 'check_violation';
    END IF;

    -- The documents themselves are what was reviewed. Editing them after the
    -- fact would mean the record no longer shows what anyone approved.
    IF NEW.user_id IS DISTINCT FROM OLD.user_id
       OR NEW.bvn_sealed IS DISTINCT FROM OLD.bvn_sealed
       OR NEW.full_name  IS DISTINCT FROM OLD.full_name
       OR NEW.date_of_birth IS DISTINCT FROM OLD.date_of_birth THEN
        RAISE EXCEPTION 'kyc submission % records what was reviewed; it is immutable', OLD.id
            USING ERRCODE = 'check_violation';
    END IF;

    NEW.updated_at := now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER kyc_submissions_transition
    BEFORE UPDATE ON kyc_submissions
    FOR EACH ROW EXECUTE FUNCTION assert_kyc_transition();

-- ---------------------------------------------------------------------------
-- 4. ACCOUNT STATUS CHANGES
--
-- `users.status` is checked on every money path and nothing could change it.
-- This records each change with a reason, so an account is never frozen or
-- reopened by somebody nobody can identify.
-- ---------------------------------------------------------------------------

CREATE TABLE user_status_changes (
    id          BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id     BIGINT      NOT NULL REFERENCES users(id),
    from_status TEXT        NOT NULL,
    to_status   TEXT        NOT NULL,
    changed_by  BIGINT      NOT NULL REFERENCES users(id),
    reason      TEXT        NOT NULL CHECK (length(trim(reason)) >= 3),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX user_status_changes_user ON user_status_changes (user_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- 5. OPERATIONAL VIEWS
--
-- What an operator needs to see on one screen, computed by the database rather
-- than assembled by six round trips from a dashboard.
-- ---------------------------------------------------------------------------

/** Money the platform is holding that it cannot attribute, oldest first. */
CREATE OR REPLACE VIEW admin_suspense AS
SELECT d.uuid AS deposit_uuid,
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

/** Everything waiting on a human, in one place. A dashboard that needs four
 *  queries to answer "is anything stuck?" is a dashboard nobody opens. */
CREATE OR REPLACE VIEW admin_work_queue AS
  SELECT 'kyc'::TEXT AS queue, COUNT(*)::BIGINT AS waiting,
         MIN(created_at) AS oldest
    FROM kyc_submissions WHERE status = 'pending'
UNION ALL
  SELECT 'suspense', COUNT(*), MIN(created_at)
    FROM deposits WHERE status = 'suspense'
UNION ALL
  SELECT 'giftcard_review', COUNT(*), MIN(created_at)
    FROM giftcard_submissions WHERE status = 'pending_review'
UNION ALL
  SELECT 'purchases_held', COUNT(*), MIN(created_at)
    FROM purchases WHERE status = 'reserved'
UNION ALL
  SELECT 'crypto_withdrawals_open', COUNT(*), MIN(created_at)
    FROM crypto_withdrawals WHERE status IN ('reserved', 'broadcast');

/**
 * What the platform owes customers, by currency.
 *
 * Read from the POSTINGS, not from a cached figure. This is the number that
 * must equal what is actually held at the banks and providers, and a
 * reconciliation that compared two application-maintained caches would agree
 * with itself while both were wrong.
 */
CREATE OR REPLACE VIEW admin_liability AS
SELECT a.currency,
       SUM(CASE WHEN a.kind = 'customer_wallet'  THEN b.balance_minor ELSE 0 END) AS wallets_minor,
       SUM(CASE WHEN a.kind = 'customer_pending' THEN b.balance_minor ELSE 0 END) AS pending_minor,
       SUM(CASE WHEN a.kind = 'customer_card'    THEN b.balance_minor ELSE 0 END) AS cards_minor,
       SUM(CASE WHEN a.kind IN ('customer_wallet','customer_pending','customer_card')
                THEN b.balance_minor ELSE 0 END) AS total_owed_minor,
       SUM(CASE WHEN a.kind = 'suspense'         THEN b.balance_minor ELSE 0 END) AS suspense_minor
  FROM account_balances b
  JOIN accounts a ON a.id = b.account_id
 GROUP BY a.currency
 ORDER BY a.currency;

COMMIT;
