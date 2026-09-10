-- ============================================================================
--  065 — telling a customer something, on the device they already carry
--
--  WHAT WAS WRONG. There was exactly one way to reach a customer and it was
--  EMAIL. 012's outbox is correct and is the right shape for a receipt, a
--  reset code or a new-device alert — each of which is about one customer's
--  own account and is enqueued by the flow that owed it. What nothing could
--  do was tell everybody something: the app is down for an hour, a new
--  corridor is open, a rate has changed. An operator with news had a database
--  and no way to say it.
--
--  WHY A BROADCAST IS A ROW AND NOT A LOOP. Nothing here sends inline. 012
--  records the reason and it applies harder at this size: sending inside the
--  request makes an operator's click wait on ten thousand HTTP calls, and a
--  process dying halfway leaves nobody able to say who was reached. So a
--  broadcast is a row written by the endpoint and drained by a worker, which
--  is the outbox pattern with ONE row instead of one per recipient.
--
--  AND THAT IS DELIBERATE. 015 argues a row per call is the log it exists to
--  avoid, and a row per recipient per broadcast is exactly that: ten thousand
--  rows saying "delivered" that nobody will ever read individually. What is
--  worth keeping is the broadcast and its COUNTS — how many devices it went
--  to, how many the push service refused — which is what an operator asks.
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
--  A DEVICE IS AN ADDRESS, AND THE TOKEN IS NOT A SECRET OF OURS.
--
--  An Expo push token identifies one installation of one app on one handset.
--  It is issued by the push service to the app and handed to us, and holding
--  it lets somebody send a notification to that handset — nothing more. It
--  cannot read anything, cannot authorise anything, and is useless once the
--  app is uninstalled.
--
--  So it is stored in the clear, unlike a refresh token or a card code, and
--  the CHECK is a SHAPE check rather than a hash: `ExponentPushToken[...]` is
--  what the service issues, and a row that does not look like one is a bug in
--  the client rather than a token we should try to send to.
--
--  ONE ROW PER TOKEN, NOT PER CUSTOMER. A person has a phone and a tablet, and
--  a phone that has been factory reset is a new token for the same person.
--  Which is also why the token is the unique thing here and the customer is
--  not: two customers cannot hold one token, but one customer holds several.
--
--  AND A TOKEN CAN MOVE. Signing in on a handset somebody else used means that
--  token now belongs to the new account, so the write is an upsert on the
--  token that reassigns the owner. Leaving it pointed at the old account would
--  send one person's notifications to another person's phone.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS push_devices (
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id      BIGINT NOT NULL REFERENCES users(id),
    token        TEXT   NOT NULL,
    platform     TEXT   NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Refreshed every time the app reports the token, so a handset nobody has
    -- opened in a year is visible as such rather than counted as an audience.
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Set when the push service says `DeviceNotRegistered`, or when the
    -- customer signs out. NOT deleted: see the retirement comment below.
    revoked_at   TIMESTAMPTZ,

    CONSTRAINT push_devices_token_shape
      CHECK (token ~ '^ExponentPushToken\[[A-Za-z0-9_-]{1,64}\]$'),
    CONSTRAINT push_devices_platform_known
      CHECK (platform IN ('ios', 'android'))
);

CREATE UNIQUE INDEX IF NOT EXISTS push_devices_token ON push_devices (token);
CREATE INDEX IF NOT EXISTS push_devices_live
    ON push_devices (user_id) WHERE revoked_at IS NULL;

