-- 048 — the mail provider swapped without losing what the old one recorded.
BEGIN;

DO $$
DECLARE
    v_in_use BOOLEAN;
    v_label  TEXT;
    v_n      INT;
BEGIN
    -- 1. Brevo's slot exists and is READ. `in_use` is what the dashboard
    --    renders as "this is running", so a new provider whose adapter exists
    --    has to say so.
    SELECT in_use INTO v_in_use FROM provider_credential_slots
     WHERE provider = 'brevo' AND name = 'api_key';
    IF v_in_use IS DISTINCT FROM TRUE THEN
        RAISE EXCEPTION 'TEST FAILED 1: brevo.api_key is not in use (got %)', v_in_use;
    END IF;
    RAISE NOTICE 'PASS 1: brevo.api_key exists and is marked in use';

    -- 2. THE RESEND SLOT SURVIVES, MARKED OUT OF USE.
    --
    --    Deleting it would erase 026's rotation history — who set a credential
    --    and when, never what — and that is a record about a secret that once
    --    existed, worth keeping after the secret stops being read.
    SELECT in_use, label INTO v_in_use, v_label FROM provider_credential_slots
     WHERE provider = 'resend' AND name = 'api_key';
    IF v_in_use IS NULL THEN
        RAISE EXCEPTION 'TEST FAILED 2: the resend slot was deleted rather than retired';
    END IF;
    IF v_in_use <> FALSE THEN
        RAISE EXCEPTION 'TEST FAILED 2: resend.api_key is still marked in use';
    END IF;
    IF v_label NOT ILIKE '%retired%' THEN
        RAISE EXCEPTION 'TEST FAILED 2: the resend slot does not say it is retired (%)', v_label;
    END IF;
    RAISE NOTICE 'PASS 2: the resend slot is retired, not deleted, and says so';

    -- 3. NO STORED VALUE WAS CARRIED ACROSS.
    --
    --    The whole substance of this migration. A Resend key sitting in a slot
    --    Brevo reads authenticates against nothing, and the 401 reads as "your
    --    key is wrong" rather than "that is the wrong provider's key" — the
    --    misdiagnosis 042 records about the retired Bitnob v1 credential.
    SELECT count(*) INTO v_n FROM provider_credentials
     WHERE provider = 'brevo'
       AND EXISTS (SELECT 1 FROM provider_credentials r WHERE r.provider = 'resend');
    IF v_n > 0 THEN
        RAISE EXCEPTION 'TEST FAILED 3: a resend credential was copied into the brevo slot';
    END IF;
    RAISE NOTICE 'PASS 3: no value was carried from the retired provider';

    -- 4. EXACTLY ONE SLOT IS THE ONE THAT SENDS EMAIL. Two in use would mean
    --    an operator filling either box and neither being read reliably.
    SELECT count(*) INTO v_n FROM provider_credential_slots
     WHERE name = 'api_key' AND provider IN ('brevo', 'resend') AND in_use;
    IF v_n <> 1 THEN
        RAISE EXCEPTION 'TEST FAILED 4: % mail credential slots are in use, expected 1', v_n;
    END IF;
    RAISE NOTICE 'PASS 4: exactly one mail credential slot is read';
END $$;

ROLLBACK;
