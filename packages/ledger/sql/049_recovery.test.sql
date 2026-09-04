-- 049 — giving a customer's money back, on the record.
BEGIN;

DO $$
DECLARE
    v_user     BIGINT;
    v_actor    BIGINT;
    v_entry    BIGINT;
    v_n        BIGINT;
    v_uuid     UUID := gen_random_uuid();
BEGIN
    INSERT INTO users (email, status) VALUES ('t049-a@example.ng', 'active') RETURNING id INTO v_user;
    INSERT INTO users (email, status) VALUES ('t049-b@example.ng', 'active') RETURNING id INTO v_actor;

    INSERT INTO journal_entries (kind, description, idempotency_key, occurred_at)
    VALUES ('adjustment', 't049 reversal', 't049:entry', now())
    RETURNING id INTO v_entry;

    -- 1. A recovery needs a REASON somebody wrote. A queue cleared with
    --    one-word reasons is indistinguishable from one nobody worked, and
    --    the reason is the part a customer is eventually read back to.
    BEGIN
        INSERT INTO recovery_actions
          (kind, subject_uuid, user_id, amount_minor, currency, reversal_entry_id,
           actioned_by, reason)
        VALUES ('bank_payout', v_uuid, v_user, 500000, 'NGN', v_entry, v_actor, 'ok');
        RAISE EXCEPTION 'TEST FAILED 1: a two-word reason was accepted';
    EXCEPTION WHEN check_violation THEN
        RAISE NOTICE 'PASS 1: a recovery cannot be recorded without a real reason';
    END;

    INSERT INTO recovery_actions
      (kind, subject_uuid, user_id, amount_minor, currency, reversal_entry_id,
       actioned_by, reason)
    VALUES ('bank_payout', v_uuid, v_user, 500000, 'NGN', v_entry, v_actor,
            'the provider never returned a payout id, so nothing was sent');

    -- 2. ONE RECOVERY PER SUBJECT. Pressing the button twice must not post a
    --    second reversal. The ledger's idempotency key would refuse it anyway;
    --    this refuses it earlier and says why.
    BEGIN
        INSERT INTO recovery_actions
          (kind, subject_uuid, user_id, amount_minor, currency, reversal_entry_id,
           actioned_by, reason)
        VALUES ('bank_payout', v_uuid, v_user, 500000, 'NGN', v_entry, v_actor,
                'a second attempt at the same held payout');
        RAISE EXCEPTION 'TEST FAILED 2: the same subject was recovered twice';
    EXCEPTION WHEN unique_violation THEN
        RAISE NOTICE 'PASS 2: a subject can only be recovered once';
    END;

    -- 3. APPEND-ONLY. A record of who gave money back that the person who gave
    --    it back can edit tells you what the last person with access wanted
    --    you to believe.
    BEGIN
        UPDATE recovery_actions SET reason = 'something else' WHERE subject_uuid = v_uuid;
        RAISE EXCEPTION 'TEST FAILED 3: a recovery was edited after the fact';
    EXCEPTION WHEN raise_exception THEN
        IF SQLERRM LIKE 'TEST FAILED%' THEN RAISE; END IF;
        RAISE NOTICE 'PASS 3: a recovery cannot be edited';
    END;

    BEGIN
        DELETE FROM recovery_actions WHERE subject_uuid = v_uuid;
        RAISE EXCEPTION 'TEST FAILED 4: a recovery was deleted';
    EXCEPTION WHEN raise_exception THEN
        IF SQLERRM LIKE 'TEST FAILED%' THEN RAISE; END IF;
        RAISE NOTICE 'PASS 4: a recovery cannot be deleted';
    END;

    -- 5. A ZERO OR NEGATIVE RECOVERY IS NOT A RECOVERY. The ledger refuses a
    --    zero-amount posting for the same reason: a row saying nothing moved
    --    is indistinguishable from one somebody forgot to write.
    BEGIN
        INSERT INTO recovery_actions
          (kind, subject_uuid, user_id, amount_minor, currency, reversal_entry_id,
           actioned_by, reason)
        VALUES ('purchase', gen_random_uuid(), v_user, 0, 'NGN', v_entry, v_actor,
                'a recovery that moves nothing at all');
        RAISE EXCEPTION 'TEST FAILED 5: a zero recovery was accepted';
    EXCEPTION WHEN check_violation THEN
        RAISE NOTICE 'PASS 5: a recovery moves a real amount or it is not recorded';
    END;

    -- 6. THE QUEUE EXCLUDES WHAT HAS BEEN RECOVERED, so pressing the button
    --    removes the row rather than leaving it looking unactioned.
    SELECT COUNT(*) INTO v_n FROM money_awaiting_recovery WHERE subject_uuid = v_uuid;
    IF v_n <> 0 THEN
        RAISE EXCEPTION 'TEST FAILED 6: a recovered subject is still in the queue';
    END IF;
    RAISE NOTICE 'PASS 6: a recovered subject leaves the queue';

    -- 7. AND THE OVERVIEW CAN SEE IT. 036 refuses a queue nobody can see: an
    --    incomplete list that looks complete is trusted, which is worse than
    --    no overview at all.
    SELECT COUNT(*) INTO v_n FROM admin_work_queue WHERE queue = 'recovery';
    IF v_n <> 1 THEN
        RAISE EXCEPTION 'TEST FAILED 7: recovery has no arm in admin_work_queue';
    END IF;
    RAISE NOTICE 'PASS 7: the overview reports the recovery queue';
END $$;

ROLLBACK;
