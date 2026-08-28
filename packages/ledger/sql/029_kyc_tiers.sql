-- ============================================================================
--  029 — What a customer may move, by how much we know about them.
--
--  WHAT WAS MISSING. Every ceiling on this platform was ONE NUMBER for
--  everybody. A customer who submitted a BVN, a photograph and an address, and
--  whose documents a person read, was allowed exactly what a customer who had
--  typed an email address that morning was allowed. That is the wrong way
--  round in both directions: it lets an unverified account move as much as a
--  verified one, and it holds a fully verified customer to a ceiling set for
--  the least-known account on the platform.
--
--  A TIER IS A STATEMENT ABOUT WHAT WE KNOW, and every tier here has a REAL
--  PATH TO IT. That constraint is deliberate and it is why there are three
--  rather than the CBN's familiar 1/2/3: a tier nothing can grant is a row in
--  a table that reads like a product and is a dead end for the customer who
--  reaches its ceiling.
--
--    0  registered   an email or a phone number and nothing else.
--    1  verified     BVN, name, date of birth, address and documents, read by
--                    a person. Granted by KYC approval, in the same
--                    transaction — see `kyc.service.ts`.
--    2  enhanced     source of funds established. Granted by an administrator
--                    with a recorded reason, because enhanced due diligence is
--                    a judgement rather than a form.
--
--  A fourth tier — the CBN's tier 1, phone-verified only — is deliberately
--  absent: nothing here verifies a phone number, so it would be a tier no
--  customer could ever be in.
--
--  WHAT A TIER LIMITS, AND WHAT IT DOES NOT. Outflow: the daily total per
--  currency, which is what `transfer_daily_limit_kobo` used to be for everyone
--  at once.
--
--  IT DOES NOT CAP A BALANCE, and that absence is a decision rather than an
--  omission. A balance ceiling means refusing money that has ALREADY ARRIVED —
--  a bank transfer that has left somebody's account — and the only honest
--  answers are to hold it in suspense until the customer verifies or to send
--  it back. Both are real products with support paths, customer messages and a
--  reconciliation story, and inventing one inside a limits migration is the
--  wrong place to decide it. Written down here so the gap is stated rather
--  than discovered.
-- ============================================================================

BEGIN;

/**
 * The tier itself, on the customer.
 *
 * A column rather than a derived view, unlike `entry_status` — because unlike a
 * status this is not computable from anything. Tier 2 is a person's judgement
 * about source of funds, which exists nowhere else; deriving it from "has an
 * approved KYC submission" would silently collapse it into tier 1.
 *
 * DEFAULT 0, so a customer created before this migration, or by any path that
 * forgets, is the LEAST trusted rather than the most. A default of 1 would
 * mean a registration endpoint that skipped verification handed out verified
 * limits, and nothing would fail.
 */
ALTER TABLE users ADD COLUMN kyc_tier SMALLINT NOT NULL DEFAULT 0
    CHECK (kyc_tier BETWEEN 0 AND 2);

COMMENT ON COLUMN users.kyc_tier IS
  '0 registered, 1 verified (KYC approved), 2 enhanced (source of funds '
  'established by an administrator). Never derived — tier 2 is a judgement.';

/**
 * What each tier may move, per currency, per Lagos day.
 *
 * A TABLE AND NOT SETTINGS KEYS, for the reason 027 gives about thresholds: an
 * amount carries units, so a figure per currency is unavoidable, and three
 * tiers across four currencies is twelve settings rows nobody could review as
 * a set. Here it reads as a grid, which is how an operator thinks about it.
 *
 * EVERY COMBINATION MUST EXIST. `kyc_tier_coverage` reports a missing one and
 * the invariant suite fails on it — because the alternative is a fallback, and
 * a fallback here means a customer in an unlisted currency is silently
 * unlimited. That is the same failure `risk_currency_coverage` exists to
 * prevent, one layer up.
 */
CREATE TABLE kyc_tier_limits (
    tier               SMALLINT NOT NULL CHECK (tier BETWEEN 0 AND 2),
    currency           TEXT     NOT NULL,

    /** Total outflow per Lagos day. Zero is meaningful and permitted: it is
     *  how "this tier may not move this currency at all" is expressed, which
     *  is the right answer for an unverified account and crypto. */
    daily_limit_minor  BIGINT   NOT NULL CHECK (daily_limit_minor >= 0),

    PRIMARY KEY (tier, currency)
);

