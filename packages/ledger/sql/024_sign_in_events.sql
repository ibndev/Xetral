-- ============================================================================
--  024 — Where a sign-in came from.
--
--  WHAT WAS MISSING. Nothing recorded the address a session was opened from.
--  `auth_sessions` knows the user and the device; `devices` knows the
--  fingerprint. Neither knows WHERE, and neither records the attempts that
--  FAILED — which is the half that shows an attack in progress. A password
--  sprayed across four hundred accounts from one address produces four hundred
--  failures and no rows at all, so the first evidence of it is a customer
--  ringing up about money that has gone.
--
--  Three things follow from having this table:
--
--    * a sign-in from a country or an address this customer has never used is
--      something to TELL THEM, at the moment they can still act on it;
--    * one address failing against many DIFFERENT identifiers is credential
--      stuffing, and is invisible from any single account;
--    * two accounts signing in from one address, or one device, is the
--      multi-account correlation `025` builds on.
--
--  WHERE THE COUNTRY COMES FROM, and why it is not a geolocation lookup.
--  Cloudflare sits in front of this platform and sets `CF-IPCountry` on every
--  request it forwards: ISO 3166-1 alpha-2, `XX` when it cannot tell, `T1` for
--  Tor. That is a value the edge already computes, so taking it costs no
--  provider, no IP database to keep current, and no second thing to be down.
--  It is trusted on exactly the same terms as `x-forwarded-for`: it means
--  something only because the only route to this API is through the edge, and
--  a request that did not come through it carries whatever its sender typed.
--  So it describes a sign-in and NEVER authorises one — the same sentence
--  `auth.service.ts` already carries about the address.
--
--  THE IDENTIFIER IS HASHED, and that is not symmetry with password hashing.
--  A failed sign-in against an address that matched no account is somebody
--  else's email in our database, put there by whoever guessed it. Storing
--  those in the clear turns this table into a list of addresses under attack —
--  useful to precisely one kind of reader.
-- ============================================================================

-- The alert this table makes possible. Outside a transaction and unusable in
-- the same one, the same rule 013, 015 and 017 all record.
ALTER TYPE notification_kind ADD VALUE IF NOT EXISTS 'new_location';

BEGIN;

CREATE TYPE sign_in_outcome AS ENUM (
    'succeeded',
    /** The identifier matched an account and the password did not. */
    'bad_credentials',
    /** No account. Recorded, because the guessing is the signal. */
    'unknown_identifier',
    /** A real account we refused for its own reasons: closed, frozen. */
    'refused'
);

