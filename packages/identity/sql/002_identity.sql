-- ===========================================================================
--  Xetral — Phase 2: Identity & auth
--  packages/identity/sql/002_identity.sql
--
--  Users, devices, sessions, refresh tokens, transaction PINs, biometrics.
--
--  The ledger proves where money IS. This file proves who was allowed to move
--  it. Both halves have to hold; a perfect ledger with a forgeable session is
--  a perfect record of a theft.
--
--  The load-bearing decision here is section 4: refresh token rotation and
--  reuse detection are a DATABASE FUNCTION, not service code. The reason is
--  the same one that put the ledger's invariants in triggers — the check that
--  matters is a race, and only the database can win a race.
-- ===========================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. USERS AND CREDENTIALS
--
-- Login credentials and the transaction PIN are SEPARATE TABLES, and that
-- separation is deliberate rather than tidiness. A single `users` row holding
-- both invites code that fetches the row for a login check and now has the
-- PIN hash in memory, in a log line, in a serialised error. Splitting them
-- means the PIN is only ever loaded by the code that is about to verify a
-- PIN, and a `SELECT *` on the login path cannot leak it.
-- ---------------------------------------------------------------------------

CREATE TYPE user_status AS ENUM (
  'pending_verification',  -- registered, not yet allowed to move money
  'active',
  'frozen',                -- compliance hold; can read, cannot transact
  'closed'
);

CREATE TABLE users (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    uuid        UUID        NOT NULL DEFAULT gen_random_uuid(),

    -- Nullable individually, but at least one is required: Nigerian onboarding
    -- is phone-first and an email is often added later, while a web signup
    -- arrives the other way round. Demanding both up front loses real users;
    -- demanding neither leaves an account nobody can recover.
    email       TEXT        NULL,
    phone       TEXT        NULL,

    status      user_status NOT NULL DEFAULT 'pending_verification',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT users_uuid_key UNIQUE (uuid),
    CONSTRAINT users_has_an_identifier CHECK (email IS NOT NULL OR phone IS NOT NULL)
);

-- Case-insensitive uniqueness without the citext extension. Two accounts on
-- 'Ada@x.com' and 'ada@x.com' are one person and one support ticket.
CREATE UNIQUE INDEX users_email_unique ON users (lower(email)) WHERE email IS NOT NULL;
CREATE UNIQUE INDEX users_phone_unique ON users (phone) WHERE phone IS NOT NULL;

-- The ledger's accounts.owner_id refers to users.id with owner_type='user'.
-- Deliberately not a foreign key: owner_type is polymorphic there, and a FK
-- would force every future owner kind into this one table.