/**
 * Every tier against every currency the ledger holds, and whether it has a
 * limit.
 *
 * The coverage argument again, and it earns its place for the same reason it
 * did in 027 and 019: a limits table is a list of what somebody thought of,
 * and the combination nobody thought of is where an account with no ceiling
 * lives.
 */
CREATE VIEW kyc_tier_coverage AS
SELECT t.tier,
       c.currency,
       (l.tier IS NOT NULL) AS has_limit,
       l.daily_limit_minor
  FROM (SELECT generate_series(0, 2) AS tier) t
  CROSS JOIN (SELECT DISTINCT currency FROM accounts) c
  LEFT JOIN kyc_tier_limits l ON l.tier = t.tier AND l.currency = c.currency
 ORDER BY (l.tier IS NULL) DESC, t.tier, c.currency;

/**
 * A tier change is recorded, always, with who and why.
 *
 * Append-only. Raising somebody's ceiling is the act that decides how much
 * money can leave their account in a day, and "who allowed this customer to
 * move ten million naira" is a question asked exactly once, during an
 * incident.
 *
 * Written by TRIGGER rather than by the endpoint, so a tier cannot be changed
 * without the change being recorded — including from a psql prompt, which is
 * the case an endpoint-side record does not cover. The same reasoning as
 * `provider_credential_rotations`.
 */
CREATE TABLE kyc_tier_changes (
    id          BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id     BIGINT      NOT NULL REFERENCES users(id),
    from_tier   SMALLINT    NOT NULL,
    to_tier     SMALLINT    NOT NULL,
    /** NULL when KYC approval moved it, which is its own recorded action in
     *  `admin_audit_log`. Set when an administrator granted it directly. */
    changed_by  BIGINT      NULL REFERENCES users(id),
    reason      TEXT        NULL,
    changed_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX kyc_tier_changes_user ON kyc_tier_changes (user_id, changed_at DESC);

CREATE OR REPLACE FUNCTION refuse_tier_change_edit() RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'kyc_tier_changes is append-only; % is refused', TG_OP
        USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER kyc_tier_changes_append_only
    BEFORE UPDATE OR DELETE ON kyc_tier_changes
    FOR EACH ROW EXECUTE FUNCTION refuse_tier_change_edit();

/**
 * Records the change, and refuses a tier that skips the evidence.
 *
 * A customer cannot jump from 0 to 2: enhanced due diligence is a statement
 * about source of funds ON TOP of a verified identity, and granting it to
 * somebody whose identity was never checked would make the higher ceiling rest
 * on nothing. Going DOWN is unrestricted — a tier is a claim about what we
 * know, and finding out we were wrong must never be harder than the mistake.
 */
CREATE OR REPLACE FUNCTION record_kyc_tier_change() RETURNS TRIGGER AS $$
BEGIN
    IF NEW.kyc_tier = OLD.kyc_tier THEN RETURN NEW; END IF;

    IF NEW.kyc_tier > OLD.kyc_tier + 1 THEN
        RAISE EXCEPTION
            'cannot move user % from tier % to tier %: each tier rests on the '
            'evidence of the one below it', OLD.id, OLD.kyc_tier, NEW.kyc_tier
            USING ERRCODE = 'restrict_violation';
    END IF;

    INSERT INTO kyc_tier_changes (user_id, from_tier, to_tier)
    VALUES (OLD.id, OLD.kyc_tier, NEW.kyc_tier);
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER users_kyc_tier_recorded
    BEFORE UPDATE OF kyc_tier ON users
    FOR EACH ROW EXECUTE FUNCTION record_kyc_tier_change();

INSERT INTO retention_decisions (table_name, decision, rationale) VALUES
  ('kyc_tier_limits', 'keep',
   'What each tier was allowed to move. Deleting a row would silently remove a '
   'ceiling, which is the failure the coverage view exists to make visible.'),
  ('kyc_tier_changes', 'keep',
   'Who raised a customer''s ceiling and when. Append-only for the same reason '
   'the audit log is: this is the row read during an incident about how much '
   'money was allowed to leave an account.')
ON CONFLICT (table_name) DO NOTHING;

COMMIT;
