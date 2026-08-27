-- ===========================================================================
--  Xetral — provider credential invariants
--  packages/ledger/sql/026_provider_credentials.test.sql
-- ===========================================================================

\set QUIET on
\pset format unaligned
\pset tuples_only on

INSERT INTO users (email, status) VALUES
  ('p26-admin@example.ng', 'active'),
  ('p26-other@example.ng', 'active');

\echo '=== 1. A PLAINTEXT credential cannot reach a row ==='
-- Structural rather than customary, exactly like `bvn_sealed` and a gift card
-- code: the CHECK refuses a value with no key version, so a bare API key
-- cannot be stored even from psql.
DO $$
BEGIN
    INSERT INTO provider_credentials (provider, name, secret_sealed, hint)
    VALUES ('bitnob', 'api_key', 'XETRAL-TEST-PLAINTEXT-NOT-A-REAL-KEY', 'akey');
    RAISE EXCEPTION 'TEST FAILED: a plaintext credential was stored';
EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS: a credential is sealed or it is not stored';
END $$;

\echo '=== 2. A HINT longer than four characters is refused ==='
-- "Just enough to recognise it" becomes "most of it" the first time somebody
-- is debugging in a hurry, and then a dashboard screenshot carries a working
-- credential. The same lesson `cards.last4` records with the same shape of
-- CHECK.
DO $$
BEGIN
    INSERT INTO provider_credentials (provider, name, secret_sealed, hint)
    VALUES ('bitnob', 'api_key', 'v1:iv:tag:ct', 'abcdefghi');
    RAISE EXCEPTION 'TEST FAILED: a nine-character hint was stored';
EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS: a hint is four characters, so a screenshot is not a key';
END $$;

\echo '=== 3. A credential for an UNKNOWN slot is refused ==='
-- A slot nothing reads is a credential an operator believes is live. The
-- catalogue is what makes "I pasted it and it did nothing" impossible.
DO $$
BEGIN
    INSERT INTO provider_credentials (provider, name, secret_sealed, hint)
    VALUES ('paystack', 'api_key', 'v1:iv:tag:ct', 'abcd');
    RAISE EXCEPTION 'TEST FAILED: a credential was stored for an unknown slot';
EXCEPTION WHEN foreign_key_violation THEN
    RAISE NOTICE 'PASS: only a slot this platform knows about can be filled';
END $$;

\echo '=== 4. Storing one RECORDS THE ROTATION, by trigger ==='
-- By trigger and not by the endpoint, so a credential cannot be replaced
-- without the replacement being recorded — including by somebody at a psql
-- prompt, which is the case an endpoint-side record does not cover.
DO $$
DECLARE v_admin BIGINT; v_row RECORD;
BEGIN
    SELECT id INTO v_admin FROM users WHERE email = 'p26-admin@example.ng';

    INSERT INTO provider_credentials (provider, name, secret_sealed, hint, updated_by)
    VALUES ('bitnob', 'api_key', 'v1:iv:tag:first', 'aaaa', v_admin);

    SELECT * INTO v_row FROM provider_credential_rotations
     WHERE provider = 'bitnob' AND name = 'api_key';
    IF NOT FOUND THEN
        RAISE EXCEPTION 'TEST FAILED: filling a slot recorded no rotation';
    END IF;
    IF v_row.old_hint IS NOT NULL THEN
        RAISE EXCEPTION 'TEST FAILED: the first fill claimed to replace something';
    END IF;
    IF v_row.new_hint <> 'aaaa' OR v_row.changed_by <> v_admin THEN
        RAISE EXCEPTION 'TEST FAILED: the rotation records the wrong thing';
    END IF;
    RAISE NOTICE 'PASS: filling a slot records who did it and when';
END $$;

\echo '=== 5. REPLACING one records the old hint and the new ==='
DO $$
DECLARE v_other BIGINT; v_row RECORD;
BEGIN
    SELECT id INTO v_other FROM users WHERE email = 'p26-other@example.ng';

    UPDATE provider_credentials
       SET secret_sealed = 'v1:iv:tag:second', hint = 'bbbb', updated_by = v_other
     WHERE provider = 'bitnob' AND name = 'api_key';

    SELECT * INTO v_row FROM provider_credential_rotations
     WHERE provider = 'bitnob' AND name = 'api_key'
     ORDER BY changed_at DESC, id DESC LIMIT 1;

    IF v_row.old_hint <> 'aaaa' OR v_row.new_hint <> 'bbbb' THEN
        RAISE EXCEPTION 'TEST FAILED: the rotation does not record the replacement';
    END IF;
    IF v_row.changed_by <> v_other THEN
        RAISE EXCEPTION 'TEST FAILED: the rotation names the wrong person';
    END IF;
    RAISE NOTICE 'PASS: a replacement records who replaced what';
