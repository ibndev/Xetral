-- ============================================================================
--  033 — What a customer agreed to, and when.
--
--  WHAT WAS MISSING. Consent existed as a SENTENCE ON A PAGE: "by creating an
--  account you agree to our terms and privacy notice", above the button. That
--  is the right thing to show a customer and it is not a record. Nothing
--  anywhere said that a particular person agreed to a particular version at a
--  particular moment, so the question the NDPA actually asks — demonstrate
--  that this person consented — had no answer at all.
--
--  THE PROOF IS THE POINT, and every decision here follows from it:
--
--    A WITHDRAWAL IS A NEW ROW, never an edit. If granting could be erased,
--    "had they consented on the day we mailed them?" becomes a claim about
--    the present rather than about history — and that is the exact question a
--    regulator asks after the fact. Same rule as a consumed refresh token,
--    and as a journal entry.
--
--    CONSENT IS TO A VERSION. Agreeing to the June terms is not agreeing to
--    the September ones, so a document is a row with a version and a hash of
--    what it said, and republishing means retiring and publishing rather than
--    editing. Editing one in place would silently rewrite what every past
--    customer is recorded as having agreed to — the lesson 005 records about
--    gift card rate cards, applied to something a court would read.
--
--    MARKETING CANNOT BE BUNDLED. Consent must be specific and freely given,
--    so a single "I agree" covering the terms and a mailing list is not
--    consent to the mailing list. That is enforced by CHECK rather than by
--    the registration endpoint remembering: a record whose source is
--    `registration` cannot be a marketing consent.
--
--    AND IT MUST GATE SOMETHING. A consent nothing reads is a checkbox, not a
--    control — the lesson Tier 1 records about `crypto_enabled` being a row
--    nothing read. So the outbox refuses a marketing-class message to a
--    customer with no live grant, BY TRIGGER, before any code has a chance to
--    forget.
-- ============================================================================

-- Outside a transaction, and unusable in the same one.
ALTER TYPE notification_class ADD VALUE IF NOT EXISTS 'marketing';

BEGIN;

CREATE TYPE consent_kind AS ENUM ('terms', 'privacy', 'marketing_email');

/**
 * Where the answer came from.
 *
 * Not decoration: it is what makes "marketing was not bundled into signing
 * up" a property of the schema rather than a property of the endpoint.
 */
CREATE TYPE consent_source AS ENUM ('registration', 'settings', 'admin');

/**
 * What there was to agree to.
 *
 * APPEND-ONLY, retire and republish — the rate card rule. A document edited
 * in place rewrites what every past customer is recorded as having agreed to,
 * and nothing would fail.
 */
CREATE TABLE consent_documents (
    id           BIGINT       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    kind         consent_kind NOT NULL,

    /** Date-versioned, because that is what the page itself shows a customer
     *  ("Updated 25 August 2026") and two identities for one document is how
     *  they come to disagree. */
    version      TEXT         NOT NULL CHECK (version ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),

    /** WHAT IT SAID, not where it lives. A URL describes today's page; a hash
     *  describes the words the customer actually agreed to, and is the only
     *  half of this row that a later edit cannot quietly invalidate.
     *  `consent-documents.test.ts` fails the build if the published page no
     *  longer hashes to the current row — so editing the terms without
     *  republishing a version is a red build rather than a silent lie. */
    body_sha256  TEXT         NOT NULL CHECK (body_sha256 ~ '^[0-9a-f]{64}$'),

    /** One line, for the screen that asks. Consent must be INFORMED, and a
     *  version number informs nobody. */
    summary      TEXT         NOT NULL CHECK (summary <> ''),

    published_at TIMESTAMPTZ  NOT NULL DEFAULT now(),
    retired_at   TIMESTAMPTZ,

    UNIQUE (kind, version)
);

/** One live document per kind. A second would make "the current terms"
 *  ambiguous, and every consent recorded against it unanswerable. */
