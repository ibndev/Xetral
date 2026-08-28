-- ===========================================================================
--  Xetral — price publication invariants
--  packages/ledger/sql/035_price_publication.test.sql
-- ===========================================================================

\set QUIET on
\pset format unaligned
\pset tuples_only on

INSERT INTO users (email, status) VALUES ('p35-ops@example.ng', 'active');

-- One live band: an Amazon US e-code from $10.00 to $500.00 of face value.
DO $$
DECLARE v_u BIGINT;
BEGIN
    SELECT id INTO v_u FROM users WHERE email = 'p35-ops@example.ng';
    INSERT INTO giftcard_rate_cards
      (brand, country, card_type, face_currency, payout_currency,
       payout_rate_minor, min_face_minor, max_face_minor, created_by)
    VALUES ('p35brand', 'US', 'ecode', 'USD', 'NGN', 125000, 1000, 50000, v_u);
END $$;

\echo '=== 1. Two live bands for one card CANNOT OVERLAP ==='
-- The hazard a form makes likely. `#liveRate` selects on BETWEEN and then
-- ORDER BY effective_from DESC LIMIT 1, so an overlap is not an error: the
-- newer band silently wins over the shared range and the price of every card
-- in it changes with nothing saying so.
DO $$
BEGIN
    INSERT INTO giftcard_rate_cards
      (brand, country, card_type, face_currency, payout_currency,
       payout_rate_minor, min_face_minor, max_face_minor)
    VALUES ('p35brand', 'US', 'ecode', 'USD', 'NGN', 130000, 25000, 100000);
    RAISE EXCEPTION 'TEST FAILED: two live bands overlap and a LIMIT 1 picks between them';
EXCEPTION WHEN exclusion_violation THEN
    RAISE NOTICE 'PASS: an ambiguous price is refused rather than resolved';
END $$;

\echo '=== 2. Sharing ONE BOUNDARY VALUE is still an overlap ==='
-- The quote uses BETWEEN, which is inclusive at both ends, so a band starting
-- exactly where another finishes leaves one face amount ambiguous. That is
-- the off-by-one a customer finds.
DO $$
BEGIN
    INSERT INTO giftcard_rate_cards
      (brand, country, card_type, face_currency, payout_currency,
       payout_rate_minor, min_face_minor, max_face_minor)
    VALUES ('p35brand', 'US', 'ecode', 'USD', 'NGN', 130000, 50000, 100000);
    RAISE EXCEPTION 'TEST FAILED: two bands share their boundary and both match it';
EXCEPTION WHEN exclusion_violation THEN
    RAISE NOTICE 'PASS: the range is inclusive at both ends, like the query';
END $$;

\echo '=== 3. An ADJACENT band is fine ==='
-- The constraint must not make a rate card per denomination impossible: that
-- is the whole reason bands exist, because a $500 card really is worth
-- proportionally less than a $25 one.
DO $$
DECLARE v_n INT;
BEGIN
    INSERT INTO giftcard_rate_cards
      (brand, country, card_type, face_currency, payout_currency,
       payout_rate_minor, min_face_minor, max_face_minor)
    VALUES ('p35brand', 'US', 'ecode', 'USD', 'NGN', 118000, 50001, 200000);

    SELECT count(*) INTO v_n FROM giftcard_rate_cards
     WHERE brand = 'p35brand' AND retired_at IS NULL;
    IF v_n <> 2 THEN
        RAISE EXCEPTION 'TEST FAILED: a band that touches nothing was refused';
    END IF;
    RAISE NOTICE 'PASS: bands per denomination still work';
END $$;

\echo '=== 4. A different card is a different price list ==='
DO $$
DECLARE v_n INT;
BEGIN
    -- Same range, different brand and different card type.
    INSERT INTO giftcard_rate_cards
      (brand, country, card_type, face_currency, payout_currency,
       payout_rate_minor, min_face_minor, max_face_minor)
    VALUES ('p35other', 'US', 'ecode', 'USD', 'NGN', 100000, 1000, 50000);
    INSERT INTO giftcard_rate_cards
      (brand, country, card_type, face_currency, payout_currency,
       payout_rate_minor, min_face_minor, max_face_minor)
    VALUES ('p35brand', 'US', 'physical', 'USD', 'NGN', 90000, 1000, 50000);

    SELECT count(*) INTO v_n FROM giftcard_rate_cards
     WHERE brand IN ('p35brand', 'p35other') AND retired_at IS NULL;
    IF v_n <> 4 THEN
        RAISE EXCEPTION 'TEST FAILED: expected four live bands, found %', v_n;
    END IF;
    RAISE NOTICE 'PASS: the constraint is per card, not per range';
END $$;

\echo '=== 5. RETIRING one frees its range ==='
-- Republishing at a new price is the ONLY way to change one, so the
-- constraint has to leave that path open or it would make the append-only
-- rule unusable.
DO $$
DECLARE v_n INT;
BEGIN
    UPDATE giftcard_rate_cards SET retired_at = now()
     WHERE brand = 'p35brand' AND card_type = 'ecode'
       AND min_face_minor = 1000 AND retired_at IS NULL;

    INSERT INTO giftcard_rate_cards
      (brand, country, card_type, face_currency, payout_currency,
       payout_rate_minor, min_face_minor, max_face_minor)
    VALUES ('p35brand', 'US', 'ecode', 'USD', 'NGN', 121000, 1000, 50000);

    SELECT count(*) INTO v_n FROM giftcard_rate_cards
     WHERE brand = 'p35brand' AND card_type = 'ecode' AND min_face_minor = 1000;
    IF v_n <> 2 THEN
        RAISE EXCEPTION 'TEST FAILED: the retired band is gone rather than kept';
    END IF;
    RAISE NOTICE 'PASS: retire and republish, and the old price is still on record';
