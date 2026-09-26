-- ============================================================================
--  082 — why a rail would not open an account number, written down; and the
--        details an approval carries, copied onto the account EVERY time
--
--  "YOUR ACCOUNT NUMBER COULD NOT BE OPENED. THIS ONE IS ON US TO FIX." That
--  is `account_issue_refused`: a rail understood the request and said no, and
--  the reason — dedicated accounts not enabled on the integration, a customer
--  the business is required to validate first, a preferred bank it is not
--  approved for — is a sentence the rail wrote. 006's rule keeps that sentence
--  from the CUSTOMER, because it names our integration, and it went to a LOG
--  LINE. On a deployment where nobody can page back through container logs,
--  a log line is nowhere: the customer was told the platform knew, and the
--  platform could not say what it knew.
--
--  ONE ROW PER DISTINCT REFUSAL, NOT ONE PER ATTEMPT. The same sentence from
--  the same rail about the same currency is one fact that happened N times, so
--  it is one row with a count and a first and last sighting — the shape
--  `record_error` gave `error_events` for the same reason. A row per attempt
--  is a log, and every customer opening Add Money while the cause stands
--  would add another copy of the one line an operator needs to read.
--
--  NO CUSTOMER IS NAMED. The refusal is a fact about our integration with a
--  rail, not about a person, and diagnosing a missing product needs no name,
--  address or id. Which is also why the table can be KEPT: it grows by the
--  number of distinct sentences a rail can say, and holds nothing the NDPA
--  asks us to let go of.
-- ============================================================================
BEGIN;

CREATE TABLE IF NOT EXISTS account_refusals (
    id             BIGSERIAL PRIMARY KEY,
    rail           TEXT        NOT NULL CHECK (rail ~ '^[a-z0-9_]{2,32}$'),
    currency       TEXT        NOT NULL CHECK (currency ~ '^[A-Z]{3,5}$'),
    provider_code  TEXT        CHECK (provider_code IS NULL OR length(provider_code) BETWEEN 1 AND 120),
    -- The rail's own words, capped: a whole HTML error page pasted into a
    -- refusal is not a reason anybody reads.
    reason         TEXT        NOT NULL CHECK (length(reason) BETWEEN 1 AND 1000),
    occurrences    BIGINT      NOT NULL DEFAULT 1 CHECK (occurrences >= 1),
    first_seen     TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (last_seen >= first_seen)
);

-- The identity of a refusal. `provider_code` is part of it: one sentence under
-- two codes is two different answers.
CREATE UNIQUE INDEX IF NOT EXISTS account_refusals_identity
    ON account_refusals (rail, currency, COALESCE(provider_code, ''), reason);

/*
 * Written through one function so the upsert cannot be spelled two ways. It
 * can never fail the request that recorded it — the caller swallows errors —
 * but it must also never move a sighting BACKWARDS, which a clock-skewed
 * instance writing `last_seen = now()` unguarded would.
 */
CREATE OR REPLACE FUNCTION record_account_refusal(
    p_rail          TEXT,
    p_currency      TEXT,
    p_provider_code TEXT,
    p_reason        TEXT
) RETURNS VOID LANGUAGE sql AS $$
    INSERT INTO account_refusals (rail, currency, provider_code, reason)
    VALUES (p_rail, p_currency, NULLIF(p_provider_code, ''), left(p_reason, 1000))
    ON CONFLICT (rail, currency, COALESCE(provider_code, ''), reason) DO UPDATE
       SET occurrences = account_refusals.occurrences + 1,
           last_seen   = GREATEST(account_refusals.last_seen, now());
$$;

INSERT INTO retention_decisions (table_name, decision, rationale)
VALUES (
    'account_refusals',
    'keep',
    'Why a rail refused to open an account number, one row per distinct '
    'sentence, naming no customer. It grows with what a rail can say rather '
    'than with traffic, and it is the only record of an integration fault an '
    'operator can fix.'
)
ON CONFLICT (table_name) DO NOTHING;

-- ============================================================================
--  THE DETAILS AN APPROVED SUBMISSION CARRIES, ONTO THE ACCOUNT — EVERY TIME.
--
--  067 filled a blank name and a blank number from approved KYC, ONCE, for the
--  rows that existed the day it ran. Nothing did it afterwards: KYC approval
--  raises the tier and writes the provider mapping and leaves `users` alone.
--  So every customer approved since 067 whose account predates the phone
--  field is exactly the customer 067 was written for — verified, holding a
--  number the platform knows, shown "Not set" on their own settings screen,
--  and unpayable, because the Send screen resolves on `users.phone`. Logging
--  in again changes nothing, because nothing on that path looks.
--
--  One function now, called on the APPROVAL'S OWN TRANSACTION and run once
--  here for everybody, with 067's rules unchanged: only a BLANK is filled,
--  only from an APPROVED submission, the number is normalised the way the
--  application normalises one, a row with no country is left rather than
--  guessed, and a number somebody else already holds is left for a person.
-- ============================================================================
CREATE OR REPLACE FUNCTION fill_details_from_kyc(p_user_id BIGINT DEFAULT NULL)
RETURNS INT LANGUAGE plpgsql AS $$
DECLARE
    named  INT := 0;
    phoned INT := 0;
BEGIN
    UPDATE users u
       SET full_name = btrim(k.full_name)
      FROM kyc_submissions k
     WHERE k.user_id = u.id
       AND k.status = 'approved'
       AND (p_user_id IS NULL OR u.id = p_user_id)
       AND u.full_name IS NULL
       AND length(btrim(k.full_name)) BETWEEN 2 AND 120;
    GET DIAGNOSTICS named = ROW_COUNT;

    WITH approved AS (
        SELECT k.user_id,
               c.dial_code,
               regexp_replace(k.phone, '[^0-9]', '', 'g') AS digits,
               k.phone LIKE '+%'                          AS already_international
          FROM kyc_submissions k
          JOIN users u          ON u.id   = k.user_id
          LEFT JOIN countries c ON c.code = u.country
         WHERE k.status = 'approved'
           AND u.phone IS NULL
           AND (p_user_id IS NULL OR u.id = p_user_id)
    ),
    built AS (
        SELECT user_id,
               CASE
                   WHEN already_international
                     OR (dial_code IS NOT NULL AND digits LIKE dial_code || '%'
                         AND digits NOT LIKE '0%')
                   THEN '+' || digits
                   WHEN dial_code IS NOT NULL
                   THEN '+' || dial_code || regexp_replace(digits, '^0+', '')
                   ELSE NULL
               END AS phone
          FROM approved
    ),
    usable AS (
        SELECT b.user_id, b.phone
          FROM built b
         WHERE b.phone IS NOT NULL
           AND length(b.phone) BETWEEN 9 AND 16
           AND NOT EXISTS (SELECT 1 FROM users x WHERE x.phone = b.phone)
           AND (SELECT count(*) FROM built d WHERE d.phone = b.phone) = 1
    )
    UPDATE users u
       SET phone = s.phone
      FROM usable s
     WHERE s.user_id = u.id
       AND u.phone IS NULL;
    GET DIAGNOSTICS phoned = ROW_COUNT;

    RETURN named + phoned;
END;
$$;

DO $$
DECLARE
    filled INT;
BEGIN
    filled := fill_details_from_kyc(NULL);
    RAISE NOTICE '082: filled in % blank detail(s) from approved KYC', filled;
END $$;

COMMIT;