END $$;

\echo '=== 6. The rotation log holds NO SECRET, by shape ==='
-- The whole difference from `platform_settings_history`, which records every
-- value a row has ever held. Applied to an API key that would leave the
-- compromised one in an append-only table for ever — the opposite of what
-- rotating is for. Asserted on the columns, so nobody can add one.
DO $$
DECLARE v_col TEXT;
BEGIN
    FOR v_col IN
        SELECT column_name FROM information_schema.columns
         WHERE table_name = 'provider_credential_rotations'
    LOOP
        IF v_col ILIKE '%secret%' OR v_col ILIKE '%sealed%' OR v_col ILIKE '%value%' THEN
            RAISE EXCEPTION 'TEST FAILED: the rotation log has a column called %', v_col;
        END IF;
    END LOOP;
    RAISE NOTICE 'PASS: the rotation log records that it happened, never what it was';
END $$;

\echo '=== 7. The rotation log is APPEND-ONLY ==='
DO $$
BEGIN
    UPDATE provider_credential_rotations SET new_hint = 'zzzz'
     WHERE provider = 'bitnob' AND name = 'api_key';
    RAISE EXCEPTION 'TEST FAILED: a rotation record was rewritten';
EXCEPTION WHEN restrict_violation THEN
    RAISE NOTICE 'PASS: a rotation record cannot be rewritten';
END $$;

\echo '=== 8. The dashboard view exposes NO sealed value ==='
-- There is no path from an HTTP response to a credential: not sealed, not
-- masked, not partially. A view that carried the ciphertext would put it in
-- every response, every log line and every browser tab that rendered the page.
DO $$
DECLARE v_col TEXT;
BEGIN
    FOR v_col IN
        SELECT column_name FROM information_schema.columns
         WHERE table_name = 'provider_credential_status'
    LOOP
        IF v_col ILIKE '%secret%' OR v_col ILIKE '%sealed%' THEN
            RAISE EXCEPTION 'TEST FAILED: the status view exposes %', v_col;
        END IF;
    END LOOP;
    RAISE NOTICE 'PASS: the operator sees whether a key is set, never the key';
END $$;

\echo '=== 9. An EMPTY slot appears as a row, not as nothing ==='
-- A settings page listing only what is configured is a page on which a
-- missing credential is invisible — which is the failure this whole table
-- exists to make impossible to overlook.
DO $$
DECLARE v_row RECORD;
BEGIN
    SELECT * INTO v_row FROM provider_credential_status
     WHERE provider = 'resend' AND name = 'api_key';
    IF NOT FOUND THEN
        RAISE EXCEPTION 'TEST FAILED: an unfilled slot is missing from the view';
    END IF;
    IF v_row.is_set THEN
        RAISE EXCEPTION 'TEST FAILED: an unfilled slot reports as set';
    END IF;
    IF v_row.hint IS NOT NULL THEN
        RAISE EXCEPTION 'TEST FAILED: an unfilled slot carries a hint';
    END IF;
    RAISE NOTICE 'PASS: an empty slot is a row that says so';
END $$;

\echo '=== 10. A slot with NO ADAPTER says so ==='
-- Dojah's slots are documented ahead of the integration, so a key can be
-- pasted now and be in the right place when the adapter lands. `in_use` is
-- what stops the dashboard implying that pasting one turned identity
-- verification on.
DO $$
DECLARE v_live INT; v_waiting INT;
BEGIN
    SELECT count(*) INTO v_live    FROM provider_credential_status
     WHERE provider = 'dojah' AND in_use;
    SELECT count(*) INTO v_waiting FROM provider_credential_status
     WHERE provider = 'dojah' AND NOT in_use;

    IF v_live > 0 THEN
        RAISE EXCEPTION
            'TEST FAILED: % Dojah slot(s) claim to be in use, but no adapter reads '
            'them. Set in_use once one does.', v_live;
    END IF;
    IF v_waiting = 0 THEN
        RAISE EXCEPTION 'TEST FAILED: the Dojah slots are missing from the catalogue';
    END IF;
    RAISE NOTICE 'PASS: a slot with no adapter is offered and labelled as not wired';
END $$;
