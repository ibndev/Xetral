-- ============================================================================
--  089 — naira account numbers on Paystack alone, and the identity Paystack
--        asks for before it will open one
--
--  WHAT PRODUCTION SAID. `/admin/diagnostics` recorded, for every new
--  customer, the same three refusals in one request:
--
--    paystack · NGN · http_400    Customer has not been identified
--    flutterwave · NGN · kyc_required
--    bitnob · NGN · kyc_required
--
--  TWO FAULTS, AND ONLY ONE OF THEM WAS PAYSTACK'S.
--
--  1. THE OWNER ASSIGNED NAIRA ACCOUNT NUMBERS TO PAYSTACK (083), AND THE
--     REQUEST WENT ON TO FLUTTERWAVE AND BITNOB ANYWAY. 079 shipped
--     `account_fallback` ON: after a definite refusal the request walks every
--     rail `provider_coverage` says can open a naira account. That is a
--     decision about which companies receive a customer's details, and it
--     overrode the assignment the owner made — two more companies asked, two
--     more refusals written down, and the customer's screen chose which of
--     three sentences to show. OFF, and the column's default with it: a route
--     names who serves, and trying somebody else is something an operator
--     turns on deliberately on `/admin/providers`.
--
--  2. PAYSTACK REFUSES A DEDICATED ACCOUNT FOR A CUSTOMER IT HAS NOT
--     IDENTIFIED. Their documentation: "Local regulations require that
--     customer information is validated before creating account numbers on
--     their behalf", enforced for businesses in the Betting, Financial
--     Services and General Services categories. It arrives as HTTP 400 with
--     exactly the sentence above. No change to OUR request removes it — the
--     name and phone were added in round 29 and it persisted — because what it
--     asks for is the customer's BVN and a bank account held on that BVN,
--     which Paystack matches itself (`POST /dedicated_account/assign`, or
--     `POST /customer/:code/identification`). So when Paystack answers that
--     way the customer is asked for exactly those three things, once, and
--     Paystack opens the account on its own answer. No reviewer is involved.
--
--  WHAT IS KEPT OF THAT, AND WHAT IS NOT. The BVN goes to Paystack and is NOT
--  stored here — Paystack is the one doing the check, and a second copy of a
--  BVN in a second table is a second thing to leak. What IS stored is its
--  keyed FINGERPRINT (025's blind index, same key, same format), because every
--  per-customer control on this platform assumes one person is one customer:
--  one BVN answering for two accounts would double every ceiling. The check
--  refuses a fingerprint already standing for somebody else — here or on an
--  approved or pending KYC submission — with the same answer as a mismatch,
--  so the form cannot be used to learn whether a BVN banks here (025's rule).
--
--  AND THE NOTICE SAYS SO FIRST. Paystack was listed as receiving a name, an
--  email address and a phone number; from this migration it may receive a
--  BVN and a bank account number, so the privacy notice is republished before
--  the first one leaves. The terms did not change and are not republished.
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. The fallback, off — and off by default.
--
--    The UPDATE goes through 079's history trigger like any other change, so
--    the trail records that it moved and when. `updated_by` stays NULL: this
--    is the owner's decision applied by a migration, not a staff action.
-- ---------------------------------------------------------------------------
ALTER TABLE provider_routing_policy ALTER COLUMN account_fallback SET DEFAULT FALSE;

UPDATE provider_routing_policy
   SET account_fallback = FALSE,
       updated_at = now()
 WHERE account_fallback;

-- ---------------------------------------------------------------------------
-- 1b. The three rows `/admin/diagnostics` showed, each now answered.
--
--    The Flutterwave and Bitnob naira refusals exist only because the
--    fallback asked them; with it off they cannot recur. Paystack's "not been
--    identified" is no longer a refusal at all: the customer is asked for the
--    details it wants, and the application stops recording it (a question for
--    the customer is not a fault an operator can fix). Left, they would sit on
--    the screen an operator reads for real faults, describing ones that are
--    gone — and a list that is always partly stale is one nobody reads.
--    `account_refusals` names no customer, so nothing is lost but counts.
-- ---------------------------------------------------------------------------
DELETE FROM account_refusals
 WHERE currency = 'NGN'
   AND (   (rail IN ('flutterwave', 'bitnob') AND provider_code = 'kyc_required')
        OR (rail = 'paystack' AND lower(reason) LIKE '%not been identified%'));

-- ---------------------------------------------------------------------------
-- 2. What was sent to a rail to identify a customer — never the BVN itself.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS account_identity_checks (
    id               BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    uuid             UUID        NOT NULL DEFAULT gen_random_uuid(),
    user_id          BIGINT      NOT NULL REFERENCES users(id),
    /** The rail that was given the details. */
    provider         TEXT        NOT NULL CHECK (provider ~ '^[a-z]{2,20}$'),

    /** 025's blind index of the BVN, in 025's format. The BVN is not kept. */
    bvn_fingerprint  TEXT        NOT NULL CHECK (bvn_fingerprint ~ '^v[0-9]+:[0-9a-f]{64}$'),
    /** Enough for support to confirm which BVN was used, and no more. */
    bvn_last4        TEXT        NOT NULL CHECK (bvn_last4 ~ '^[0-9]{4}$'),
    bank_code        TEXT        NOT NULL CHECK (bank_code ~ '^[0-9A-Za-z-]{2,20}$'),
    account_last4    TEXT        NOT NULL CHECK (account_last4 ~ '^[0-9]{4}$'),

    /**
     * submitted — sent; the rail answers asynchronously.
     * validated — the rail matched the BVN to the account.
     * failed    — it did not; `reason` is the rail's own sentence, for staff.
     */
    status           TEXT        NOT NULL DEFAULT 'submitted'
                                 CHECK (status IN ('submitted', 'validated', 'failed')),
    reason           TEXT        NULL,

    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    resolved_at      TIMESTAMPTZ NULL,

    CONSTRAINT account_identity_checks_uuid_key UNIQUE (uuid),
    CONSTRAINT account_identity_resolution_is_recorded CHECK (
        (status = 'submitted') = (resolved_at IS NULL)
    )
);

CREATE INDEX IF NOT EXISTS account_identity_by_customer
    ON account_identity_checks (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS account_identity_by_fingerprint
    ON account_identity_checks (bvn_fingerprint);

/*
 * ONE BVN, ONE CUSTOMER — checked by the database, against both places a
 * fingerprint lives.
 *
 * A unique index cannot say it: the same customer may send the same BVN again
 * after mistyping the bank, and that is not a second person. So a trigger
 * refuses the row when the fingerprint already stands for a DIFFERENT user —
 * on a check that did not fail, or on a KYC submission that is pending or
 * approved. A failed check does not count: somebody typing another person's
 * BVN against the wrong account must not lock the real owner out.
 *
 * The advisory lock on the fingerprint serialises two racing inserts for the
 * same BVN, which is the case the check exists for.
 */
CREATE OR REPLACE FUNCTION assert_account_identity_is_theirs() RETURNS TRIGGER AS $$
BEGIN
    PERFORM pg_advisory_xact_lock(hashtext('account_identity:' || NEW.bvn_fingerprint));

    IF EXISTS (
        SELECT 1 FROM account_identity_checks c
         WHERE c.bvn_fingerprint = NEW.bvn_fingerprint
           AND c.user_id <> NEW.user_id
           AND c.status <> 'failed'
    ) OR EXISTS (
        SELECT 1 FROM kyc_submissions k
         WHERE k.bvn_fingerprint = NEW.bvn_fingerprint
           AND k.user_id <> NEW.user_id
           AND k.status IN ('pending', 'approved')
    ) THEN
        RAISE EXCEPTION 'that BVN already stands for another customer'
            USING ERRCODE = 'unique_violation',
                  CONSTRAINT = 'account_identity_one_bvn_one_customer';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS account_identity_is_theirs ON account_identity_checks;
CREATE TRIGGER account_identity_is_theirs
    BEFORE INSERT ON account_identity_checks
    FOR EACH ROW EXECUTE FUNCTION assert_account_identity_is_theirs();

/*
 * WHAT WAS SENT IS HISTORY: identity and destination never change, and an
 * outcome is set once. `submitted -> validated | failed`, nothing else.
 */
CREATE OR REPLACE FUNCTION assert_account_identity_transition() RETURNS TRIGGER AS $$
BEGIN
    IF NEW.user_id IS DISTINCT FROM OLD.user_id
       OR NEW.provider IS DISTINCT FROM OLD.provider
       OR NEW.bvn_fingerprint IS DISTINCT FROM OLD.bvn_fingerprint
       OR NEW.bvn_last4 IS DISTINCT FROM OLD.bvn_last4
       OR NEW.bank_code IS DISTINCT FROM OLD.bank_code
       OR NEW.account_last4 IS DISTINCT FROM OLD.account_last4
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'an identity check records what was sent and cannot be edited'
            USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.status IS DISTINCT FROM OLD.status
       AND NOT (OLD.status = 'submitted' AND NEW.status IN ('validated', 'failed')) THEN
        RAISE EXCEPTION 'identity check % cannot go from % to %', OLD.id, OLD.status, NEW.status
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS account_identity_transition ON account_identity_checks;
CREATE TRIGGER account_identity_transition
    BEFORE UPDATE ON account_identity_checks
    FOR EACH ROW EXECUTE FUNCTION assert_account_identity_transition();

DROP TRIGGER IF EXISTS account_identity_no_delete ON account_identity_checks;
CREATE OR REPLACE FUNCTION refuse_account_identity_delete() RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'identity checks are kept, not deleted' USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER account_identity_no_delete
    BEFORE DELETE ON account_identity_checks
    FOR EACH ROW EXECUTE FUNCTION refuse_account_identity_delete();

INSERT INTO retention_decisions (table_name, decision, rationale)
VALUES
  ('account_identity_checks', 'keep',
   'The record that a customer identified themselves to a bank rail: a keyed '
   'fingerprint and last fours, never the BVN. Kept with the relationship, as '
   'kyc_submissions is, because AML asks who an account was opened for.')
ON CONFLICT (table_name) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 3. The privacy notice, forward to 2026-09-30 — only if it is behind.
--
--    075's guards: retire only what is OLDER, publish only if nothing NEWER is
--    live, so a fresh database whose seed already carries this version is
--    untouched.
-- ---------------------------------------------------------------------------
UPDATE consent_documents
   SET retired_at = now()
 WHERE kind = 'privacy'
   AND retired_at IS NULL
   AND version < '2026-09-30';

INSERT INTO consent_documents (kind, version, body_sha256, summary)
SELECT 'privacy', '2026-09-30',
       'dad4861991204196f7fb61e050c87233197fbc7e83d70e7dc193e964d6d451d1',
       'What personal data Xetral Ltd holds, why, exactly which companies receive '
       'it and what reaches them — including Paystack, which is given your BVN and '
       'a bank account on it when it needs them to open your naira account number '
       '— how long it is kept, and how to get a copy or have it erased.'
 WHERE NOT EXISTS (
       SELECT 1 FROM consent_documents
        WHERE kind = 'privacy' AND retired_at IS NULL AND version > '2026-09-30')
ON CONFLICT (kind, version) DO NOTHING;

COMMIT;