CREATE UNIQUE INDEX consent_one_current_per_kind
    ON consent_documents (kind) WHERE retired_at IS NULL;

CREATE OR REPLACE FUNCTION guard_consent_document_change() RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'a published consent document cannot be deleted'
            USING ERRCODE = 'restrict_violation';
    END IF;

    -- Retiring is the ONE permitted change, and only once and only forwards.
    -- Un-retiring would bring a superseded document back as current, and
    -- every consent recorded in between would describe the wrong words.
    IF ROW(NEW.kind, NEW.version, NEW.body_sha256, NEW.summary, NEW.published_at)
       IS DISTINCT FROM
       ROW(OLD.kind, OLD.version, OLD.body_sha256, OLD.summary, OLD.published_at)
    THEN
        RAISE EXCEPTION 'a published consent document is immutable; retire and republish'
            USING ERRCODE = 'restrict_violation';
    END IF;

    IF OLD.retired_at IS NOT NULL AND NEW.retired_at IS DISTINCT FROM OLD.retired_at THEN
        RAISE EXCEPTION 'a retired consent document cannot be brought back'
            USING ERRCODE = 'restrict_violation';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER consent_documents_are_append_only
    BEFORE UPDATE OR DELETE ON consent_documents
    FOR EACH ROW EXECUTE FUNCTION guard_consent_document_change();

/**
 * What one person answered, once.
 *
 * Never updated. A withdrawal is another row saying `granted = FALSE`, so the
 * table is a history rather than a state, and the state is a view over it —
 * the same reason `entry_status` is a view and balances are computed from
 * postings.
 */
CREATE TABLE consent_records (
    id          BIGINT         GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id     BIGINT         NOT NULL REFERENCES users(id),
    document_id BIGINT         NOT NULL REFERENCES consent_documents(id),

    /** Denormalised from the document so the CHECKs below can read it, and
     *  kept honest by a trigger. */
    kind        consent_kind   NOT NULL,

    granted     BOOLEAN        NOT NULL,
    source      consent_source NOT NULL,

    /** WHERE FROM AND ON WHAT, because the proof is what matters. Nullable:
     *  a request we cannot place must not be refused, and an absent address
     *  is a weaker record rather than no record. */
    ip          INET,
    user_agent  TEXT,

    occurred_at TIMESTAMPTZ    NOT NULL DEFAULT now(),

    /* MARKETING IS NEVER PART OF SIGNING UP. Consent must be specific and
       freely given, and one "I agree" covering the terms and a mailing list
       is not consent to the mailing list. A CHECK rather than an endpoint
       that remembers. */
    CONSTRAINT consent_registration_is_not_marketing
        CHECK (source <> 'registration' OR kind <> 'marketing_email'),

    /* ONLY MARKETING CAN BE WITHDRAWN, and the asymmetry is a real statement
       rather than an omission: withdrawing consent to the terms is closing
       the account, which is a different action with its own path. Recording
       it here would leave a customer holding a balance under terms they are
       recorded as having refused. */
    CONSTRAINT consent_only_marketing_is_withdrawable
        CHECK (granted OR kind = 'marketing_email')
);

CREATE INDEX consent_records_by_user ON consent_records (user_id, kind, occurred_at DESC);

CREATE OR REPLACE FUNCTION assert_consent_matches_document() RETURNS TRIGGER AS $$
DECLARE v_kind consent_kind;
BEGIN
    SELECT kind INTO v_kind FROM consent_documents WHERE id = NEW.document_id;
    IF v_kind IS DISTINCT FROM NEW.kind THEN
        RAISE EXCEPTION 'consent recorded as % against a % document', NEW.kind, v_kind
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER consent_records_name_their_document
    BEFORE INSERT ON consent_records
    FOR EACH ROW EXECUTE FUNCTION assert_consent_matches_document();

