-- ===========================================================================
--  Xetral — an email address is PROVED before an account is opened on it
--  packages/ledger/sql/084_signup_email_codes.sql
--
--  WHAT WAS WRONG: registration took any address as typed. A mistyped one
--  opened an account whose owner could never receive a reset code, a receipt
--  or a new-device alert — the security mail this platform depends on, sent
--  to somebody else or to nobody. And the address is the key a Paystack
--  customer and a dedicated account number are opened against, the moment
--  "Create account" is pressed.
--
--  SO THE ADDRESS IS PROVED FIRST: a six-digit code is mailed to it and the
--  account is opened only with that code. 056's construction, for the same
--  reasons, applied to an address with no account behind it yet:
--
--    1. THE STORED HASH IS KEYED (an HMAC), so a dump is not an offline attack
--       on a million possibilities.
--    2. THE ATTEMPT CEILING IS A COLUMN, charged against EVERY live code for
--       the address — a wrong guess matches no row, so a per-row counter would
--       never be charged by the attack it exists to stop.
--    3. The per-address rate limit on the endpoint that mails it.
--
--  CONSUMED ON THE REGISTRATION'S OWN TRANSACTION, by the function below, so
--  a code cannot be spent by a registration that then rolls back, and two
--  registrations racing with one code cannot both succeed.
--
--  A SWITCH, DEFAULT ON. Requiring a code makes signup depend on email being
--  delivered, and a deployment whose mail has stopped would stop taking
--  customers with it. `signup_email_verification` is how an operator keeps
--  signups open during that incident — the argument 009 makes about any
--  operational decision taken under pressure.
-- ===========================================================================

