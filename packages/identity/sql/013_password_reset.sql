-- ===========================================================================
--  Xetral — password reset
--  packages/identity/sql/013_password_reset.sql
--
--  THE MOST DANGEROUS FLOW IN IDENTITY.
--
--  Every other authentication path requires the customer to already hold
--  something: a password, a PIN, a live session. This one hands account access
--  to whoever can read an inbox, which makes it the shortest route to somebody
--  else's money in the entire product. It exists anyway, because the
--  alternative — a customer who forgets their password losing their balance —
--  is worse and pushes people towards support channels that are easier to
--  social-engineer than an email provider.
--
--  So the design assumes the token WILL leak, and limits what a leak buys:
--  only a hash is stored, the token is single-use, it expires in minutes, and
--  consuming one revokes every live session on the account.
--
--  CONSUMPTION IS A DATABASE FUNCTION, NOT SERVICE CODE — the same decision as
--  `rotate_refresh_token()` and for the same reason. "Has this token already
--  been used?" written as a SELECT then an UPDATE lets two requests carrying
--  the same stolen token both read "unused" and both reset the password. The
--  second one wins, and the customer is locked out of their own account by a
--  race. `consume_password_reset_token()` locks the row before re-reading it.
-- ===========================================================================

-- Deliberately OUTSIDE the transaction below, and it has to be.
--
-- Postgres allows `ALTER TYPE ... ADD VALUE` inside a transaction block but
-- refuses to let the new value be USED in that same transaction. The function
-- created below writes this value, so the ALTER commits on its own first.
--
-- A reset is distinguished from an ordinary `password_change` because the two
-- mean different things in an audit: one is a customer updating a credential,
-- the other is a customer recovering an account they may have lost control of.
-- Collapsing them would hide every takeover recovery among routine changes.
ALTER TYPE session_revoke_reason ADD VALUE IF NOT EXISTS 'password_reset';

BEGIN;

CREATE TYPE password_reset_outcome AS ENUM (
    'consumed',
    -- Not distinguished from each other by the API, deliberately: the caller
    -- gets one `invalid_grant` for all three. Telling somebody WHICH way their
    -- token failed tells them whether it was ever real.
    'unknown_token',
    'already_used',
    'expired'
);

CREATE TABLE password_reset_tokens (
    id           BIGSERIAL PRIMARY KEY,
    user_id      BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,

    -- ONLY the hash, and the CHECK is what makes that structural rather than a
    -- convention the service happens to follow. A raw reset token is
    -- base64url and cannot match this pattern, so a bug that stored the
    -- plaintext fails at the constraint instead of filling a table with live
    -- account-takeover credentials. Same rule as `refresh_tokens.token_hash`.
    token_hash   TEXT NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),

    -- Recorded so an operator investigating an account takeover can see where
    -- the request came from. Nullable: a request with no usable client address
    -- still has to be servable.
    requested_ip TEXT,

    issued_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at   TIMESTAMPTZ NOT NULL,
    consumed_at  TIMESTAMPTZ,

    CONSTRAINT password_reset_expires_after_issue CHECK (expires_at > issued_at)
);

CREATE INDEX password_reset_live
    ON password_reset_tokens (user_id, expires_at)
    WHERE consumed_at IS NULL;

-- ---------------------------------------------------------------------------
-- 1. A CONSUMED TOKEN CAN NEVER BE UN-CONSUMED
--
-- Append-only, exactly like refresh tokens. If `consumed_at` could be cleared,
-- "this token was already used" would be a claim about the present rather than
-- about history, and one UPDATE would erase the evidence of a takeover.
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

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER password_reset_append_only
    BEFORE UPDATE ON password_reset_tokens
    FOR EACH ROW EXECUTE FUNCTION assert_password_reset_append_only();

-- ---------------------------------------------------------------------------
-- 2. CONSUMING ONE
--
-- Everything this function does happens in one transaction, and that is the
-- whole point. Setting the password, killing the other outstanding tokens and
-- revoking live sessions in three separate statements from service code leaves
-- three windows in which a half-completed reset is the state of the account.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION consume_password_reset_token(
    p_presented_hash TEXT,
    p_new_password_hash TEXT
)
RETURNS TABLE (
    -- Prefixed for the same reason `rotate_refresh_token` prefixes its outputs:
    -- an OUT parameter named `user_id` is ambiguous against the column inside
    -- this function's own queries, and plpgsql resolves that at runtime, in
    -- production, rather than at CREATE time.
    out_outcome  password_reset_outcome,
    out_user_id  BIGINT
) AS $$
DECLARE
    tok password_reset_tokens%ROWTYPE;
BEGIN
    SELECT * INTO tok FROM password_reset_tokens WHERE token_hash = p_presented_hash;

    IF NOT FOUND THEN
        RETURN QUERY SELECT 'unknown_token'::password_reset_outcome, NULL::BIGINT;
        RETURN;
    END IF;

    -- Lock the row, then re-read it. The copy fetched a moment ago may be
    -- stale by exactly the window this function exists to close: two requests
    -- carrying the same token, both having read "not consumed".
    SELECT * INTO tok FROM password_reset_tokens WHERE id = tok.id FOR UPDATE;

    IF tok.consumed_at IS NOT NULL THEN
        RETURN QUERY SELECT 'already_used'::password_reset_outcome, tok.user_id;
        RETURN;
    END IF;

    -- Expiry AFTER consumption, the same order as refresh rotation. An
    -- expired-but-unused token is somebody who took too long over their email,
    -- not an attack, and the two should not read the same in an audit.
    IF tok.expires_at <= now() THEN
        RETURN QUERY SELECT 'expired'::password_reset_outcome, tok.user_id;
        RETURN;
    END IF;

    UPDATE password_reset_tokens SET consumed_at = now() WHERE id = tok.id;

    -- Every OTHER outstanding token for this user dies with it.
    --
    -- Issuing does not invalidate previous tokens — an attacker spamming
    -- "forgot password" at a victim would otherwise invalidate the email the
    -- victim is actually reading — but the moment one is USED, the rest are
    -- surplus credentials to an account that has just been recovered.
    UPDATE password_reset_tokens
       SET consumed_at = now()
     WHERE user_id = tok.user_id AND id <> tok.id AND consumed_at IS NULL;

    UPDATE user_credentials
       SET password_hash = p_new_password_hash, password_changed_at = now()
     WHERE user_id = tok.user_id;

    -- REVOKE EVERY LIVE SESSION. A password reset is the recovery action for
    -- an account somebody else may be sitting in, so finishing one while the
    -- intruder's session keeps working would make it theatre. The customer
    -- signs in again with the password they just set; whoever else was in
    -- there cannot.
    UPDATE auth_sessions
       SET revoked_at = now(), revoked_reason = 'password_reset'
     WHERE user_id = tok.user_id AND revoked_at IS NULL;

    RETURN QUERY SELECT 'consumed'::password_reset_outcome, tok.user_id;
END;
$$ LANGUAGE plpgsql;

COMMIT;
