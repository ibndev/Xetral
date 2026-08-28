-- ============================================================================
--  035 — Publishing a price, safely, from something other than a psql prompt.
--
--  WHAT WAS MISSING. `fx_spread_policies` and `giftcard_rate_cards` are both
--  live, both append-only, both read on every quote — and NOTHING IN THE
--  APPLICATION EVER WROTE EITHER. Phase 10 says an unpublished pair is refused
--  rather than quoted from a default, which is right; the consequence nobody
--  wrote down is that FX refuses every pair on a fresh deployment and the only
--  way out is `psql`. Gift cards are worse: PHASES.md lists "publish rate
--  cards" as a prerequisite for enabling the feature, so the flag could be
--  turned on and the first customer quote would 404.
--
--  This file is what makes those tables safe to write from a FORM. That is a
--  different threat model from a psql prompt: at a prompt an operator has
--  composed the whole statement and can see the table; in a form they see one
--  band and press a button, twice, on a Friday.
--
--  THE OVERLAP IS THE REAL HAZARD. `#liveRate` selects on
--  `BETWEEN min_face_minor AND max_face_minor` and then
--  `ORDER BY effective_from DESC LIMIT 1`. Two live bands that overlap are
--  therefore not an error — the newer one silently wins over the overlapping
--  part of the older one's range, so publishing a $10–$100 card next to an
--  existing $50–$500 one changes the price of every card between $50 and $100
--  and NOTHING SAYS SO. A `LIMIT 1` that resolves an ambiguity is an ambiguity
--  the schema should not have allowed.
--
--  An EXCLUDE constraint rather than a unique index, because the thing being
--  refused is a RANGE OVERLAP and not an equality. Phase 8 records that
--  `ON CONFLICT` cannot target an EXCLUDE — that mattered there because
--  issuing a virtual account races itself. Nothing races here: publishing a
--  price is one person pressing one button, and the correct answer to a
--  collision is to refuse and show them what it overlaps.
-- ============================================================================

BEGIN;

-- Needed to mix equality on the text columns with range overlap in one
-- EXCLUDE constraint. Everything else here is core Postgres.
CREATE EXTENSION IF NOT EXISTS btree_gist;

/*
 * NO TWO LIVE BANDS MAY OVERLAP for the same card.
 *
 * `int8range(min, max, '[]')` is INCLUSIVE at both ends, matching the
 * `BETWEEN` the quote actually uses. A half-open range here would permit two
 * bands to share their boundary value and leave exactly one face amount
 * ambiguous — the kind of off-by-one that is found by a customer.
 */
ALTER TABLE giftcard_rate_cards
  ADD CONSTRAINT giftcard_rate_bands_do_not_overlap
  EXCLUDE USING gist (
      brand         WITH =,
      country       WITH =,
      card_type     WITH =,
      face_currency WITH =,
      int8range(min_face_minor, max_face_minor, '[]') WITH &&
  ) WHERE (retired_at IS NULL);

/**
 * Prices nobody is named for.
 *
 * `created_by` is nullable on both tables and stays that way: it has to be,
 * because rows already exist and because a database whose migration refused
 * to apply over them would be a worse problem than an unattributed price.
 * What was missing is any way to SEE them.
 *
 * A published price is append-only precisely so the price of a past trade can
 * be reconstructed. Who set it is the other half of that record, and a row
 * with no author is one that was written at a prompt — which is exactly what
 * this stage exists to stop being necessary.
 */
CREATE VIEW prices_without_an_author AS
  SELECT 'fx_spread'::TEXT AS kind,
         uuid,
         base_currency || '/' || quote_currency AS subject,
         effective_from
    FROM fx_spread_policies
   WHERE retired_at IS NULL AND created_by IS NULL
UNION ALL
  SELECT 'giftcard_rate',
         uuid,
         brand || ' ' || country || ' ' || card_type,
         effective_from
    FROM giftcard_rate_cards
   WHERE retired_at IS NULL AND created_by IS NULL
 ORDER BY effective_from;

/*
 * RETIRING A PRICE TAKES SOMETHING AWAY FROM CUSTOMERS, so it joins 009's
 * list of actions that must say why.
 *
 * That is not obvious and is worth stating: retiring looks like tidying up,
 * and its effect is that the flow the price covered REFUSES every customer
 * until a replacement is published. An unpublished FX pair is not quoted from
 * a default — Phase 10 chose that deliberately — so a spread retired at five
 * on a Friday stops conversions until somebody notices. A reason is the
 * difference between finding that in the log and guessing at it.
 *
 * Publishing is NOT in the list. It is recorded, but a new price is a
 * decision that speaks for itself in its own detail, and requiring prose to
 * set a number people set weekly is how a required field becomes 'update'.
 */
ALTER TABLE admin_audit_log DROP CONSTRAINT destructive_actions_say_why;
ALTER TABLE admin_audit_log ADD CONSTRAINT destructive_actions_say_why CHECK (
    action NOT IN ('user.freeze', 'user.close', 'deposit.return', 'giftcard.clawback',
                   'data.erase', 'price.retire')
    OR reason IS NOT NULL
);

/**
 * What is on sale right now, in one place.
 *
 * The two tables answer the same operational question — what will a customer
 * be quoted today — and an operator checking that a deployment is ready to
 * take traffic should not have to know there are two of them. This is also
 * what makes "FX is configured for no pairs at all" visible rather than
 * something discovered by the first customer to try.
 */
CREATE VIEW published_prices AS
  SELECT 'fx_spread'::TEXT                       AS kind,
         uuid,
         base_currency || '/' || quote_currency   AS subject,
         spread_basis_points::TEXT || 'bp'        AS price,
         'minimum ' || min_base_minor::TEXT       AS terms,
         effective_from,
         created_by
    FROM fx_spread_policies
   WHERE retired_at IS NULL
UNION ALL
  SELECT 'giftcard_rate',
         uuid,
         brand || ' ' || country || ' ' || card_type || ' (' || face_currency || ')',
         payout_rate_minor::TEXT || ' ' || payout_currency || ' per major unit',
         min_face_minor::TEXT || '-' || max_face_minor::TEXT,
         effective_from,
         created_by
    FROM giftcard_rate_cards
   WHERE retired_at IS NULL
 ORDER BY 1, 3;

COMMIT;
