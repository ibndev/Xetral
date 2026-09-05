-- ===========================================================================
--  Xetral — invariants for 057_reference_rates.sql
--  Every block prints PASS. A TEST FAILED means a control is not wired up.
--
--  THE PAIRS HERE ARE CAD, JPY AND GBP, deliberately. These suites share one
--  database and 053's own file already publishes live NGN/GHS, GHS/NGN and
--  NGN/KES rates — and `fx_published_rates_live` is UNIQUE per direction, so
--  reusing one aborts this whole file on its first block, in CI order, where
--  nobody is watching.
-- ===========================================================================

\set ON_ERROR_STOP on

-- ---------------------------------------------------------------------------
-- 1. A RATE SAYS WHERE IT CAME FROM, AND DEFAULTS TO A PERSON
--
-- The default is the conservative answer: a row written by something that has
-- not been taught about this column is a price somebody chose, which is the
-- reading that keeps it OUT of the feed's way and IN the unattributed list.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    src TEXT;
BEGIN
    INSERT INTO fx_published_rates
      (base_currency, quote_currency, numerator, denominator, quote_per_base)
    VALUES ('CAD', 'JPY', 1, 1000, '0.0065');

    SELECT source INTO src FROM fx_published_rates
     WHERE base_currency = 'CAD' AND quote_currency = 'JPY' AND retired_at IS NULL;

    IF src <> 'operator' THEN
        RAISE EXCEPTION 'TEST FAILED 1: a rate defaulted to source %', src;
    END IF;

    RAISE NOTICE 'PASS 1: a rate records its source and defaults to an operator';
END $$;

-- ---------------------------------------------------------------------------
-- 2. THE SOURCE CANNOT BE EDITED
--
-- 053's trigger names every field it protects, so a column added afterwards is
-- silently editable. Relabelling a feed rate as an operator's would make the
-- screen describe a decision nobody took.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
    BEGIN
        UPDATE fx_published_rates SET source = 'reference_feed'
         WHERE base_currency = 'CAD' AND quote_currency = 'JPY' AND retired_at IS NULL;
        RAISE EXCEPTION 'TEST FAILED 2: a published rate was relabelled';
    EXCEPTION WHEN raise_exception THEN
        IF SQLERRM LIKE 'TEST FAILED%' THEN RAISE; END IF;
    END;

    RAISE NOTICE 'PASS 2: the source of a published rate is immutable';
END $$;

-- ---------------------------------------------------------------------------
-- 3. AN UNKNOWN SOURCE IS REFUSED
-- ---------------------------------------------------------------------------
DO $$
BEGIN
    BEGIN
        INSERT INTO fx_published_rates
          (base_currency, quote_currency, numerator, denominator, quote_per_base, source)
        VALUES ('CAD', 'GBP', 1, 100, '0.086', 'a-guess');
        RAISE EXCEPTION 'TEST FAILED 3: an unknown rate source was accepted';
    EXCEPTION WHEN check_violation THEN
        NULL;
    END;

    RAISE NOTICE 'PASS 3: a rate source must be one this schema knows';
END $$;

-- ---------------------------------------------------------------------------
-- 4. A FEED RATE IS NOT AN UNATTRIBUTED PRICE
--
-- 035's list exists to find rows written at a psql prompt. A feed rate also
-- has no author, and listing it would fill that queue with fifty-six entries a
-- day until nobody read it — while a rate typed at a prompt must still appear.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    listed INT;
BEGIN
    INSERT INTO fx_published_rates
      (base_currency, quote_currency, numerator, denominator, quote_per_base, source)
    VALUES ('JPY', 'CAD', 1, 12, '0.083', 'reference_feed');

    SELECT count(*) INTO listed FROM prices_without_an_author
     WHERE kind = 'fx_rate' AND subject = 'JPY/CAD';
    IF listed <> 0 THEN
        RAISE EXCEPTION 'TEST FAILED 4: a feed rate was listed as unattributed';
    END IF;

    -- And the other direction: a rate with no author that nobody's feed wrote
    -- is exactly what that view is for.
    SELECT count(*) INTO listed FROM prices_without_an_author
     WHERE kind = 'fx_rate' AND subject = 'CAD/JPY';
    IF listed <> 1 THEN
        RAISE EXCEPTION 'TEST FAILED 4: a hand-written rate with no author was not listed';
    END IF;

    RAISE NOTICE 'PASS 4: a feed rate is not reported as a price nobody chose';
END $$;

-- ---------------------------------------------------------------------------
-- 5. A FEED THAT HAS STOPPED IS VISIBLE
--
-- The failure the whole feature introduces, and the only thing that can see
-- it: nothing errors when a feed stops. The rows stay, the screen renders, and
-- customers are quoted whatever it last said.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    stale INT;
BEGIN
    INSERT INTO fx_published_rates
      (base_currency, quote_currency, numerator, denominator, quote_per_base,
       source, effective_from)
    VALUES ('GBP', 'CAD', 12, 1, '12.0', 'reference_feed', now() - interval '5 days');

    SELECT count(*) INTO stale FROM stale_reference_rates
     WHERE base_currency = 'GBP' AND quote_currency = 'CAD';
    IF stale <> 1 THEN
        RAISE EXCEPTION 'TEST FAILED 5: a five-day-old feed rate was not reported';
    END IF;

    -- A rate published a moment ago must NOT be listed, or the alert is noise
    -- from the day it ships.
    SELECT count(*) INTO stale FROM stale_reference_rates
     WHERE base_currency = 'JPY' AND quote_currency = 'CAD';
    IF stale <> 0 THEN
        RAISE EXCEPTION 'TEST FAILED 5: a fresh feed rate was reported as stale';
    END IF;

    RAISE NOTICE 'PASS 5: a feed that has stopped refreshing is reported';
END $$;

-- ---------------------------------------------------------------------------
-- 6. THE SCREEN CAN SEE THE SOURCE AND THE AGE
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    src TEXT;
    age BIGINT;
BEGIN
    SELECT source, age_seconds INTO src, age FROM published_fx_rates
     WHERE base_currency = 'GBP' AND quote_currency = 'CAD';

    IF src <> 'reference_feed' THEN
        RAISE EXCEPTION 'TEST FAILED 6: the view does not carry the source';
    END IF;
    IF age IS NULL OR age < 60 * 60 * 24 * 4 THEN
        RAISE EXCEPTION 'TEST FAILED 6: the view reports an age of %', age;
    END IF;

    RAISE NOTICE 'PASS 6: the prices screen can see where a rate came from and how old it is';
END $$;

-- ---------------------------------------------------------------------------
-- 7. THE CREDENTIAL SLOT EXISTS
--
-- A key pasted into a slot the catalogue does not know is refused, so without
-- this row an operator could not turn the feed on at all.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    n INT;
BEGIN
    SELECT count(*) INTO n FROM provider_credential_slots
     WHERE provider = 'exchangerate' AND name = 'api_key' AND in_use;
    IF n <> 1 THEN
        RAISE EXCEPTION 'TEST FAILED 7: there is no live ExchangeRate-API credential slot';
    END IF;

    RAISE NOTICE 'PASS 7: the rate feed has a credential slot an operator can fill';
END $$;
