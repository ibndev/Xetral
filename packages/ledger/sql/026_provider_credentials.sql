-- ============================================================================
--  026 — Provider credentials an operator can set without a deploy.
--
--  WHY THIS IS NOT A `platform_settings` ROW. That table is exactly the right
--  place for a fee or a ceiling and exactly the wrong place for a secret, for
--  two reasons that are both features of it:
--
--    * `platform_settings_history` is APPEND-ONLY and records every value the
--      row has ever held. Rotating an API key would leave the compromised one
--      in that table permanently — which is the opposite of what rotating is
--      for.
--    * `POST /v1/admin/settings/:key` writes the new value into
--      `admin_audit_log`, which is also append-only. So would every key.
--
--  Neither is a bug in those tables. A fee's history is the point; a secret's
--  history is a liability. So credentials get their own store, where the value
--  is SEALED, the history records WHO AND WHEN AND NEVER WHAT, and there is no
--  endpoint anywhere that reads a secret back out.
--
--  WHAT AN OPERATOR SEES is a HINT — the last four characters — which is
--  enough to answer "is this the key I pasted?" and useless to anybody who
--  reads it over a shoulder or finds it in a screenshot. The same reasoning as
--  `cards.last4`, and the same CHECK-shaped enforcement.
--
--  THE DATABASE IS AUTHORITATIVE AND THE ENVIRONMENT IS THE FALLBACK, matching
--  `platform_settings`. That is what lets a key be replaced during an incident
--  without a deploy — and it fails silently in the other direction, so
--  bootstrap logs a warning naming every environment credential the database
--  is overriding, exactly as it already does for settings.
-- ============================================================================

BEGIN;

/**
 * The credential slots this platform knows about.
 *
 * A catalogue rather than free text, so the dashboard can render "Dojah — not
 * set" without anybody having to know what the key is called, and so a typo in
 * a slot name is refused rather than silently creating a credential nothing
 * reads. Adding a provider means adding a row here, which is a migration —
 * appropriate, because it is a code change too.
 */
CREATE TABLE provider_credential_slots (
    provider    TEXT NOT NULL,
    name        TEXT NOT NULL,

    label       TEXT NOT NULL,
    description TEXT NOT NULL,
    /** The environment variable this slot falls back to, for the bootstrap
     *  warning and for the operator who is looking for where it used to live. */
    env_var     TEXT NOT NULL,
    /** FALSE for a slot that is documented but not yet wired to an adapter —
     *  so an operator can paste a key before the integration lands, and the
     *  dashboard can say which is which rather than implying it is live. */
    in_use      BOOLEAN NOT NULL DEFAULT TRUE,

    PRIMARY KEY (provider, name)
);

CREATE TABLE provider_credentials (
    provider      TEXT        NOT NULL,
    name          TEXT        NOT NULL,

    /**
     * Sealed with the key-versioned envelope, same as a BVN and a gift card
     * code. The CHECK is what makes "never stored in the clear" structural: a
     * plaintext key cannot reach this column even from psql.
     */
    secret_sealed TEXT        NOT NULL CHECK (secret_sealed ~ '^v[0-9]+:'),

    /**
     * The last four characters, and nothing else that could be part of a key.
     *
     * Four, not eight, and the CHECK is the enforcement: "just enough to
     * recognise it" becomes "most of it" the first time somebody is debugging
     * in a hurry, and then a dashboard screenshot carries a working
     * credential. The same lesson `cards.last4` records.
     */
    hint          TEXT        NOT NULL CHECK (hint ~ '^[A-Za-z0-9_.\-]{0,4}$'),

    updated_by    BIGINT      NULL REFERENCES users(id),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

    PRIMARY KEY (provider, name),
    FOREIGN KEY (provider, name) REFERENCES provider_credential_slots (provider, name)
);

/**
 * That a credential was replaced, by whom, and when. NEVER what it was.
 *
 * This is the whole difference from `platform_settings_history`. The question
 * this table has to answer during an incident is "was this key changed, and by
 * whom?" — and it answers it without becoming a list of every key the platform
 * has ever held.
 */
CREATE TABLE provider_credential_rotations (
    id          BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    provider    TEXT        NOT NULL,
    name        TEXT        NOT NULL,
    /** NULL the first time a slot is filled. */
    old_hint    TEXT        NULL,
    new_hint    TEXT        NOT NULL,
    changed_by  BIGINT      NULL REFERENCES users(id),
    changed_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX provider_credential_rotations_slot
    ON provider_credential_rotations (provider, name, changed_at DESC);

/**
 * Append-only, for the same reason the audit log is: a record of who changed a
 * credential is worth what its immutability is worth.
 */
CREATE OR REPLACE FUNCTION refuse_credential_rotation_change() RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'provider_credential_rotations is append-only; % is refused', TG_OP
        USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER provider_credential_rotations_append_only
    BEFORE UPDATE OR DELETE ON provider_credential_rotations
    FOR EACH ROW EXECUTE FUNCTION refuse_credential_rotation_change();

/** Written by trigger rather than by the endpoint, so a credential cannot be
 *  replaced without the rotation being recorded — including from psql. */
CREATE OR REPLACE FUNCTION record_credential_rotation() RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO provider_credential_rotations
      (provider, name, old_hint, new_hint, changed_by)
    VALUES (NEW.provider, NEW.name,
            CASE WHEN TG_OP = 'UPDATE' THEN OLD.hint ELSE NULL END,
            NEW.hint, NEW.updated_by);
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER provider_credentials_rotation_recorded
    AFTER INSERT OR UPDATE ON provider_credentials
    FOR EACH ROW EXECUTE FUNCTION record_credential_rotation();

/**
 * What the dashboard renders: every slot, and whether it is filled.
 *
 * A LEFT JOIN, so an empty slot appears as a row saying "not set" rather than
 * as nothing at all. A settings page that lists only what is configured is a
 * page on which a missing credential is invisible — which is the failure this
 * whole table exists to make impossible to overlook.
 *
 * `secret_sealed` is deliberately absent. There is no path from an HTTP
 * response to a key: not sealed, not masked, not partially. The adapter reads
 * the row in process, and nothing else does.
 */
CREATE VIEW provider_credential_status AS
SELECT s.provider,
       s.name,
       s.label,
       s.description,
       s.env_var,
       s.in_use,
       (c.provider IS NOT NULL) AS is_set,
       c.hint,
       c.updated_at,
       c.updated_by
  FROM provider_credential_slots s
  LEFT JOIN provider_credentials c
    ON c.provider = s.provider AND c.name = s.name
 ORDER BY s.provider, s.name;

INSERT INTO retention_decisions (table_name, decision, rationale) VALUES
  ('provider_credential_slots', 'keep',
   'The catalogue of what credentials exist. A row here is a fact about how '
   'this platform is built, not personal data, and deleting one would orphan '
   'the credential that references it.'),
  ('provider_credentials', 'keep',
   'Live credentials. They go when the integration goes, not on an age: a key '
   'deleted by a scheduled job is an outage nobody scheduled.'),
  ('provider_credential_rotations', 'keep',
   'Who replaced a provider credential and when, which is the question asked '
   'during an incident. It holds no secret and no personal data beyond a staff '
   'id, and a trail a job can delete from is one an intruder can prune.')
ON CONFLICT (table_name) DO NOTHING;

COMMIT;