CREATE TABLE sign_in_events (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

    /**
     * NULL when the identifier matched nobody.
     *
     * Deliberately nullable rather than split into two tables: the question
     * this table is asked is "what has this address been doing", and an answer
     * that omits the attempts against accounts that do not exist omits the
     * shape of the attack.
     */
    user_id         BIGINT      NULL REFERENCES users(id),

    /** SHA-256 of the lower-cased identifier. Equal hashes mean equal
     *  identifiers, which is all the correlation needs. */
    identifier_hash TEXT        NOT NULL CHECK (identifier_hash ~ '^[0-9a-f]{64}$'),

    /**
     * INET rather than TEXT, so `<<` against a network works and so a value
     * that is not an address cannot be stored at all. NULL when the request
     * carried no forwarded address — which on this platform means it did not
     * come through the edge, and is itself worth being able to see.
     */
    ip              INET        NULL,

    /** From `CF-IPCountry`. Two characters, uppercase; `XX` unknown, `T1` Tor. */
    country         TEXT        NULL CHECK (country ~ '^[A-Z0-9]{2}$'),

    platform        TEXT        NULL CHECK (platform IN ('ios', 'android', 'web')),
    device_id       BIGINT      NULL REFERENCES devices(id),

    outcome         sign_in_outcome NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- "What has this account been doing" and "what has this address been doing"
-- are the two questions asked, and both are asked newest-first.
CREATE INDEX sign_in_events_user ON sign_in_events (user_id, created_at DESC)
    WHERE user_id IS NOT NULL;
CREATE INDEX sign_in_events_ip   ON sign_in_events (ip, created_at DESC)
    WHERE ip IS NOT NULL;
CREATE INDEX sign_in_events_identifier
    ON sign_in_events (identifier_hash, created_at DESC);

/**
 * Append-only, with the one relaxation 019 established for spent TOTP steps.
 *
 * The rule matters here for the same reason it matters on the audit log: this
 * is the table somebody reads to reconstruct an incident, and one a privileged
 * user can edit tells you what the last person with access wanted you to
 * believe. Deleting the FAILURES in particular would leave a perfectly clean
 * record of a successful takeover.
 *
 * But this is also personal data with a bounded useful life, so it has to be
 * purgeable — and a flat refusal would make the retention sweep fail on it,
 * exactly as it did on `staff_totp_used_steps`. So: an UPDATE is refused at
 * any age, because rewriting where a sign-in came from is the edit this table
 * exists to prevent; a DELETE is refused unless the row is older than the
 * retention window the sweep itself reads. Nothing can delete selectively,
 * and nothing can delete anything recent.
 *
 * No configured window means no deletions at all. Refusing beats guessing.
 */
CREATE OR REPLACE FUNCTION assert_sign_in_event_append_only() RETURNS TRIGGER AS $$
DECLARE v_days INT;
BEGIN
    IF TG_OP = 'DELETE' THEN
        SELECT value::INT INTO v_days FROM platform_settings
         WHERE key = 'retention_sign_in_events_days';

        IF v_days IS NOT NULL AND OLD.created_at < now() - make_interval(days => v_days) THEN
            RETURN OLD;
        END IF;
    END IF;

    RAISE EXCEPTION
        'a sign-in event cannot be % — it is the record somebody reads to '
        'reconstruct an incident', lower(TG_OP)
        USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER sign_in_events_append_only
    BEFORE UPDATE OR DELETE ON sign_in_events
    FOR EACH ROW EXECUTE FUNCTION assert_sign_in_event_append_only();

/**
 * Whether this account has ever been seen at this place before.
 *
 * Two questions, not one, because they fail differently. A customer's address
 * changes every time their phone hands over between masts, so a new ADDRESS is
 * routine and worth mentioning at most. A new COUNTRY on a Nigerian retail
 * account is rare and worth an alert.
 *
 * Read from SUCCEEDED events only. Counting the failures would make one
 * guess from an address enough to make that address familiar, which is the
 * exact opposite of what this is for.
 */
CREATE OR REPLACE FUNCTION sign_in_is_familiar(
    p_user_id BIGINT,
    p_ip      INET,
    p_country TEXT
) RETURNS TABLE (ip_seen_before BOOLEAN, country_seen_before BOOLEAN) AS $$
BEGIN
    RETURN QUERY SELECT
        p_ip IS NULL OR EXISTS (
            SELECT 1 FROM sign_in_events
             WHERE user_id = p_user_id AND outcome = 'succeeded' AND ip = p_ip
        ),
        p_country IS NULL OR EXISTS (
            SELECT 1 FROM sign_in_events
             WHERE user_id = p_user_id AND outcome = 'succeeded' AND country = p_country
        );
END;
$$ LANGUAGE plpgsql STABLE;

/**
 * One address guessing at many accounts.
 *
 * Counted on DISTINCT identifiers rather than on attempts, because the login
 * rate limiter already caps attempts per identifier — which is what makes an
 * attacker spread across identifiers instead, and makes the spread the thing
 * worth counting. Both outcomes are included: guessing at addresses that do
 * not exist is the same behaviour as guessing at ones that do.
 *
 * A view, not a stored counter: the window moves, and a counter that has to be
 * decremented is a counter that eventually is not.
 */
CREATE VIEW credential_stuffing_sources AS
SELECT ip,
       count(DISTINCT identifier_hash)   AS identifiers_tried,
       count(*)                          AS attempts,
       count(*) FILTER (WHERE outcome = 'succeeded') AS succeeded,
       min(created_at)                   AS first_seen,
       max(created_at)                   AS last_seen
  FROM sign_in_events
 WHERE ip IS NOT NULL
   AND outcome IN ('bad_credentials', 'unknown_identifier', 'succeeded')
   AND created_at > now() - interval '24 hours'
 GROUP BY ip
HAVING count(DISTINCT identifier_hash) >= 5
 ORDER BY count(DISTINCT identifier_hash) DESC;

/**
 * Accounts that have signed in successfully from one address.
 *
 * NOT evidence of abuse on its own, and the view says so rather than being
 * named as though it were: a Nigerian carrier puts whole subscriber pools
 * behind a handful of addresses — the same fact that made the request rate
 * limiter count per customer rather than per address — so a shared address is
 * ordinary. It is a lead for a reviewer holding another reason to look, which
 * is why it reports the accounts rather than acting on them.
 */
CREATE VIEW accounts_sharing_an_address AS
SELECT ip,
       count(DISTINCT user_id) AS accounts,
       array_agg(DISTINCT user_id ORDER BY user_id) AS user_ids,
       max(created_at) AS last_seen
  FROM sign_in_events
 WHERE ip IS NOT NULL AND user_id IS NOT NULL AND outcome = 'succeeded'
   AND created_at > now() - interval '30 days'
 GROUP BY ip
HAVING count(DISTINCT user_id) > 1
 ORDER BY count(DISTINCT user_id) DESC;

/**
 * Accounts sharing a DEVICE, which is a much stronger claim than an address.
 *
 * `devices.fingerprint_hash` is unique per (user, fingerprint), so one
 * fingerprint appearing under several users means one handset enrolled on
 * several accounts. A family sharing a phone is real and is why this reports
 * rather than refuses — but it is also exactly what one person opening
 * accounts to collect a signup bonus, or a mule farm, looks like.
 */
CREATE VIEW accounts_sharing_a_device AS
SELECT fingerprint_hash,
       count(DISTINCT user_id) AS accounts,
       array_agg(DISTINCT user_id ORDER BY user_id) AS user_ids,
       min(first_seen_at) AS first_seen,
       max(last_seen_at)  AS last_seen
  FROM devices
 GROUP BY fingerprint_hash
HAVING count(DISTINCT user_id) > 1
 ORDER BY count(DISTINCT user_id) DESC;

/**
 * Retention: this is personal data, and it is the kind whose usefulness has a
 * horizon. The decision lives in THIS migration rather than being added to
 * 019, so a table and the reason it is kept arrive together — a decision
 * written somewhere else is one the next table's author does not know to make.
 */
INSERT INTO retention_decisions (table_name, decision, rationale) VALUES
  ('sign_in_events', 'purge',
   'Addresses and hashed identifiers: personal data under the NDPA, with a '
   'real but bounded investigative life. Purged on age by apply_retention(), '
   'and never selectively — a trail somebody can delete rows FROM is a trail '
   'that says what the last person with access wanted it to say.')
ON CONFLICT (table_name) DO NOTHING;

INSERT INTO platform_settings
  (key, value, value_type, min_value, max_value, label, description, category, sensitive)
VALUES
  ('retention_sign_in_events_days', '365', 'integer', 30, 3650,
   'Keep sign-in events for (days)',
   'How long the record of where each sign-in came from is kept. Long enough '
   'that "has this account ever been used from this country?" has a real '
   'answer, and long enough to reconstruct an incident somebody reports late.',
   'retention', TRUE)
ON CONFLICT (key) DO NOTHING;

/**
 * And the sweep that enforces it.
 *
 * `apply_retention()` is REPLACED rather than extended by a second function,
 * because a retention job in two pieces is a job where one piece stops being
 * called. The body below is 019's, with sign-in events appended — and it still
 * NAMES every table it deletes from, with no dynamic SQL, so a deletion job's
 * behaviour cannot be changed by an INSERT.
 */
CREATE OR REPLACE FUNCTION apply_retention()
RETURNS TABLE (table_name TEXT, deleted BIGINT) AS $$
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
    -- Permitted by the trigger only for rows past this same window, so the
    -- sweep and the invariant read one setting and cannot disagree about
    -- which rows are still evidence.
    DELETE FROM sign_in_events WHERE created_at < now() - make_interval(days => v_days);
    GET DIAGNOSTICS v_count = ROW_COUNT;
    RETURN QUERY SELECT 'sign_in_events'::TEXT, v_count;
END;
$$ LANGUAGE plpgsql;

COMMIT;
