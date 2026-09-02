-- ---------------------------------------------------------------------------
-- 040 — WHERE A CUSTOMER IS, AND WHAT THAT MEANS FOR THEIR MONEY
--
-- Xetral was Nigeria-only in every place it mattered and in none of them
-- deliberately. `HOME_CURRENCY = 'NGN'` was a constant in `wallet.service.ts`,
-- the activity rail was a literal five-entry list, and a signup form asked for
-- an email and a password — so a customer in Accra got a naira balance at the
-- top of their home screen and a naira-only activity filter, for the whole
-- life of the account.
--
-- WHAT IS DATA HERE AND WHAT IS NOT, because the distinction is the point.
--
-- A COUNTRY IS DATA. Its name, its ISO code, its dialling code and whether it
-- is open for business are rows an operator edits, and adding Rwanda is an
-- INSERT rather than a release. That is what this table is for.
--
-- A CURRENCY IS NOT DATA, and cannot be. `Currency` in @xetral/shared is
-- `keyof typeof CURRENCIES` — a compile-time union — and that is load-bearing
-- rather than incidental: it is what makes `add(ngn(100), usd(100))` fail to
-- compile, and the `in out` annotation beside it exists to keep it failing. A
-- currency invented from a form at runtime would have:
--
--   * no EXPONENT, so every amount in it is wrong by a power of ten — the
--     single most common money bug there is, and silent in the direction of
--     paying out too much;
--   * no row in `kyc_tier_limits`, so no daily ceiling at any tier;
--   * no row in `risk_thresholds`, so nothing monitoring it.
--
-- That is finding 72 exactly — USDC needed a migration rather than a registry
-- line, because the first USDC account would have turned two green coverage
-- suites red and, in the window before anyone noticed, USDC would have been
-- the one asset with no ceiling and no monitoring.
--
-- So a country NAMES a currency and cannot invent one. The set it may name is
-- the set the code already knows, and `countries_currency_is_covered` below
-- makes that structural rather than a rule somebody keeps: a country cannot be
-- ENABLED unless its currency has a ceiling at every tier and a monitoring
-- threshold. An operator adding a country whose currency is not yet supported
-- gets a refusal naming what is missing, instead of a customer with no limits.
-- ---------------------------------------------------------------------------

CREATE TABLE countries (
    -- ISO 3166-1 alpha-2, which is what every other system means by "country"
    -- and what `CF-IPCountry` already sends us.
    code            CHAR(2)     PRIMARY KEY CHECK (code ~ '^[A-Z]{2}$'),
    name            TEXT        NOT NULL CHECK (length(trim(name)) BETWEEN 2 AND 80),

    -- E.164 country calling code, WITHOUT the plus. Stored as text because
    -- it is a prefix rather than a number: '234' and '1' are both valid and
    -- leading zeros exist in other numbering plans.
    dial_code       TEXT        NOT NULL CHECK (dial_code ~ '^[0-9]{1,4}$'),

    /**
     * The currency a customer here holds by default, and the one their home
     * screen leads with. NOT a foreign key — currencies live in TypeScript,
     * for the reasons in the header — so the guarantee is the trigger below
     * rather than a REFERENCES clause.
     */
    currency        TEXT        NOT NULL CHECK (currency ~ '^[A-Z]{3,5}$'),

    /**
     * Whether somebody here can open an account.
     *
     * Off by default, deliberately. A row added and not yet thought about is
     * a country nobody has decided to serve — and the decision involves more
     * than a form: a currency with limits, a payout rail, and whatever the
     * local regulator has to say. Defaulting to on would make an INSERT into
     * a reference table into a licensing decision.
     */
    enabled         BOOLEAN     NOT NULL DEFAULT FALSE,

    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Nullable for the seed, which no person authored. `countries_without_an_
    -- author` makes the gap visible rather than a migration refusing to apply.
    created_by      BIGINT      NULL REFERENCES users(id)
);

CREATE INDEX countries_enabled ON countries (enabled) WHERE enabled;

-- ---------------------------------------------------------------------------
-- A COUNTRY CANNOT BE ENABLED FOR A CURRENCY NOTHING LIMITS OR WATCHES.
--
-- By trigger and not by application code, because this is the rule that stops
-- an operator turning on a country and handing its customers an account with
-- no daily ceiling. `kyc_tier_limits` must cover all three tiers and
-- `risk_thresholds` must have the currency, or the UPDATE is refused with a
-- message naming which is missing.
--
-- It fires on the transition INTO enabled, so a currency whose limits are
-- later removed does not retroactively break an existing country — the
-- coverage views are what report that, and removing a ceiling somebody is
-- relying on is a separate mistake with its own alarm.
-- ---------------------------------------------------------------------------
CREATE FUNCTION countries_currency_is_covered() RETURNS TRIGGER AS $$
DECLARE
    tiers INT;
    watched BOOLEAN;