CREATE OR REPLACE FUNCTION refuse_consent_record_change() RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'consent_records is append-only; % is refused. Withdraw by recording a withdrawal.',
        TG_OP USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER consent_records_are_append_only
    BEFORE UPDATE OR DELETE ON consent_records
    FOR EACH ROW EXECUTE FUNCTION refuse_consent_record_change();

COMMIT;

BEGIN;

/**
 * Where each customer currently stands.
 *
 * A VIEW, never a column. A stored "marketing: yes" is a second copy of the
 * answer and drifts the first time a path writes one and not the other — the
 * same reason a balance is computed from postings.
 *
 * `covers_current` is the question that actually matters when the terms
 * change: they agreed, but to WHICH words.
 */
CREATE VIEW customer_consents AS
SELECT r.user_id,
       r.kind::TEXT       AS kind,
       r.granted,
       d.version,
       r.occurred_at,
       r.source::TEXT     AS source,
       d.retired_at IS NULL AS covers_current
  FROM consent_records r
  JOIN consent_documents d ON d.id = r.document_id
 WHERE r.id = (
        SELECT max(r2.id) FROM consent_records r2
         WHERE r2.user_id = r.user_id AND r2.kind = r.kind
       );

/**
 * Who has not agreed to the words currently in force.
 *
 * Every active customer, against every live terms-or-privacy document they
 * have no live grant for. Republishing a notice fills this view, which is the
 * point: a change nobody was asked about is a change nobody agreed to, and
 * without this the only evidence would be an absence nobody could query.
 *
 * Marketing is excluded deliberately. Not having opted in is the correct
 * resting state, not an outstanding task — listing it here would turn
 * "declined a mailing list" into a queue somebody works through.
 */
CREATE VIEW consent_outstanding AS
SELECT u.id AS user_id, u.uuid, u.email,
       d.kind::TEXT AS kind,
       d.version,
       d.published_at
  FROM users u
  CROSS JOIN consent_documents d
 WHERE u.status = 'active'
   AND d.retired_at IS NULL
   AND d.kind <> 'marketing_email'
   AND NOT EXISTS (
        SELECT 1 FROM consent_records r
         WHERE r.user_id = u.id AND r.document_id = d.id AND r.granted
       );

/**
 * A consent that gates nothing is a checkbox.
 *
 * The outbox refuses a marketing-class message to a customer with no live
 * grant, BEFORE INSERT, so no flow can skip it by forgetting — the reason
 * every rule that matters here is a trigger rather than a convention.
 * Security and transactional mail is untouched: a password reset is not
 * marketing and must reach somebody who has opted out of everything.
 */
CREATE OR REPLACE FUNCTION assert_marketing_is_consented() RETURNS TRIGGER AS $$
DECLARE v_granted BOOLEAN;
BEGIN
    IF NEW.class <> 'marketing' THEN RETURN NEW; END IF;

    IF NEW.user_id IS NULL THEN
        RAISE EXCEPTION 'marketing mail needs a customer to have consented, and this names none'
            USING ERRCODE = 'check_violation';
    END IF;

    SELECT granted INTO v_granted FROM customer_consents
     WHERE user_id = NEW.user_id AND kind = 'marketing_email';

    IF v_granted IS NOT TRUE THEN
        RAISE EXCEPTION 'no live marketing consent for user %', NEW.user_id
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER notification_outbox_respects_marketing_consent
    BEFORE INSERT ON notification_outbox
    FOR EACH ROW EXECUTE FUNCTION assert_marketing_is_consented();

INSERT INTO retention_decisions (table_name, decision, rationale) VALUES
  ('consent_documents', 'keep',
   'What there was to agree to. Deleting one leaves every consent recorded '
   'against it describing words nobody can produce.'),
  ('consent_records', 'keep',
   'The evidence that a person agreed, which has to outlive the processing it '
   'authorised — a consent record deleted on a schedule is a consent that '
   'cannot be demonstrated exactly when somebody asks.')
ON CONFLICT (table_name) DO NOTHING;

COMMIT;
