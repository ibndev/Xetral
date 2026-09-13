-- ===========================================================================
--  069 — WHY A NAME ENQUIRY REFUSED, WRITTEN DOWN
--
--  FOUR ROUNDS OF ONE COMPLAINT — "it says it cannot find the momo details" —
--  and the reason it kept coming back is in `payout.service.ts`:
--
--      if (error instanceof ProviderRejectedError) {
--        if (error.providerCode === 'name_unavailable') { … }
--        throw new NotFoundException({ error: 'account_not_found' });
--      }
--
--  A REFUSAL FROM THE RAIL WAS NOT EVEN LOGGED. `#relay` logs, and that branch
--  is never reached for a rejection — so Flutterwave's own sentence about a
--  Ghanaian mobile money number, the single fact that would have ended this,
--  existed nowhere at all. Not in a table, not in a log line, not on a screen.
--  Every round was therefore a guess about a provider's behaviour, and this
--  repo's own record says where that ends: Phase 3's Bitnob endpoint table,
--  wrong twice, "verified against the vendor's SDK" and still a description of
--  an API that no longer answered.
--
--  SO THE FIX IS NOT ANOTHER CONSTANT. It is that the provider's answer
--  becomes readable. `checkout_refusals` exists for exactly this reason one
--  migration back — a stranger pressed a button, the rail refused, and an
--  operator could not page through application logs looking for the
--  afternoon it happened.
--
--  BUCKETS, NOT A ROW PER CALL — 015's rule, and 037 restates it for provider
--  health. One row per (provider, country, rail): a handful of rows for the
--  life of the platform, which is why this table needs no purge sweep and can
--  honestly be kept.
--
--  AND IT CARRIES NO NUMBER. The trail records the SHAPE that was tried —
--  `233…1133` — never the digits. A refusals table holding whole mobile
--  numbers is a list of customers' contacts, which is 016's argument that the
--  way to hold less is to store less rather than to guard more.
-- ===========================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS name_enquiry_refusals (
    provider        TEXT NOT NULL,
    country         TEXT NOT NULL CHECK (country ~ '^[A-Z]{2}$'),
    /** The bank code or mobile money network the customer chose. */
    rail_code       TEXT NOT NULL,

    refusals        BIGINT NOT NULL DEFAULT 0 CHECK (refusals >= 0),
    first_seen_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

    /**
     * THE PROVIDER'S OWN SENTENCE, and the only reason this table exists.
     *
     * 006's rule is that it never reaches the customer, because it names our
     * integration. That rule has always been half-applied here: it did not
     * reach the customer AND it did not reach anybody else either.
     */
    last_message    TEXT NOT NULL CHECK (length(last_message) > 0),

    /**
     * EVERY SHAPE THE ADAPTER TRIED AND WHAT WAS SAID TO EACH.
     *
     * A lookup is a READ, so it may be asked more than one way: the number as
     * stored (`233…`, what a transfer carries) and the national spelling
     * (`0…`, how it is written in Accra). Recording which one the rail
     * accepted is how a guessed constant becomes a known one — and recording
     * that BOTH were refused is how "the number is wrong" is told apart from
     * "we are asking the wrong question".
     */
    last_tried      TEXT NOT NULL,

    /**
     * WHETHER THE KEY WAS A TEST KEY, and this is the field most likely to
     * answer the whole thing.
     *
     * Flutterwave's sandbox CANNOT verify a real account — their own
     * documentation says only test accounts resolve in test mode and a real
     * one returns an error. So a deployment holding `FLWSECK_TEST-…` refuses
     * every genuine Ghanaian number, correctly, for a reason that has nothing
     * to do with the number, and from inside the app that is indistinguishable
     * from a customer mistyping.
     *
     * It is read off the key's PREFIX. Nothing here stores, logs or returns
     * the key itself.
     */
    key_mode        TEXT NOT NULL CHECK (key_mode IN ('test', 'live', 'unset', 'unknown')),

    PRIMARY KEY (provider, country, rail_code)
);

COMMENT ON TABLE name_enquiry_refusals IS
    'One row per rail whose name enquiry has refused, with the provider''s own '
    'sentence and the shapes tried. Never a customer''s number, and never a '
    'key -- only whether the key was a test key.';

/**
 * RAILS WHOSE NAME ENQUIRY IS REFUSING, worst first.
 *
 * A row reading `key_mode = test` is a deployment on a sandbox key, not a
 * customer mistyping their number. A row whose trail shows BOTH spellings
 * refused is the rail genuinely not naming that account. A row that has not
 * been seen for days is history.
 */
CREATE OR REPLACE VIEW name_enquiry_failures AS
SELECT r.provider,
       r.country,
       r.rail_code,
       r.refusals,
       r.key_mode,
       r.last_message,
       r.last_tried,
       r.first_seen_at,
       r.last_seen_at
  FROM name_enquiry_refusals r
 ORDER BY r.last_seen_at DESC;

COMMENT ON VIEW name_enquiry_failures IS
    'Why a recipient name could not be confirmed, per rail. The one place the '
    'answer to "it says it cannot find the momo details" is written down.';

/**
 * Record one refusal.
 *
 * `ON CONFLICT DO UPDATE` — the `record_error` shape from 015, because a row
 * per call is the log that table exists to avoid. The FIRST time is kept
 * because it says when the rail started refusing, which is the question an
 * operator asks after a credential was rotated.
 */
CREATE OR REPLACE FUNCTION record_name_enquiry_refusal(
    p_provider  TEXT,
    p_country   TEXT,
    p_rail_code TEXT,
    p_message   TEXT,
    p_tried     TEXT,
    p_key_mode  TEXT
) RETURNS VOID
LANGUAGE sql
AS $$
    INSERT INTO name_enquiry_refusals
        (provider, country, rail_code, refusals, last_message, last_tried, key_mode)
    VALUES (p_provider, upper(p_country), p_rail_code, 1, p_message, p_tried, p_key_mode)
    ON CONFLICT (provider, country, rail_code) DO UPDATE
       SET refusals     = name_enquiry_refusals.refusals + 1,
           last_seen_at = now(),
           last_message = EXCLUDED.last_message,
           last_tried   = EXCLUDED.last_tried,
           key_mode     = EXCLUDED.key_mode;
$$;

COMMENT ON FUNCTION record_name_enquiry_refusal IS
    'Bucketed by rail, never one row per call. Recording a refusal must never '
    'fail the request that was refused -- the caller swallows every error.';

-- ---------------------------------------------------------------------------
--  019 — a table with no stated decision is what that file exists to refuse.
-- ---------------------------------------------------------------------------
INSERT INTO retention_decisions (table_name, decision, rationale)
VALUES
  ('name_enquiry_refusals', 'keep',
   'One row per rail rather than per call, so it is bounded by the number of '
   'rails and holds no customer data at all -- a shape, never a number. It is '
   'the record of when a corridor stopped being able to name a recipient.')
ON CONFLICT (table_name) DO NOTHING;

-- ---------------------------------------------------------------------------
--  036 — every view is classified, or `attention_coverage` reports it.
-- ---------------------------------------------------------------------------
INSERT INTO attention_sources (source, decision, rationale)
VALUES (
    'name_enquiry_failures',
    'watch',
    'A rail that cannot name a recipient refuses every send on that corridor, '
    'and the customer is told to check a number that is correct. Read the '
    'moment somebody reports that a recipient cannot be found; the key mode '
    'and the trail are what distinguish a sandbox key from a real refusal.'
)
ON CONFLICT (source) DO NOTHING;

COMMIT;