-- ---------------------------------------------------------------------------
--  RETIREMENT IS A COLUMN AND NOT A DELETE, and the reason is the same one
--  056 gives about a consumed code and 023 about an entry's status: "was this
--  handset ever registered to this account?" is a question about HISTORY. A
--  DELETE makes it a question about the present, and the one moment somebody
--  asks it is after a takeover, when the answer is evidence.
--
--  It is also what stops a retired token being silently re-registered by a
--  client that has cached it: the upsert clears `revoked_at` deliberately and
--  visibly, on a row whose `created_at` still says when the handset first
--  appeared.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
--  WHAT AN OPERATOR SENT, AND TO WHOM.
--
--  EVERY BROADCAST IS CONSENT-GATED, and there is deliberately no class of
--  broadcast that is not. 033 makes the outbox refuse a `marketing`-class
--  message to a customer with no live grant, BY TRIGGER, and the argument
--  there is that a consent nothing reads is a checkbox. The temptation here
--  is a dropdown — "service" or "announcement" — and that dropdown is how
--  every message becomes a service message on the afternoon somebody is in a
--  hurry.
--
--  The line that survives contact with a form is this one: a TRANSACTIONAL
--  message is about one customer's own transaction and is enqueued by the
--  FLOW that owed it, never typed into a box. Anything typed into a box and
--  sent to everybody is an announcement, whatever it says. So this table has
--  no class column at all, and `push_audience` is what a live marketing grant
--  answers.
--
--  A SECURITY MESSAGE IS NOT AFFECTED, because a security message is not sent
--  from here. Unsubscribing must never withhold a reset code, and nothing on
--  this path could: those go through 012's outbox from the flow that owed
--  them.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS push_broadcasts (
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    uuid         UUID NOT NULL DEFAULT gen_random_uuid(),

    title        TEXT NOT NULL,
    body         TEXT NOT NULL,

    -- NULL means every country. A code names one, and it is a FK so a typo is
    -- refused rather than sent to nobody and reported as "0 devices".
    country      CHAR(2) REFERENCES countries(code),

    -- Who pressed the button. Not nullable: an announcement to every customer
    -- of a business holding their money is not something that happens without
    -- a person, and 035's `prices_without_an_author` exists because a nullable
    -- one produced exactly that gap.
    created_by   BIGINT NOT NULL REFERENCES users(id),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- Set by the worker when it has finished. Until then this row IS the
    -- queue, which is why there is no status enum: `sent_at IS NULL` is the
    -- whole state machine.
    sent_at      TIMESTAMPTZ,

    -- What actually happened, in the shape 015 argues for: counts, not rows.
    devices      INTEGER NOT NULL DEFAULT 0,
    accepted     INTEGER NOT NULL DEFAULT 0,
    rejected     INTEGER NOT NULL DEFAULT 0,
    -- How many customers matched the audience and were SKIPPED for having no
    -- live marketing grant. Reported rather than hidden: an operator seeing
    -- "4,000 devices" where they expected 12,000 must be able to learn that
    -- the difference is consent and not a broken integration.
    without_consent INTEGER NOT NULL DEFAULT 0,

    -- The push service's own sentence when the whole send failed. It names our
    -- integration, so it goes to a row an operator reads and never to a
    -- customer — 006's rule.
    failure_reason TEXT,

    CONSTRAINT push_broadcasts_title_length
      CHECK (length(trim(title)) BETWEEN 3 AND 80),
    CONSTRAINT push_broadcasts_body_length
      CHECK (length(trim(body)) BETWEEN 3 AND 240),
    -- Counts cannot be negative, and what was accepted plus what was rejected
    -- cannot exceed what was attempted. A report that does not add up is worse
    -- than none, because it is read as fact.
    CONSTRAINT push_broadcasts_counts_sane
      CHECK (devices >= 0 AND accepted >= 0 AND rejected >= 0
             AND without_consent >= 0
             AND accepted + rejected <= devices)
);

CREATE UNIQUE INDEX IF NOT EXISTS push_broadcasts_uuid ON push_broadcasts (uuid);
CREATE INDEX IF NOT EXISTS push_broadcasts_pending
    ON push_broadcasts (created_at) WHERE sent_at IS NULL;