-- Outside the transaction: a value added to an enum cannot be USED in the
-- transaction that added it (056's note).
ALTER TYPE notification_kind ADD VALUE IF NOT EXISTS 'signup_code';

BEGIN;

CREATE TABLE IF NOT EXISTS signup_email_codes (
    id          BIGSERIAL PRIMARY KEY,
    -- Lower-cased, because registration lower-cases, and a code mailed to
    -- `Ada@x.ng` must prove `ada@x.ng`.
    email       TEXT NOT NULL CHECK (email = lower(email) AND email LIKE '%_@_%'),
    code_hash   TEXT NOT NULL CHECK (code_hash ~ '^[0-9a-f]{64}$'),
    attempts    SMALLINT NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    expires_at  TIMESTAMPTZ NOT NULL,
    consumed_at TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (expires_at > created_at)
);

CREATE INDEX IF NOT EXISTS signup_email_codes_live
    ON signup_email_codes (email, created_at DESC) WHERE consumed_at IS NULL;

-- A spent code stays spent, and the ceiling only goes up — 056's trigger, for
-- the same two holes.
CREATE OR REPLACE FUNCTION assert_signup_code_append_only() RETURNS TRIGGER AS $$
BEGIN
    IF OLD.consumed_at IS NOT NULL AND NEW.consumed_at IS DISTINCT FROM OLD.consumed_at THEN
        RAISE EXCEPTION 'a spent signup code cannot be un-spent' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.attempts < OLD.attempts THEN
        RAISE EXCEPTION 'signup code attempts only go up' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.email IS DISTINCT FROM OLD.email OR NEW.code_hash IS DISTINCT FROM OLD.code_hash
       OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
        RAISE EXCEPTION 'a signup code''s address, hash and expiry are immutable'
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS signup_email_codes_append_only ON signup_email_codes;
CREATE TRIGGER signup_email_codes_append_only
    BEFORE UPDATE ON signup_email_codes
    FOR EACH ROW EXECUTE FUNCTION assert_signup_code_append_only();

/*
 * Spend a code, or say why not.
 *
 * TWO CALLS PER REGISTRATION, and the split is the point. A wrong code makes
 * the registration throw, and a throw ROLLS BACK its transaction — taking the
 * attempt charge with it, so a ceiling charged there would never accrue. So
 * the code is first CHECKED on its own connection with `p_consume` false,
 * where a wrong guess is charged and committed, and only then SPENT on the
 * registration's own transaction with `p_consume` true.
 *
 *   matched            (check only) it matches a live code; nothing is spent
 *   consumed           it matched a live code, which is now spent
 *   wrong              no live code matched; every live code was charged
 *   too_many_attempts  the ceiling was reached; nothing is spent by guessing
 *   none               there is no live code for this address to guess at
 *
 * The live rows are LOCKED before they are read, so two registrations
 * presenting one code serialise and exactly one of them consumes it.
 */
-- An earlier draft took three arguments; the default on the fourth would make
-- a three-argument call ambiguous between the two.
DROP FUNCTION IF EXISTS consume_signup_email_code(TEXT, TEXT, INT);

CREATE OR REPLACE FUNCTION consume_signup_email_code(
    p_email TEXT,
    p_hash  TEXT,
    p_max_attempts INT,
    p_consume BOOLEAN DEFAULT TRUE
) RETURNS TEXT AS $$
DECLARE
    v_live  INT;
    v_worst INT;
    v_id    BIGINT;
BEGIN
    PERFORM 1 FROM signup_email_codes
      WHERE email = p_email AND consumed_at IS NULL AND expires_at > now()
      FOR UPDATE;

    SELECT count(*), COALESCE(max(attempts), 0) INTO v_live, v_worst
      FROM signup_email_codes
     WHERE email = p_email AND consumed_at IS NULL AND expires_at > now();

    IF v_live = 0 THEN
        RETURN 'none';
    END IF;
    IF v_worst >= p_max_attempts THEN
        RETURN 'too_many_attempts';
    END IF;

    SELECT id INTO v_id FROM signup_email_codes
     WHERE email = p_email AND code_hash = p_hash
       AND consumed_at IS NULL AND expires_at > now()
     LIMIT 1;

    IF v_id IS NULL THEN
        UPDATE signup_email_codes SET attempts = attempts + 1
         WHERE email = p_email AND consumed_at IS NULL AND expires_at > now();
        RETURN 'wrong';
    END IF;

    IF NOT p_consume THEN
        RETURN 'matched';
    END IF;
    UPDATE signup_email_codes SET consumed_at = now() WHERE id = v_id;
    RETURN 'consumed';
END;
$$ LANGUAGE plpgsql;

-- When the address was proved. NULL for every account opened before this, and
-- for any opened while the switch was off: not a claim either way.
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ;

INSERT INTO platform_settings
    (key, value, value_type, min_value, max_value, label, description, category,
     sensitive)
VALUES (
    'signup_email_verification', 'true', 'boolean', NULL, NULL,
    'Verify email at signup',
    'Mails a six-digit code to the address a customer signs up with, and opens '
    'the account only with that code. Turn it off only while email is not '
    'being delivered — otherwise nobody can sign up until it is.',
    'features',
    -- Sensitive: off, accounts open on addresses nobody has proved.
    TRUE
)
ON CONFLICT (key) DO NOTHING;

INSERT INTO retention_decisions (table_name, decision, rationale)
VALUES
  ('signup_email_codes', 'purge',
   'A six-digit code that proved an address for a few minutes. Worthless once '
   'spent or expired, and aged out on the same window as reset codes.')
ON CONFLICT (table_name) DO NOTHING;

/*
 * The sweep, REPLACED rather than extended — 065's body with signup codes
 * appended on the tokens window, still naming every table it touches.
 */
CREATE OR REPLACE FUNCTION public.apply_retention()
 RETURNS TABLE(table_name text, deleted bigint)
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $$
DECLARE
    v_hours   INT;
    v_days    INT;
    v_count   BIGINT;
BEGIN
    SELECT value::INT INTO v_hours FROM platform_settings
     WHERE key = 'retention_totp_steps_hours';
    IF v_hours IS NULL THEN
        RAISE EXCEPTION 'retention settings are not configured; refusing to delete anything';
    END IF;

    DELETE FROM staff_totp_used_steps WHERE used_at < now() - make_interval(hours => v_hours);
    GET DIAGNOSTICS v_count = ROW_COUNT;
    RETURN QUERY SELECT 'staff_totp_used_steps'::TEXT, v_count;

    SELECT value::INT INTO v_days FROM platform_settings WHERE key = 'retention_tokens_days';
    DELETE FROM refresh_tokens
     WHERE (consumed_at IS NOT NULL OR expires_at < now())
       AND issued_at < now() - make_interval(days => v_days);
    GET DIAGNOSTICS v_count = ROW_COUNT;
    RETURN QUERY SELECT 'refresh_tokens'::TEXT, v_count;

    DELETE FROM password_reset_tokens
     WHERE (consumed_at IS NOT NULL OR expires_at < now())
       AND issued_at < now() - make_interval(days => v_days);
    GET DIAGNOSTICS v_count = ROW_COUNT;
    RETURN QUERY SELECT 'password_reset_tokens'::TEXT, v_count;

    DELETE FROM signup_email_codes
     WHERE (consumed_at IS NOT NULL OR expires_at < now())
       AND created_at < now() - make_interval(days => v_days);
    GET DIAGNOSTICS v_count = ROW_COUNT;
    RETURN QUERY SELECT 'signup_email_codes'::TEXT, v_count;

    SELECT value::INT INTO v_days FROM platform_settings
     WHERE key = 'retention_notifications_days';
    DELETE FROM notification_outbox
     WHERE status IN ('sent', 'abandoned')
       AND created_at < now() - make_interval(days => v_days);
    GET DIAGNOSTICS v_count = ROW_COUNT;
    RETURN QUERY SELECT 'notification_outbox'::TEXT, v_count;

    SELECT value::INT INTO v_days FROM platform_settings
     WHERE key = 'retention_error_events_days';
    DELETE FROM error_events
     WHERE resolved_at IS NOT NULL
       AND last_seen_at < now() - make_interval(days => v_days);
    GET DIAGNOSTICS v_count = ROW_COUNT;
    RETURN QUERY SELECT 'error_events'::TEXT, v_count;

    SELECT value::INT INTO v_days FROM platform_settings
     WHERE key = 'retention_card_declines_days';
    DELETE FROM card_declines WHERE created_at < now() - make_interval(days => v_days);
    GET DIAGNOSTICS v_count = ROW_COUNT;
    RETURN QUERY SELECT 'card_declines'::TEXT, v_count;

    SELECT value::INT INTO v_days FROM platform_settings
     WHERE key = 'retention_sign_in_events_days';
    DELETE FROM sign_in_events WHERE created_at < now() - make_interval(days => v_days);
    GET DIAGNOSTICS v_count = ROW_COUNT;
    RETURN QUERY SELECT 'sign_in_events'::TEXT, v_count;

    SELECT value::INT INTO v_days FROM platform_settings
     WHERE key = 'retention_push_devices_days';
    DELETE FROM push_devices
     WHERE revoked_at IS NOT NULL
       AND revoked_at < now() - make_interval(days => v_days);
    GET DIAGNOSTICS v_count = ROW_COUNT;
    RETURN QUERY SELECT 'push_devices'::TEXT, v_count;
END;
$$;

COMMIT;
