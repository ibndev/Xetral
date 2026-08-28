-- ============================================================================
--  020 — Balance-level reconciliation against a provider.
--
--  WHAT WAS MISSING. Four sweeps already ask a provider about individual
--  TRANSACTIONS — a held purchase, a lost deposit, an unanswered withdrawal —
--  and each is correct. None of them ever asks the only question that catches a
--  whole class of error at once: does the provider agree with us about the
--  TOTAL?
--
--  A transaction-level sweep cannot see money that was never a transaction
--  here. A settlement Bitnob applied and never told us about, a fee they
--  deducted from the float, a card credited outside our flow — each leaves the
--  books internally consistent and quietly wrong about what we actually hold.
--  `ledger_drift` catches our materialised balances disagreeing with our own
--  postings; nothing catches our postings disagreeing with reality.
--
--  A DIFFERENCE IS RECORDED, NEVER CORRECTED. This is the rule the whole table
--  exists to enforce. The obvious next step — post an adjustment to make the
--  ledger match the provider — would be inventing money on the strength of a
--  number that is routinely and legitimately stale: Bitnob's card
--  authorisation and settlement are two events up to fourteen business days
--  apart, so a card whose balance differs today may simply be a card with an
--  open hold. Auto-correcting would turn every one of those into a fabricated
--  entry, and the entry would look exactly like a real one afterwards.
--
--  So a check writes a row saying what each side said, and a human decides. The
--  ledger stays the statement of what we owe; this table is the statement of
--  what we should go and ask about.
-- ============================================================================

BEGIN;

CREATE TYPE balance_scope AS ENUM (
  'provider_float',   -- our whole balance at the provider, per currency
  'card'              -- one virtual card
);

CREATE TABLE provider_balance_checks (
    id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    uuid             UUID           NOT NULL DEFAULT gen_random_uuid() UNIQUE,

    provider         TEXT           NOT NULL,
    scope            balance_scope  NOT NULL,

    /**
     * WHICH thing was compared: a currency code for a float check, a card's
     * uuid for a card check. Text rather than two nullable columns, because a
     * pair of columns where exactly one is set is a rule nothing enforces.
     */
    subject          TEXT           NOT NULL,

    currency         TEXT           NOT NULL,

    -- Both sides, in minor units, as integers. Never a float: the whole point
    -- of the comparison is the last unit.
    provider_minor   BIGINT         NOT NULL,
    ledger_minor     BIGINT         NOT NULL,

    /**
     * Stored, not computed on read.
     *
     * A generated column would be tidier and would recompute if either side
     * were ever edited. The difference is the FINDING — the thing an operator
     * acted on — and it has to stay what it was when somebody looked at it.
     */
    difference_minor BIGINT         NOT NULL,

    checked_at       TIMESTAMPTZ    NOT NULL DEFAULT now(),

    -- Set when a person has explained it. An unresolved row is the work queue.
    resolved_at      TIMESTAMPTZ    NULL,
    resolved_by      BIGINT         NULL REFERENCES users(id),
    resolution       TEXT           NULL,

    CONSTRAINT balance_difference_is_consistent CHECK (
        difference_minor = provider_minor - ledger_minor
    ),
    CONSTRAINT balance_resolution_is_complete CHECK (
        (resolved_at IS NULL AND resolved_by IS NULL AND resolution IS NULL)
        OR
        (resolved_at IS NOT NULL AND resolved_by IS NOT NULL AND resolution IS NOT NULL)
    )
);

-- Only DIFFERENCES are stored, so this index covers the whole table and the
-- queue query is the common one.
CREATE INDEX provider_balance_open
    ON provider_balance_checks (checked_at DESC) WHERE resolved_at IS NULL;
CREATE INDEX provider_balance_subject
    ON provider_balance_checks (provider, scope, subject, checked_at DESC);

/**
 * A finding is append-only, and may only ever be RESOLVED.
 *
 * Same rule as the audit log and for the same reason: a discrepancy record
 * that can be edited says whatever the last person with access wanted it to
 * say, and this is the record that would matter most in the argument about
 * where the money went.
 */
CREATE OR REPLACE FUNCTION assert_balance_check_append_only() RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'a balance discrepancy cannot be deleted; resolve it'
            USING ERRCODE = 'restrict_violation';
    END IF;

    IF OLD.resolved_at IS NOT NULL THEN
        RAISE EXCEPTION 'balance check % is already resolved', OLD.id
            USING ERRCODE = 'restrict_violation';
    END IF;

    IF NEW.provider         IS DISTINCT FROM OLD.provider
       OR NEW.scope            IS DISTINCT FROM OLD.scope
       OR NEW.subject          IS DISTINCT FROM OLD.subject
       OR NEW.currency         IS DISTINCT FROM OLD.currency
       OR NEW.provider_minor   IS DISTINCT FROM OLD.provider_minor
       OR NEW.ledger_minor     IS DISTINCT FROM OLD.ledger_minor
       OR NEW.difference_minor IS DISTINCT FROM OLD.difference_minor
       OR NEW.checked_at       IS DISTINCT FROM OLD.checked_at THEN
        RAISE EXCEPTION 'what the two sides said is a fact and cannot be edited'
            USING ERRCODE = 'restrict_violation';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER provider_balance_checks_append_only
    BEFORE UPDATE OR DELETE ON provider_balance_checks
    FOR EACH ROW EXECUTE FUNCTION assert_balance_check_append_only();

/** The queue: every difference nobody has explained yet, worst first. */
CREATE VIEW provider_balance_drift AS
SELECT c.uuid,
       c.provider,
       c.scope::text                   AS scope,
       c.subject,
       c.currency,
       c.provider_minor,
       c.ledger_minor,
       c.difference_minor,
       abs(c.difference_minor)         AS magnitude_minor,
       c.checked_at
  FROM provider_balance_checks c
 WHERE c.resolved_at IS NULL
 -- Largest discrepancy first. Ordering by time buries the one that matters
 -- under a week of small ones.
 ORDER BY abs(c.difference_minor) DESC, c.checked_at DESC;

INSERT INTO platform_settings
  (key, value, value_type, min_value, max_value, label, description, category, sensitive)
VALUES
  ('balance_tolerance_minor', '0', 'integer', 0, 1000000,
   'Balance difference ignored (minor units)',
   'A difference at or below this is not recorded. Defaults to ZERO: on a '
   'double-entry ledger the correct difference is nothing, and a tolerance is '
   'a decision to stop looking at a class of error. Raise it only with a '
   'reason, and never above the smallest amount worth investigating.',
   'limits', TRUE)
ON CONFLICT (key) DO NOTHING;

COMMIT;