-- Every stored secret carries a version prefix ('v1:'), checked here rather
-- than trusted. Without the constraint, one code path writing a bare hash is
-- invisible until the day the algorithm is rotated and that row cannot be
-- identified as belonging to the old scheme.
CREATE TABLE user_credentials (
    user_id             BIGINT      PRIMARY KEY REFERENCES users(id),
    password_hash       TEXT        NOT NULL CHECK (password_hash ~ '^v[0-9]+:'),
    password_changed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- 2. TRANSACTION PIN
--
-- Separate from login, and separate for a reason that is a product decision
-- and not a technical one: signing in and moving money are different acts,
-- and a phone left unlocked on a table should not be able to do the second
-- just because it did the first.
--
-- Biometrics UNLOCK this PIN; they do not replace it. Section 6 enforces
-- that structurally.
-- ---------------------------------------------------------------------------

CREATE TABLE transaction_pins (
    user_id          BIGINT      PRIMARY KEY REFERENCES users(id),
    pin_hash         TEXT        NOT NULL CHECK (pin_hash ~ '^v[0-9]+:'),

    -- Lockout state lives with the PIN rather than in a cache, because a
    -- cache is exactly what an attacker's retry loop outlives. A restart
    -- must not hand anybody a fresh five attempts.
    failed_attempts  INT         NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
    locked_until     TIMESTAMPTZ NULL,

    set_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_verified_at TIMESTAMPTZ NULL
);

-- Raises if the PIN is locked. Called before any verification attempt, so a
-- locked account cannot be probed at all -- not even to learn whether a
-- guess was right.
CREATE OR REPLACE FUNCTION assert_pin_unlocked(p_user_id BIGINT) RETURNS VOID AS $$
DECLARE
    lock_until TIMESTAMPTZ;
BEGIN
    SELECT locked_until INTO lock_until FROM transaction_pins WHERE user_id = p_user_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'no transaction PIN set for user %', p_user_id
            USING ERRCODE = 'check_violation';
    END IF;

    IF lock_until IS NOT NULL AND lock_until > now() THEN
        RAISE EXCEPTION 'transaction PIN for user % is locked until %', p_user_id, lock_until
            USING ERRCODE = 'check_violation';
    END IF;
END;
$$ LANGUAGE plpgsql;

-- Returns the new locked_until, or NULL if the account is not locked yet.
--
-- The counter increments in a single UPDATE rather than read-modify-write, so
-- concurrent guesses from a distributed attacker all count. A SELECT followed
-- by an UPDATE lets N parallel requests each read "2 attempts" and each write
-- "3", turning a 5-attempt lockout into an unlimited one.
CREATE OR REPLACE FUNCTION record_pin_failure(
    p_user_id      BIGINT,
    p_max_attempts INT,
    p_lockout      INTERVAL
) RETURNS TIMESTAMPTZ AS $$
DECLARE
    lock_until TIMESTAMPTZ;
BEGIN
    UPDATE transaction_pins
       SET failed_attempts = failed_attempts + 1,
           locked_until = CASE
               WHEN failed_attempts + 1 >= p_max_attempts THEN now() + p_lockout
               ELSE locked_until
           END,
           updated_at = now()
     WHERE user_id = p_user_id
    RETURNING locked_until INTO lock_until;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'no transaction PIN set for user %', p_user_id
            USING ERRCODE = 'check_violation';
    END IF;

    RETURN lock_until;
END;
$$ LANGUAGE plpgsql;

-- Clears the counter after a correct PIN. Re-checks the lock first: the
-- caller verified a hash, but between that check and this write the account
-- may have been locked by a parallel attacker, and a success must not
-- silently lift a lockout it did not know about.
CREATE OR REPLACE FUNCTION record_pin_success(p_user_id BIGINT) RETURNS VOID AS $$
BEGIN
    PERFORM assert_pin_unlocked(p_user_id);

    UPDATE transaction_pins
       SET failed_attempts  = 0,
           locked_until     = NULL,
           last_verified_at = now(),
           updated_at       = now()
     WHERE user_id = p_user_id;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- 3. DEVICES
--
-- A session is bound to a device. That binding is what makes "log out
-- everywhere" and "this phone was stolen" expressible, and it is what turns
-- reuse detection in section 4 into a proportionate response: revoking one
-- device's family logs out that device, not the customer's other phone.
--
-- The fingerprint is stored HASHED. It is not a secret, but it is a stable
-- identifier for a physical device, and a database dump that maps people to
-- devices is a surveillance dataset we have no reason to hold.
-- ---------------------------------------------------------------------------

CREATE TYPE device_status AS ENUM ('active', 'revoked');

CREATE TABLE devices (
    id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    uuid             UUID          NOT NULL DEFAULT gen_random_uuid(),
    user_id          BIGINT        NOT NULL REFERENCES users(id),

    fingerprint_hash TEXT          NOT NULL CHECK (fingerprint_hash ~ '^[0-9a-f]{64}$'),
    platform         TEXT          NOT NULL CHECK (platform IN ('ios', 'android', 'web')),
    display_name     TEXT          NOT NULL DEFAULT '',

    status           device_status NOT NULL DEFAULT 'active',
    first_seen_at    TIMESTAMPTZ   NOT NULL DEFAULT now(),
    last_seen_at     TIMESTAMPTZ   NOT NULL DEFAULT now(),

    CONSTRAINT devices_uuid_key UNIQUE (uuid),
    CONSTRAINT devices_owner_fingerprint UNIQUE (user_id, fingerprint_hash)
);

CREATE INDEX devices_user ON devices (user_id, status);

-- ---------------------------------------------------------------------------
-- 4. SESSIONS AND REFRESH TOKENS  — the part that has to be right
--
-- A session IS the token family. Rotation issues a new refresh token and
-- consumes the old one, so a family is a chain: generation 0 replaced by 1
-- replaced by 2. At most one link is live at a time.
--
-- REUSE DETECTION. If a token that has already been consumed is presented
-- again, there are two explanations: the customer's client raced itself, or
-- somebody else has a copy. We cannot tell which, and the cost of guessing
-- wrong in the second case is the customer's balance. So an already-consumed
-- token revokes the ENTIRE family — including the live token the thief or the
-- customer is holding. Whoever kept the stolen copy is logged out along with
-- everyone else, and the customer signs in again.
--
-- The honest cost: a client that genuinely races its own refresh gets logged
-- out. That is a UX bug to fix in the client with a single-flight refresh, not
-- a reason to weaken the check, because the failure modes are not symmetric.
--
-- WHY THIS IS A DATABASE FUNCTION.
-- The whole detection rests on "was this token already consumed?", and in
-- service code that is a SELECT followed by an UPDATE. Two requests carrying
-- the same stolen token on separate connections both read "not consumed", both
-- rotate, and the theft is not merely undetected — it has been served twice.
-- Here the family row is locked with SELECT ... FOR UPDATE before the token is
-- re-read, so concurrent rotations within a family are serialised and the
-- second one sees the first one's consumption. This is the same reasoning that
-- made idempotency_key a UNIQUE constraint in the ledger rather than a check.
-- ---------------------------------------------------------------------------

CREATE TYPE session_revoke_reason AS ENUM (
  'logout',
  'token_reuse',      -- a consumed refresh token came back; see above
  'device_revoked',
  'password_change',
  'admin'
);

CREATE TABLE auth_sessions (
    id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    uuid           UUID        NOT NULL DEFAULT gen_random_uuid(),
    user_id        BIGINT      NOT NULL REFERENCES users(id),
    device_id      BIGINT      NOT NULL REFERENCES devices(id),

    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    revoked_at     TIMESTAMPTZ NULL,
    revoked_reason session_revoke_reason NULL,

    CONSTRAINT auth_sessions_uuid_key UNIQUE (uuid),

    -- A revocation without a reason is an incident nobody can investigate,
    -- and a reason without a revocation is a lie about the session's state.
    CONSTRAINT revocation_is_complete CHECK (
        (revoked_at IS NULL) = (revoked_reason IS NULL)
    )
);

CREATE INDEX auth_sessions_user   ON auth_sessions (user_id, revoked_at);
CREATE INDEX auth_sessions_device ON auth_sessions (device_id, revoked_at);

-- A session may only be opened on an ACTIVE device belonging to the SAME
-- user. Without this a stolen user id plus any device row is a session, and
-- "revoke this device" becomes advisory.
CREATE OR REPLACE FUNCTION assert_session_device_valid() RETURNS TRIGGER AS $$
DECLARE
    d devices%ROWTYPE;
BEGIN
    SELECT * INTO d FROM devices WHERE id = NEW.device_id;

    IF d.user_id <> NEW.user_id THEN
        RAISE EXCEPTION 'device % belongs to user %, not user %',
            NEW.device_id, d.user_id, NEW.user_id
            USING ERRCODE = 'check_violation';
    END IF;

    IF d.status <> 'active' THEN
        RAISE EXCEPTION 'device % is %, cannot open a session on it',
            NEW.device_id, d.status
            USING ERRCODE = 'check_violation';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER auth_sessions_device_check
    BEFORE INSERT ON auth_sessions
    FOR EACH ROW EXECUTE FUNCTION assert_session_device_valid();

-- Revocation is one-way. An un-revoke would let a compromised session be
-- quietly restored, and it would erase the timestamp an investigation needs.
-- Ending a revocation means opening a new session, which leaves a record.
CREATE OR REPLACE FUNCTION assert_revocation_final() RETURNS TRIGGER AS $$
BEGIN
    IF OLD.revoked_at IS NOT NULL
       AND (NEW.revoked_at     IS DISTINCT FROM OLD.revoked_at
         OR NEW.revoked_reason IS DISTINCT FROM OLD.revoked_reason) THEN
        RAISE EXCEPTION 'session % was revoked at % (%); revocation is final',
            OLD.id, OLD.revoked_at, OLD.revoked_reason
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER auth_sessions_revocation_final
    BEFORE UPDATE ON auth_sessions
    FOR EACH ROW EXECUTE FUNCTION assert_revocation_final();

-- Revoking a device revokes its sessions, here rather than in the service
-- that happens to handle "lost phone". A device marked revoked while one of
-- its sessions stays live is the exact gap the button was pressed to close.
CREATE OR REPLACE FUNCTION cascade_device_revocation() RETURNS TRIGGER AS $$
BEGIN
    IF NEW.status = 'revoked' AND OLD.status <> 'revoked' THEN
        UPDATE auth_sessions
           SET revoked_at = now(), revoked_reason = 'device_revoked'
         WHERE device_id = NEW.id AND revoked_at IS NULL;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER devices_cascade_revocation
    AFTER UPDATE ON devices
    FOR EACH ROW EXECUTE FUNCTION cascade_device_revocation();

-- Only the SHA-256 hash of a refresh token is stored, never the token. A
-- database backup, a replica, or a leaked query log then contains nothing
-- that can be presented as credentials.
--
-- The hex-64 CHECK is what makes that structural rather than customary: a raw
-- token is 43 base64url characters and is rejected by the constraint, so the
-- mistake cannot reach a row.
CREATE TABLE refresh_tokens (
    id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    session_id     BIGINT      NOT NULL REFERENCES auth_sessions(id),

    token_hash     TEXT        NOT NULL CHECK (token_hash ~ '^[0-9a-f]{64}$'),
    generation     INT         NOT NULL CHECK (generation >= 0),

    issued_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at     TIMESTAMPTZ NOT NULL,
    consumed_at    TIMESTAMPTZ NULL,
    replaced_by_id BIGINT      NULL REFERENCES refresh_tokens(id),

    CONSTRAINT refresh_tokens_hash_key UNIQUE (token_hash),
    CONSTRAINT refresh_tokens_chain    UNIQUE (session_id, generation),
    CONSTRAINT expiry_after_issue      CHECK (expires_at > issued_at),

    -- A replacement implies a consumption. The reverse is not true: the last
    -- token in a family is consumed at logout and replaced by nothing.
    CONSTRAINT replacement_implies_consumed CHECK (
        replaced_by_id IS NULL OR consumed_at IS NOT NULL
    )
);

CREATE INDEX refresh_tokens_session ON refresh_tokens (session_id, generation DESC);
CREATE INDEX refresh_tokens_expiry  ON refresh_tokens (expires_at) WHERE consumed_at IS NULL;

-- A consumed token can never be un-consumed, and an issued token's identity
-- can never change. This is the append-only rule from the ledger applied to
-- credentials, and it is what makes reuse detection trustworthy: if
-- consumed_at could be cleared, "this token was already used" would be a
-- statement about the present rather than about history, and one UPDATE
-- during an incident would erase the evidence of the incident.
CREATE OR REPLACE FUNCTION assert_refresh_token_append_only() RETURNS TRIGGER AS $$
BEGIN
    IF NEW.token_hash IS DISTINCT FROM OLD.token_hash
       OR NEW.session_id IS DISTINCT FROM OLD.session_id
       OR NEW.generation IS DISTINCT FROM OLD.generation
       OR NEW.issued_at  IS DISTINCT FROM OLD.issued_at
       OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
        RAISE EXCEPTION 'refresh token % is immutable except for consumption', OLD.id
            USING ERRCODE = 'check_violation';
    END IF;

    IF OLD.consumed_at IS NOT NULL AND NEW.consumed_at IS DISTINCT FROM OLD.consumed_at THEN
        RAISE EXCEPTION
            'refresh token % was consumed at %; a consumed token can never be re-consumed or restored',
            OLD.id, OLD.consumed_at
            USING ERRCODE = 'check_violation';
    END IF;

    IF OLD.replaced_by_id IS NOT NULL
       AND NEW.replaced_by_id IS DISTINCT FROM OLD.replaced_by_id THEN
        RAISE EXCEPTION 'refresh token % already points at replacement %',
            OLD.id, OLD.replaced_by_id
            USING ERRCODE = 'check_violation';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER refresh_tokens_append_only
    BEFORE UPDATE ON refresh_tokens
    FOR EACH ROW EXECUTE FUNCTION assert_refresh_token_append_only();

CREATE TYPE rotation_outcome AS ENUM (
  'rotated',
  'reuse_detected',   -- family revoked; treat as a security event
  'unknown_token',
  'session_revoked',
  'expired'
);

-- THE rotation path. Every refresh goes through this function and nothing
-- updates `consumed_at` directly, for the same reason nothing writes to
-- `postings` directly: the invariant is only worth what the narrowest path
-- to it enforces.
--
-- Outcomes are returned rather than raised. A caller must handle
-- 'reuse_detected' differently from 'expired' — one is an expired session and
-- a login prompt, the other is a security incident that should page someone —
-- and an exception flattens that distinction into a 500. The failure paths
-- are all deliberately indistinguishable to the CLIENT (they all mean "sign
-- in again"), while staying distinguishable to us.
CREATE OR REPLACE FUNCTION rotate_refresh_token(
    p_presented_hash TEXT,
    p_new_hash       TEXT,
    p_ttl            INTERVAL
)
RETURNS TABLE (
    -- Prefixed because an OUT parameter named `session_id` would be ambiguous
    -- against refresh_tokens.session_id inside this function's own queries,
    -- and plpgsql resolves that at runtime, in production, not at CREATE time.
    out_outcome      rotation_outcome,
    out_session_id   BIGINT,
    out_user_id      BIGINT,
    out_new_token_id BIGINT
) AS $$
DECLARE
    tok         refresh_tokens%ROWTYPE;
    sess        auth_sessions%ROWTYPE;
    inserted_id BIGINT;
BEGIN
    SELECT * INTO tok FROM refresh_tokens WHERE token_hash = p_presented_hash;

    -- An unknown hash is not necessarily an attack: it is also what a client
    -- holding a token from a pruned session sends. Nothing to revoke, because
    -- we cannot tell which family it would have belonged to.
    IF NOT FOUND THEN
        RETURN QUERY SELECT 'unknown_token'::rotation_outcome,
                            NULL::BIGINT, NULL::BIGINT, NULL::BIGINT;
        RETURN;
    END IF;

    -- Lock the family. Everything after this point is serialised against any
    -- competing rotation in the same session, which is what makes the
    -- consumed_at read below a fact rather than a guess.
    SELECT * INTO sess FROM auth_sessions WHERE id = tok.session_id FOR UPDATE;

    IF sess.revoked_at IS NOT NULL THEN
        RETURN QUERY SELECT 'session_revoked'::rotation_outcome,
                            sess.id, sess.user_id, NULL::BIGINT;
        RETURN;
    END IF;

    -- Re-read UNDER the lock. The copy fetched before the lock may be stale by
    -- exactly the window this function exists to close.
    SELECT * INTO tok FROM refresh_tokens WHERE id = tok.id;

    IF tok.consumed_at IS NOT NULL THEN
        UPDATE auth_sessions
           SET revoked_at = now(), revoked_reason = 'token_reuse'
         WHERE id = sess.id;

        RETURN QUERY SELECT 'reuse_detected'::rotation_outcome,
                            sess.id, sess.user_id, NULL::BIGINT;
        RETURN;
    END IF;

    -- Expiry is checked AFTER consumption, and the order matters. An expired
    -- but never-used token is an ordinary lapsed session; treating it as reuse
    -- would revoke families over nothing and bury real incidents in noise.
    IF tok.expires_at <= now() THEN
        RETURN QUERY SELECT 'expired'::rotation_outcome,
                            sess.id, sess.user_id, NULL::BIGINT;
        RETURN;
    END IF;

    INSERT INTO refresh_tokens (session_id, token_hash, generation, expires_at)
    VALUES (sess.id, p_new_hash, tok.generation + 1, now() + p_ttl)
    RETURNING id INTO inserted_id;

    -- One UPDATE sets both columns. Two would trip the append-only trigger on
    -- the second pass, since by then consumed_at is already set.
    UPDATE refresh_tokens
       SET consumed_at = now(), replaced_by_id = inserted_id
     WHERE id = tok.id;

    RETURN QUERY SELECT 'rotated'::rotation_outcome,
                        sess.id, sess.user_id, inserted_id;
END;
$$ LANGUAGE plpgsql;

-- Logout. Separate from rotation because it is not a failure: the token is
-- consumed with no replacement, and the family closes cleanly.
CREATE OR REPLACE FUNCTION revoke_session(
    p_session_id BIGINT,
    p_reason     session_revoke_reason
) RETURNS VOID AS $$
BEGIN
    UPDATE auth_sessions
       SET revoked_at = now(), revoked_reason = p_reason
     WHERE id = p_session_id AND revoked_at IS NULL;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- 5. WHY THE ACCESS TOKEN IS NOT IN THIS SCHEMA
--
-- Access tokens are short-lived (15 minutes) and signed, not stored. Storing
-- them would put a row write on every authenticated request for a credential
-- that expires before most support tickets are opened.
--
-- The cost is that an access token cannot be revoked mid-life, and it is
-- worth stating plainly rather than discovering: revoking a session stops the
-- next REFRESH, so a stolen access token stays valid until it expires. Fifteen
-- minutes is the size of that window, and it is why the number is small.
-- Anything that must take effect immediately — freezing an account, blocking a
-- transfer — is checked against `users.status` at the point of the action, not
-- inferred from the presence of a token.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 6. BIOMETRICS UNLOCK THE PIN; THEY DO NOT REPLACE IT
--
-- Face ID proves the phone is being held by its owner. It does not prove the
-- owner intended this transfer, and on a device where somebody else's face is
-- also enrolled it does not even prove the first part.
--
-- So enrolment REQUIRES an existing transaction PIN. Enforced by a trigger
-- rather than by the enrolment endpoint, because the endpoint is one code
-- path and this is a property of the system: if a user could enrol biometrics
-- without ever setting a PIN, biometry would silently become the only factor
-- guarding their money, which is precisely the arrangement this design
-- rejects.
-- ---------------------------------------------------------------------------

CREATE TABLE biometric_enrollments (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id     BIGINT      NOT NULL REFERENCES users(id),
    device_id   BIGINT      NOT NULL REFERENCES devices(id),

    -- The device generates a keypair in its secure enclave and sends only the
    -- public half. We never hold anything that could impersonate the sensor.
    public_key  TEXT        NOT NULL,

    enrolled_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    revoked_at  TIMESTAMPTZ NULL
);

CREATE UNIQUE INDEX biometric_one_active_per_device
    ON biometric_enrollments (device_id)
    WHERE revoked_at IS NULL;

CREATE OR REPLACE FUNCTION assert_biometric_requires_pin() RETURNS TRIGGER AS $$
DECLARE
    d devices%ROWTYPE;
BEGIN
    SELECT * INTO d FROM devices WHERE id = NEW.device_id;
    IF d.user_id <> NEW.user_id THEN
        RAISE EXCEPTION 'device % belongs to user %, not user %',
            NEW.device_id, d.user_id, NEW.user_id
            USING ERRCODE = 'check_violation';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM transaction_pins WHERE user_id = NEW.user_id) THEN
        RAISE EXCEPTION
            'user % has no transaction PIN; biometrics unlock a PIN and cannot replace one',
            NEW.user_id
            USING ERRCODE = 'check_violation';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER biometric_requires_pin
    BEFORE INSERT ON biometric_enrollments
    FOR EACH ROW EXECUTE FUNCTION assert_biometric_requires_pin();

-- ---------------------------------------------------------------------------
-- 7. OPERATIONAL VIEWS
--
-- The ledger has ledger_drift, watched nightly. Auth's equivalent is watched
-- continuously, because its bad number means something is happening now
-- rather than something went wrong overnight.
-- ---------------------------------------------------------------------------

-- Every family killed by reuse detection. A steady trickle is clients racing
-- their own refresh and is a bug to fix in the app. A spike, or repeats on one
-- user, is credential theft in progress.
CREATE OR REPLACE VIEW token_reuse_incidents AS
SELECT s.id            AS session_id,
       s.uuid          AS session_uuid,
       s.user_id,
       s.device_id,
       d.platform,
       s.created_at    AS session_opened_at,
       s.revoked_at    AS detected_at,
       (SELECT COUNT(*) FROM refresh_tokens t WHERE t.session_id = s.id) AS generations_issued
  FROM auth_sessions s
  JOIN devices d ON d.id = s.device_id
 WHERE s.revoked_reason = 'token_reuse';

CREATE OR REPLACE VIEW active_sessions AS
SELECT s.id AS session_id,
       s.uuid AS session_uuid,
       s.user_id,
       s.device_id,
       d.platform,
       d.display_name,
       s.created_at,
       t.expires_at AS refresh_expires_at
  FROM auth_sessions s
  JOIN devices d ON d.id = s.device_id
  LEFT JOIN refresh_tokens t
         ON t.session_id = s.id AND t.consumed_at IS NULL
 WHERE s.revoked_at IS NULL
   AND d.status = 'active';

COMMIT;
