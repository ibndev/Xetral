-- ============================================================================
--  090 — which recorded countries were the CUSTOMER'S
--
--  A CUSTOMER SIGNING IN FROM LAGOS WAS EMAILED "SIGN-IN FROM A NEW COUNTRY:
--  DE". Every customer request reaches the API through the web app, and the
--  web app's own trip to the API goes through Cloudflare from a server in
--  Germany — so `CF-IPCountry` on the API's request described the SERVER.
--  From this round the web proxy relays the customer's own country, vouched
--  by `WEB_PROXY_SECRET`, and the API reads no other.
--
--  THE ROWS ALREADY WRITTEN CANNOT BE CORRECTED, AND THEY WOULD ALARM EVERY
--  CUSTOMER ONCE. `sign_in_events` refuses an UPDATE at any age (024), and is
--  right to. So an account whose whole history says DE would, on its first
--  correctly placed sign-in, be emailed "new country: NG" — the same panic,
--  once per customer, the day the fix went live. `country_relayed` separates
--  the two: FALSE on every row written before this file, and set TRUE by the
--  application only when the country came through the vouched relay.
--
--  FAMILIARITY READS ONLY RELAYED COUNTRIES, AND THE FIRST ONE IS A BASELINE.
--  An account with no relayed history has nowhere it has "been", so its first
--  placed sign-in establishes where home is rather than announcing a move —
--  which is also what stops a brand-new account being alerted on the first
--  sign-in after registration, from the country it signed up in.
--
--  Idempotent.
-- ============================================================================

BEGIN;

ALTER TABLE sign_in_events
    ADD COLUMN IF NOT EXISTS country_relayed BOOLEAN NOT NULL DEFAULT FALSE;

-- A relayed country is a country. Refuses the application claiming a relay
-- for a sign-in it could not place.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                    WHERE conname = 'sign_in_events_relayed_has_country') THEN
        ALTER TABLE sign_in_events
            ADD CONSTRAINT sign_in_events_relayed_has_country
            CHECK (NOT country_relayed OR country IS NOT NULL);
    END IF;
END $$;

/**
 * Whether this account has been seen here before.
 *
 * The address half is 024's, unchanged. The country half reads RELAYED
 * countries only, and an account with none has not been anywhere yet — so
 * the answer is "seen", and no alert is sent about its first placed sign-in.
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
        p_country IS NULL
        OR NOT EXISTS (
            SELECT 1 FROM sign_in_events
             WHERE user_id = p_user_id AND outcome = 'succeeded' AND country_relayed
        )
        OR EXISTS (
            SELECT 1 FROM sign_in_events
             WHERE user_id = p_user_id AND outcome = 'succeeded'
               AND country_relayed AND country = p_country
        );
END;
$$ LANGUAGE plpgsql STABLE;

COMMIT;