BEGIN
    IF NOT NEW.enabled THEN
        RETURN NEW;
    END IF;

    SELECT count(*) INTO tiers
      FROM kyc_tier_limits WHERE currency = NEW.currency;

    SELECT EXISTS (SELECT 1 FROM risk_thresholds WHERE currency = NEW.currency)
      INTO watched;

    IF tiers < 3 THEN
        RAISE EXCEPTION
            'country % cannot be enabled: % has a daily limit at % of 3 tiers. '
            'Add kyc_tier_limits rows before opening this country.',
            NEW.code, NEW.currency, tiers;
    END IF;

    IF NOT watched THEN
        RAISE EXCEPTION
            'country % cannot be enabled: % has no row in risk_thresholds, so '
            'nothing would monitor transactions in it.',
            NEW.code, NEW.currency;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER countries_enable_needs_coverage
    BEFORE INSERT OR UPDATE ON countries
    FOR EACH ROW EXECUTE FUNCTION countries_currency_is_covered();

CREATE FUNCTION countries_touch_updated_at() RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER countries_updated_at
    BEFORE UPDATE ON countries
    FOR EACH ROW EXECUTE FUNCTION countries_touch_updated_at();

-- ---------------------------------------------------------------------------
-- WHERE THE CUSTOMER IS, AND WHAT THEY ARE CALLED.
--
-- `country` is nullable and REFERENCES rather than defaulting to 'NG': every
-- account that exists today was opened before this column did, and writing
-- Nigeria into all of them would be inventing a fact about people. A null
-- reads as "not asked", and `wallet.service.ts` falls back to the platform's
-- own default for those.
--
-- `full_name` is what a customer types at signup, and it is NOT the verified
-- name. The verified one lives in `kyc_submissions` and is the only one any
-- money decision may use; this one is for saying hello. Keeping them apart is
-- why the greeting can be personal on day one without implying an identity
-- check that has not happened.
-- ---------------------------------------------------------------------------
ALTER TABLE users
    ADD COLUMN country   CHAR(2) NULL REFERENCES countries(code),
    ADD COLUMN full_name TEXT    NULL CHECK (full_name IS NULL OR length(trim(full_name)) BETWEEN 2 AND 120);

CREATE INDEX users_country ON users (country) WHERE country IS NOT NULL;

-- ---------------------------------------------------------------------------
-- What an operator has not decided, and what nobody authored.
-- ---------------------------------------------------------------------------

/** Countries with a row and no decision — added, never opened. Not a fault;
 *  a queue somebody works through. */
CREATE VIEW countries_awaiting_a_decision AS
SELECT code, name, currency, created_at
  FROM countries
 WHERE NOT enabled;

/** Currencies named by an enabled country that the ledger cannot fully serve.
 *  Empty by construction while the trigger holds — it exists to catch the
 *  other direction, a ceiling removed after a country was opened. */
CREATE VIEW countries_without_cover AS
SELECT c.code,
       c.name,
       c.currency,
       (SELECT count(*) FROM kyc_tier_limits k WHERE k.currency = c.currency) AS tiers_with_a_limit,
       EXISTS (SELECT 1 FROM risk_thresholds r WHERE r.currency = c.currency)  AS monitored
  FROM countries c
 WHERE c.enabled
   AND ((SELECT count(*) FROM kyc_tier_limits k WHERE k.currency = c.currency) < 3
        OR NOT EXISTS (SELECT 1 FROM risk_thresholds r WHERE r.currency = c.currency));

/** The 035 shape: rows written by the seed rather than by a person. */
CREATE VIEW countries_without_an_author AS
SELECT code, name, currency, created_at
  FROM countries
 WHERE created_by IS NULL;

-- ---------------------------------------------------------------------------
-- The decisions this migration owes 019 and 036.
-- ---------------------------------------------------------------------------
INSERT INTO retention_decisions (table_name, decision, rationale) VALUES
    ('countries',
     'keep',
     'Reference data describing where the platform operates. It holds no '
     'personal data and a past transaction cannot be read without the country '
     'row it was made under.')
ON CONFLICT (table_name) DO NOTHING;