-- ---------------------------------------------------------------------------
--  APPEND-ONLY, WITH ONE OPENING: the worker must be able to record what it
--  did.
--
--  The words and the audience are IMMUTABLE once the row exists, because a
--  broadcast already sent whose text could be edited is a record that cannot
--  answer "what did you tell them?" — the argument 007 makes about a rate card
--  and 033 about a consent document. The counts and `sent_at` are what the
--  worker fills in, and they can be written exactly ONCE: a row that has been
--  sent cannot be sent again, which is what stops a redelivery becoming a
--  second announcement to every customer on the platform.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION push_broadcasts_are_append_only()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'push_broadcasts is append-only: a broadcast that was '
                        'sent cannot be unsent, and deleting the record does '
                        'not reach the handsets';
    END IF;

    IF NEW.title IS DISTINCT FROM OLD.title
       OR NEW.body IS DISTINCT FROM OLD.body
       OR NEW.country IS DISTINCT FROM OLD.country
       OR NEW.created_by IS DISTINCT FROM OLD.created_by
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'a broadcast''s words and audience are immutable: what '
                        'was sent is what was sent';
    END IF;

    IF OLD.sent_at IS NOT NULL THEN
        RAISE EXCEPTION 'this broadcast has already been sent: sending it '
                        'again would announce the same thing twice to every '
                        'customer it reached';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS push_broadcasts_append_only ON push_broadcasts;
CREATE TRIGGER push_broadcasts_append_only
    BEFORE UPDATE OR DELETE ON push_broadcasts
    FOR EACH ROW EXECUTE FUNCTION push_broadcasts_are_append_only();

-- ---------------------------------------------------------------------------
--  WHO A BROADCAST MAY REACH.
--
--  Live device, active customer, and a live marketing grant — the SAME
--  question 033's outbox trigger asks, expressed once here so the worker and
--  the estimate an operator reads before pressing the button cannot disagree
--  about the audience. Two copies of "who may be told" is two answers, and the
--  copy that drifts is the one that runs at 4am.
--
--  `country` is the CUSTOMER'S, not the device's. A Ghanaian on holiday is
--  still somebody Ghanaian news is for.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW push_audience AS
SELECT d.id        AS device_id,
       d.token,
       d.platform,
       u.id        AS user_id,
       u.country
  FROM push_devices d
  JOIN users u ON u.id = d.user_id
 WHERE d.revoked_at IS NULL
   AND u.status = 'active'
   AND EXISTS (
         SELECT 1
           FROM customer_consents c
          WHERE c.user_id = u.id
            AND c.kind = 'marketing_email'
            AND c.granted
       );

COMMENT ON VIEW push_audience IS
  'Every handset a broadcast may reach: a live token, an active customer and a '
  'live marketing grant. One definition, so the estimate an operator reads and '
  'the audience the worker sends to cannot differ.';

-- ---------------------------------------------------------------------------
--  036 refuses a view nobody classified, in both directions.
-- ---------------------------------------------------------------------------
INSERT INTO attention_sources (source, decision, rationale)
VALUES
  ('push_audience', 'internal',
   'Who a broadcast may reach. Read by the sending worker and by the estimate '
   'the compose screen shows; there is nothing here to work through.'),
  ('push_broadcasts_stuck', 'watch',
   'A broadcast an operator sent that the worker has not drained. Silent by '
   'construction: the row is written, the endpoint answers, and nothing is '
   'delivered if PUSH_BROADCAST_INTERVAL_SECONDS is unset on every instance.')
ON CONFLICT (source) DO NOTHING;

-- ---------------------------------------------------------------------------
--  AND THE FAILURE THAT IS INVISIBLE TO EVERYTHING ELSE.
--
--  `PUSH_BROADCAST_INTERVAL_SECONDS` unset means the row is written, the
--  endpoint answers 201, the screen says the broadcast was queued, and nothing
--  is ever sent. Nothing errors, because writing the row succeeded — the exact
--  shape `NOTIFICATION_INTERVAL_SECONDS` has, which the go-live checklist
--  files under `silent` for that reason.
--
--  This is the only thing that can see it.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW push_broadcasts_stuck AS
SELECT count(*)                        AS waiting,
       min(created_at)                 AS oldest_at,
       max(now() - created_at)         AS oldest_age
  FROM push_broadcasts
 WHERE sent_at IS NULL;

COMMENT ON VIEW push_broadcasts_stuck IS
  'Broadcasts written and never drained. Non-zero and ageing means no instance '
  'has PUSH_BROADCAST_INTERVAL_SECONDS set.';

