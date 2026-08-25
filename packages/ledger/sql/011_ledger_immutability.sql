-- ===========================================================================
--  Xetral — ledger immutability
--  packages/ledger/sql/011_ledger_immutability.sql
--
--  WHY THIS IS A SEPARATE MIGRATION RATHER THAN PART OF 001.
--
--  001_ledger.sql has said "Immutable: no UPDATE, no DELETE, ever" in a comment
--  since Phase 1, and nothing enforced it. Every other append-only rule in this
--  schema got a trigger — `assert_refresh_token_append_only`,
--  `assert_audit_append_only`, `card_freezes_append_only` — and the ledger, the
--  one table where it matters most, was the one relying on convention.
--
--  The pre-deployment audit demonstrated it against a live database: a single
--  UPDATE moved a posting by ₦5,000 and a single DELETE removed another. The
--  materialised balance does NOT follow, because `apply_posting_to_balance`
--  fires on INSERT only — so the books silently disagreed with themselves and
--  the only trace was a row in `ledger_drift` that nobody is paged about.
--
--  Applied to an existing database, this changes nothing about the data. It
--  removes a capability that no application code has ever used.
--
--  WHAT THIS IS NOT. It does not stop a superuser: `ALTER TABLE ... DISABLE
--  TRIGGER` is always available to a role with the privilege, and no trigger
--  can defend against that. What it stops is the ordinary path — a mistaken
--  UPDATE in a psql session at 3am, an ORM that decides to "fix" a row, a
--  migration that rewrites history. Least-privilege database roles are the
--  answer to the superuser case and are a separate piece of work.
-- ===========================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. JOURNAL ENTRIES AND POSTINGS ARE APPEND-ONLY
--
-- One function for both tables. They fail for the same reason and a customer
-- support engineer reading the error should get the same sentence either way —
-- and, more practically, two copies of this drift.
--
-- The message names the remedy, because the person who hits this is usually
-- trying to correct a genuine mistake and needs to be told the supported way
-- rather than just refused.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION assert_ledger_append_only() RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION
        'the ledger is append-only: % on % is not permitted. '
        'Correct a mistake with a reversing entry '
        '(LedgerService.post with reversesEntryId), never by editing history.',
        TG_OP, TG_TABLE_NAME
        USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

-- FOR EACH STATEMENT, not FOR EACH ROW.
--
-- A row-level trigger fires once per affected row, so `DELETE FROM postings`
-- with no WHERE clause raises after examining the first row — correct, but it
-- has already taken row locks on the way there. A statement-level trigger
-- refuses the statement before any row is touched, which is both faster and
-- the more honest description of the rule: the operation is forbidden, not
-- the individual rows.
CREATE TRIGGER journal_entries_append_only
    BEFORE UPDATE OR DELETE ON journal_entries
    FOR EACH STATEMENT EXECUTE FUNCTION assert_ledger_append_only();

CREATE TRIGGER postings_append_only
    BEFORE UPDATE OR DELETE ON postings
    FOR EACH STATEMENT EXECUTE FUNCTION assert_ledger_append_only();

-- ---------------------------------------------------------------------------
-- 2. WHAT IS DELIBERATELY STILL MUTABLE
--
-- `account_balances` is a MATERIALISED cache maintained by
-- `apply_posting_to_balance` on every posting insert. It must stay updatable
-- or the ledger cannot record anything at all.
--
-- That is not a hole. The balance is derived: `ledger_drift` recomputes it
-- from the postings and reports any account where the two disagree. With the
-- postings now immutable, drift can only mean the cache is wrong, and the
-- postings are the authority to rebuild it from. Before this migration drift
-- was ambiguous — either could have been edited.
--
-- `accounts` stays updatable for `status` (freezing an account). Its identity
-- columns are already protected by the unique indexes in 001.
-- ---------------------------------------------------------------------------

COMMIT;
