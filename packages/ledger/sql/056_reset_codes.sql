-- ===========================================================================
--  Xetral — a password reset is a CODE, not a link
--  packages/ledger/sql/056_reset_codes.sql
--
--  WHAT WAS WRONG: a reset was a link, and the link needs an address. With
--  `APP_BASE_URL` unset the service refused before it did anything —
--  "Password resets are unavailable right now. Contact support." — on the one
--  flow whose entire purpose is that a customer has nothing left to contact
--  support WITH. A deployment value that nobody sets took away the way back
--  into an account holding somebody's money.
--
--  A CODE NEEDS NO ADDRESS. It is read out of an email and typed into the app
--  the customer already has open, so the flow works on a deployment that has
--  never been told its own hostname, and it works identically on a handset,
--  where following a link means leaving the app and hoping the browser hands
--  the session back.
--
--  WHAT A CODE COSTS, AND WHAT PAYS FOR IT. Six digits is a MILLION
--  possibilities where a link carried 32 bytes. Three things make that safe,
--  and all three are here or in the migration this extends:
--
--    1. THE STORED HASH IS KEYED (an HMAC, in `@xetral/identity`), so a
--       database dump does not hand somebody a million-guess offline attack.
--       An unkeyed digest of a six-digit code IS the code.
--    2. AN ATTEMPT CEILING, counted in a COLUMN rather than in memory — an
--       attacker's loop outlives a pod restart and an in-process counter does
--       not, the same argument `card_reveals` records.
--    3. The existing per-identifier rate limit on the reset endpoint, and the
--       minutes-long expiry 013 already enforces.
--
--  THE CEILING IS CHARGED AGAINST EVERY LIVE CODE FOR THAT CUSTOMER, not
--  against the row a guess happened to match — a wrong guess matches NO row,
--  so a per-row counter can never be incremented by the attack it exists to
--  stop. That is the whole reason this is a second function rather than an
--  argument to the first.
-- ===========================================================================

-- Deliberately OUTSIDE the transaction below. Postgres allows
-- `ALTER TYPE ... ADD VALUE` inside a transaction block but refuses to let the
-- new value be USED in that same transaction, and the function below returns
-- it. Same reason 013's own ALTER sits above its BEGIN.
ALTER TYPE password_reset_outcome ADD VALUE IF NOT EXISTS 'too_many_attempts';

BEGIN;

-- Nullable would have been the smaller diff and the wrong one: a NULL here
-- means "no guesses yet" and "we are not counting" at the same time, and the
-- second reading is a ceiling that silently does not apply.
ALTER TABLE password_reset_tokens
    ADD COLUMN IF NOT EXISTS attempts SMALLINT NOT NULL DEFAULT 0
        CHECK (attempts >= 0);

-- ---------------------------------------------------------------------------
-- 1. ATTEMPTS ONLY EVER GO UP
--
-- 013's trigger already refuses to un-consume a token. A counter that could be
-- lowered is the same hole in a different column: one UPDATE and the ceiling
-- that makes a six-digit code safe is back to zero.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION assert_password_reset_append_only() RETURNS TRIGGER AS $$
BEGIN
    IF NEW.token_hash IS DISTINCT FROM OLD.token_hash
       OR NEW.user_id IS DISTINCT FROM OLD.user_id
       OR NEW.issued_at IS DISTINCT FROM OLD.issued_at
       OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
        RAISE EXCEPTION 'password reset token % is immutable except for consumption', OLD.id
            USING ERRCODE = 'check_violation';
    END IF;

    IF OLD.consumed_at IS NOT NULL AND NEW.consumed_at IS DISTINCT FROM OLD.consumed_at THEN
        RAISE EXCEPTION
            'password reset token % was consumed at %; a consumed token is never restored',
            OLD.id, OLD.consumed_at
            USING ERRCODE = 'check_violation';
    END IF;

    IF NEW.attempts < OLD.attempts THEN
        RAISE EXCEPTION
            'password reset token % has had % attempts; the count never goes down',
            OLD.id, OLD.attempts
            USING ERRCODE = 'check_violation';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- 2. SPENDING A CODE