END $$;

\echo '=== 6. A price nobody is named for is VISIBLE ==='
-- A published price is append-only so the price of a past trade can be
-- reconstructed. Who set it is the other half of that record, and a row with
-- no author was written at a prompt.
DO $$
DECLARE v_n INT;
BEGIN
    SELECT count(*) INTO v_n FROM prices_without_an_author
     WHERE subject LIKE 'p35brand%';
    IF v_n = 0 THEN
        RAISE EXCEPTION 'TEST FAILED: unattributed prices are invisible';
    END IF;
    RAISE NOTICE 'PASS: a price written at a prompt can be found';
END $$;

\echo '=== 7. And one published through the dashboard is NOT listed ==='
-- Otherwise the view would be a list of every price, which nobody reads.
DO $$
DECLARE v_u BIGINT; v_n INT;
BEGIN
    SELECT id INTO v_u FROM users WHERE email = 'p35-ops@example.ng';
    SELECT count(*) INTO v_n FROM prices_without_an_author p
      JOIN giftcard_rate_cards r ON r.uuid = p.uuid
     WHERE r.created_by = v_u;
    IF v_n <> 0 THEN
        RAISE EXCEPTION 'TEST FAILED: an attributed price is reported as anonymous';
    END IF;
    RAISE NOTICE 'PASS: the view is a queue rather than a listing';
END $$;

\echo '=== 8. Both price lists are readable in ONE place ==='
-- FX spreads and gift card rates answer the same operational question — what
-- will a customer be quoted today — and an operator checking a deployment
-- should not have to know there are two tables.
DO $$
DECLARE v_u BIGINT; v_kinds INT;
BEGIN
    SELECT id INTO v_u FROM users WHERE email = 'p35-ops@example.ng';
    -- GHS/KES because no other suite prices it. `008_fx.test.sql` has
    -- published NGN/USD since Phase 10, and these files share one database in
    -- CI order — the collision Phase 10 recorded, in a new file.
    INSERT INTO fx_spread_policies
      (base_currency, quote_currency, spread_basis_points, min_base_minor, created_by)
    VALUES ('GHS', 'KES', 150, 100000, v_u);

    SELECT count(DISTINCT kind) INTO v_kinds FROM published_prices;
    IF v_kinds <> 2 THEN
        RAISE EXCEPTION 'TEST FAILED: expected both price kinds, found %', v_kinds;
    END IF;
    RAISE NOTICE 'PASS: what a customer will be quoted is one query';
END $$;

\echo '=== 9. ONE live FX policy per pair and direction ==='
-- Already true, and asserted here because this is the file that makes these
-- tables writable from a form: two live spreads for one pair would make a
-- quote depend on which row came back first.
DO $$
BEGIN
    INSERT INTO fx_spread_policies
      (base_currency, quote_currency, spread_basis_points, min_base_minor)
    VALUES ('GHS', 'KES', 200, 100000);
    RAISE EXCEPTION 'TEST FAILED: two live spreads for one pair';
EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'PASS: one live spread per pair';
END $$;

\echo '=== 10. The reverse direction is a DIFFERENT policy ==='
-- NGN->USD and USD->NGN are priced separately and deliberately: a rate is a
-- ratio, and "minor units per major unit" collapses in one of the two
-- directions. Refusing the reverse pair here would make half of FX
-- unpublishable.
DO $$
DECLARE v_n INT;
BEGIN
    INSERT INTO fx_spread_policies
      (base_currency, quote_currency, spread_basis_points, min_base_minor)
    VALUES ('KES', 'GHS', 175, 100);

    SELECT count(*) INTO v_n FROM fx_spread_policies
     WHERE retired_at IS NULL AND base_currency IN ('GHS', 'KES')
       AND quote_currency IN ('GHS', 'KES');
    IF v_n <> 2 THEN
        RAISE EXCEPTION 'TEST FAILED: expected both directions, found %', v_n;
    END IF;
    RAISE NOTICE 'PASS: each direction is priced on its own';
END $$;

\echo '=== 11. Retiring a price must SAY WHY ==='
-- It looks like tidying up, and its effect is that the flow the price covered
-- REFUSES every customer until a replacement exists: an unpublished FX pair
-- is not quoted from a default. A reason is the difference between finding
-- that in the log and guessing at it.
DO $$
DECLARE v_u BIGINT;
BEGIN
    SELECT id INTO v_u FROM users WHERE email = 'p35-ops@example.ng';
    INSERT INTO admin_audit_log (actor_id, action, subject_type, subject_id, detail)
    VALUES (v_u, 'price.retire', 'price', 'p35', '{}'::jsonb);
    RAISE EXCEPTION 'TEST FAILED: a price was withdrawn with no reason recorded';
EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS: withdrawing a price explains itself';
END $$;

\echo '=== 12. Publishing one does NOT ==='
-- Requiring prose to set a number people set weekly is how a required field
-- becomes the word "update".
DO $$
DECLARE v_u BIGINT; v_n INT;
BEGIN
    SELECT id INTO v_u FROM users WHERE email = 'p35-ops@example.ng';
    INSERT INTO admin_audit_log (actor_id, action, subject_type, subject_id, detail)
    VALUES (v_u, 'price.publish', 'price', 'p35', '{"spread_basis_points": 150}'::jsonb);

    SELECT count(*) INTO v_n FROM admin_audit_log
     WHERE action = 'price.publish' AND subject_id = 'p35';
    IF v_n <> 1 THEN
        RAISE EXCEPTION 'TEST FAILED: publishing a price was refused';
    END IF;
    RAISE NOTICE 'PASS: the detail is the record for a new price';
END $$;