-- ---------------------------------------------------------------------------
--  019 refuses a table with no retention decision, in both directions.
--
--  `push_devices` is `purge`: a push token is personal data (it identifies a
--  handset) and is worth nothing once retired, so it ages out rather than
--  being kept for ever — but it is not deleted the moment it is revoked,
--  because which handsets an account was registered on is evidence after a
--  takeover.
--
--  `push_broadcasts` is `keep`: it is the record of what this business told
--  its customers, which is exactly the sort of statement somebody later asks
--  to see.
-- ---------------------------------------------------------------------------
INSERT INTO retention_decisions (table_name, decision, rationale)
VALUES
  ('push_devices', 'purge',
   'A push token identifies a handset and is worthless once retired. Kept '
   'while it could still answer which devices an account was registered on, '
   'then aged out.'),
  ('push_broadcasts', 'keep',
   'What this business told its customers, and who sent it. A statement made '
   'to everybody is one somebody later asks to see.')
ON CONFLICT (table_name) DO NOTHING;

-- ---------------------------------------------------------------------------
--  How long a retired token is kept. A setting rather than a constant, for
--  009's reason, and bounded so it cannot be set to "for ever" by accident.
-- ---------------------------------------------------------------------------
INSERT INTO platform_settings
  (key, value, value_type, min_value, max_value, label, description, category, sensitive)
VALUES
  ('retention_push_devices_days', '365', 'integer', 30, 3650,
   'Keep revoked push tokens for (days)',
   'How long a token that has been revoked -- by a sign-out, or by the push '
   'service reporting the app gone -- is kept before the retention sweep '
   'removes it. Long enough to answer which handsets an account was '
   'registered on after a takeover.',
   'retention', TRUE)
ON CONFLICT (key) DO NOTHING;

/*
 * And the sweep that enforces it.
 *
 * `apply_retention()` is REPLACED rather than extended by a second function,
 * for 019's reason: a retention job in two pieces is a job where one piece
 * stops being called. The body below is 024's, with push devices appended, and
 * it still names every table it touches — no dynamic SQL, so a deletion job
 * whose behaviour could be changed by an INSERT does not exist.
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

    -- A REVOKED PUSH TOKEN AGES OUT; A LIVE ONE NEVER DOES. The window is
    -- measured from `revoked_at`, not from `created_at`: a handset registered
    -- three years ago and still in somebody's pocket is an address we need,
    -- and deleting it would silently stop that customer being reachable.
    SELECT value::INT INTO v_days FROM platform_settings
     WHERE key = 'retention_push_devices_days';
    DELETE FROM push_devices
     WHERE revoked_at IS NOT NULL
       AND revoked_at < now() - make_interval(days => v_days);
    GET DIAGNOSTICS v_count = ROW_COUNT;
    RETURN QUERY SELECT 'push_devices'::TEXT, v_count;
END;
$$;


-- ---------------------------------------------------------------------------
--  THE ONE CREDENTIAL, AND IT IS USUALLY NOT NEEDED.
--
--  Expo's push API is UNAUTHENTICATED by default: a push token is an
--  unguessable address, and possession of one is the authorisation to send to
--  it. An access token is required only when the Expo account has Enhanced
--  Security switched on — so the slot exists, is documented, and an empty one
--  is the ordinary state rather than a gap.
--
--  026's order applies: the database is authoritative and `EXPO_ACCESS_TOKEN`
--  is the fallback.
-- ---------------------------------------------------------------------------
INSERT INTO provider_credential_slots
  (provider, name, label, description, env_var, in_use)
VALUES
  ('expo', 'access_token', 'Expo push access token',
   'Needed ONLY if the Expo account has Enhanced Security switched on. Push '
   'notifications work without it: a token is an unguessable address and Expo '
   'treats holding one as the authorisation to send to that handset. Leaving '
   'this empty is the ordinary state.',
   'EXPO_ACCESS_TOKEN', TRUE)
ON CONFLICT (provider, name) DO UPDATE
   SET label       = EXCLUDED.label,
       description = EXCLUDED.description,
       env_var     = EXCLUDED.env_var,
       in_use      = EXCLUDED.in_use;

COMMIT;