--
-- Everything 013's `consume_password_reset_token` does, plus the guess
-- counting a short code needs, and scoped to ONE customer because a code is
-- only meaningful next to the address it was sent to.
--
-- The customer is resolved by the API from the identifier they typed, so a
-- caller cannot present a code against an account they cannot name — which is
-- what stops a single lucky guess from being lucky against ALL of them at
-- once. Six digits against one account in fifteen minutes is a control; six
-- digits against every account is a certainty.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION consume_password_reset_code(
    p_user_id BIGINT,
    p_presented_hash TEXT,
    p_new_password_hash TEXT,
    p_max_attempts INT
)
RETURNS TABLE (
    out_outcome  password_reset_outcome,
    out_user_id  BIGINT
) AS $$
DECLARE
    tok password_reset_tokens%ROWTYPE;
    burnt INT;
BEGIN
    -- Every live code for this customer is locked FIRST, in one statement, so
    -- two requests carrying two guesses cannot both read "one attempt left".
    -- Ordered, because two connections locking the same rows in different
    -- orders is a deadlock rather than a queue.
    PERFORM 1 FROM password_reset_tokens
      WHERE user_id = p_user_id AND consumed_at IS NULL
      ORDER BY id
      FOR UPDATE;

    SELECT * INTO tok FROM password_reset_tokens
      WHERE user_id = p_user_id AND token_hash = p_presented_hash;

    IF NOT FOUND THEN
        -- A WRONG CODE. It matches no row, so the guess is charged against
        -- every code this customer currently has outstanding — otherwise the
        -- counter only ever moves for guesses that were right.
        UPDATE password_reset_tokens
           SET attempts = attempts + 1
         WHERE user_id = p_user_id AND consumed_at IS NULL;

        UPDATE password_reset_tokens
           SET consumed_at = now()
         WHERE user_id = p_user_id AND consumed_at IS NULL AND attempts >= p_max_attempts;
        GET DIAGNOSTICS burnt = ROW_COUNT;

        IF burnt > 0 THEN
            -- Said out loud to the customer, unlike the three refusals 013
            -- collapses into one. "Expired" and "never existed" must not be
            -- distinguishable because that tells a prober which guess was
            -- real; "you have run out of attempts" tells them only what they
            -- already know, and telling the REAL customer is the difference
            -- between asking for a new code and typing the old one for ever.
            RETURN QUERY SELECT 'too_many_attempts'::password_reset_outcome, p_user_id;
            RETURN;
        END IF;

        RETURN QUERY SELECT 'unknown_token'::password_reset_outcome, NULL::BIGINT;
        RETURN;
    END IF;

    IF tok.consumed_at IS NOT NULL THEN
        RETURN QUERY SELECT 'already_used'::password_reset_outcome, tok.user_id;
        RETURN;
    END IF;

    IF tok.attempts >= p_max_attempts THEN
        RETURN QUERY SELECT 'too_many_attempts'::password_reset_outcome, tok.user_id;
        RETURN;
    END IF;

    -- Expiry AFTER the code is known to be right and unspent, the same order
    -- 013 and refresh rotation use: somebody who took too long over their
    -- email is a lapsed request, not an attack.
    IF tok.expires_at <= now() THEN
        RETURN QUERY SELECT 'expired'::password_reset_outcome, tok.user_id;
        RETURN;
    END IF;

    UPDATE password_reset_tokens SET consumed_at = now() WHERE id = tok.id;

    -- Every OTHER outstanding code for this user dies with it, for 013's
    -- reason: the moment one is used, the rest are surplus credentials to an
    -- account that has just been recovered.
    UPDATE password_reset_tokens
       SET consumed_at = now()
     WHERE user_id = tok.user_id AND id <> tok.id AND consumed_at IS NULL;

    UPDATE user_credentials
       SET password_hash = p_new_password_hash, password_changed_at = now()
     WHERE user_id = tok.user_id;

    -- REVOKE EVERY LIVE SESSION. A reset is the recovery action for an account
    -- somebody else may be sitting in; finishing one while the intruder's
    -- session keeps working would make it theatre.
    UPDATE auth_sessions
       SET revoked_at = now(), revoked_reason = 'password_reset'
     WHERE user_id = tok.user_id AND revoked_at IS NULL;

    RETURN QUERY SELECT 'consumed'::password_reset_outcome, tok.user_id;
END;
$$ LANGUAGE plpgsql;

COMMIT;