INSERT INTO attention_sources (source, decision, queue_name, rationale) VALUES
    ('countries_awaiting_a_decision',
     'queue',
     -- The overview's KEY, not a display label: 036's coverage check joins
     -- `queue_name` against `admin_work_queue.queue`, so a prose name here is
     -- a queue nobody can see. Every other row is a snake_case key.
     'countries_awaiting_a_decision',
     'A country added and not opened is waiting on a person to decide whether '
     'to serve it. Not a fault, and not something to leave unlisted.'),
    ('countries_without_cover',
     'watch',
     NULL,
     'Empty while the enable trigger holds. It catches the other direction: a '
     'tier ceiling or a monitoring threshold removed after a country was '
     'opened, which would leave its customers unlimited.'),
    ('countries_without_an_author',
     'internal',
     NULL,
     'The seeded rows, which no person authored. Made visible for the same '
     'reason 035 shows prices written at a psql prompt, and not work anybody '
     'is expected to clear.')
ON CONFLICT (source) DO NOTHING;

-- ---------------------------------------------------------------------------
-- THE OVERVIEW OWES AN ARM TO EVERY QUEUE, and 036 fails the build otherwise.
--
-- Written out rather than assembled by looping over `attention_sources`: an
-- overview whose behaviour changes with an INSERT is the shape
-- `apply_retention()` and `erase_customer_personal_data()` both refuse.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW admin_work_queue AS
  SELECT 'kyc'::TEXT AS queue, COUNT(*)::BIGINT AS waiting, MIN(created_at) AS oldest
    FROM kyc_submissions WHERE status = 'pending'
UNION ALL
  SELECT 'suspense', COUNT(*), MIN(created_at) FROM unattributed_deposits
UNION ALL
  SELECT 'giftcard_review', COUNT(*), MIN(created_at) FROM giftcard_review_queue
UNION ALL
  SELECT 'purchases_held', COUNT(*), MIN(created_at) FROM pending_purchases
UNION ALL
  SELECT 'crypto_withdrawals_open', COUNT(*), MIN(created_at) FROM crypto_withdrawals_pending
UNION ALL
  SELECT 'disputes', COUNT(*), MIN(raised_at) FROM disputes_open
UNION ALL
  SELECT 'risk_signals', COUNT(*), MIN(observed_at) FROM risk_signals_open
UNION ALL
  SELECT 'risk_cases', COUNT(*), MIN(opened_at) FROM risk_cases_open
UNION ALL
  SELECT 'card_holds_stuck', COUNT(*), MIN(occurred_at) FROM card_holds_stuck
UNION ALL
  SELECT 'consent', COUNT(*), MIN(published_at) FROM consent_outstanding
UNION ALL
  SELECT 'data_requests', COUNT(*), MIN(requested_at) FROM data_requests_due
UNION ALL
  SELECT 'ledger_drift', COUNT(*), NULL::TIMESTAMPTZ FROM ledger_drift
UNION ALL
  SELECT 'provider_drift', COUNT(*), NULL::TIMESTAMPTZ FROM provider_balance_drift
UNION ALL
  SELECT 'tax_drift', COUNT(*), NULL::TIMESTAMPTZ FROM tax_remittance_drift
UNION ALL
  SELECT 'notifications_abandoned', COUNT(*), MIN(created_at) FROM notifications_abandoned
UNION ALL
  SELECT 'errors', COUNT(*), MIN(first_seen_at) FROM errors_open
UNION ALL
  SELECT 'giftcard_holds_due', COUNT(*), MIN(hold_until) FROM giftcard_holds_due
UNION ALL
  SELECT 'staff_without_totp', COUNT(*), NULL::TIMESTAMPTZ FROM staff_without_second_factor
UNION ALL
  SELECT 'bvn_collisions', COUNT(*), NULL::TIMESTAMPTZ FROM kyc_bvn_collisions
UNION ALL
  SELECT 'token_reuse', COUNT(*), NULL::TIMESTAMPTZ FROM token_reuse_incidents
UNION ALL
  SELECT 'credential_stuffing', COUNT(*), NULL::TIMESTAMPTZ FROM credential_stuffing_sources
UNION ALL
  SELECT 'prices_unattributed', COUNT(*), MIN(effective_from) FROM prices_without_an_author
UNION ALL
  SELECT 'provider_degraded', COUNT(*), NULL::TIMESTAMPTZ FROM provider_degraded
UNION ALL
  -- Added by 040, and the coverage check in 036 is what caught its absence:
  -- `countries_awaiting_a_decision` was classified as a queue and had no arm
  -- here, so the overview would have been complete-looking and short by one.
  -- That is exactly the failure 036 exists to prevent, and it fired.
  SELECT 'countries_awaiting_a_decision', COUNT(*), MIN(created_at)
    FROM countries_awaiting_a_decision;
