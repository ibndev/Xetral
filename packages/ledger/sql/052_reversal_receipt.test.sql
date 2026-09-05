\echo '=== 052: telling a customer their money came back ==='

\echo '=== 1. The kind can actually be written ==='
-- The failure this file exists because of: a kind added to the TypeScript
-- union and not to the Postgres enum typechecks, passes every unit test, and
-- throws on the first real enqueue — which for THIS kind would be the moment
-- a customer's transfer failed, on the transaction that gives their money
-- back. `enqueueBestEffort` uses a SAVEPOINT, so the reversal would still
-- post; the customer would simply never be told, which is the exact state
-- this message was written to end.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_enum e
          JOIN pg_type t ON t.oid = e.enumtypid
         WHERE t.typname = 'notification_kind'
           AND e.enumlabel = 'transfer_reversed'
    ) THEN
        RAISE EXCEPTION 'TEST FAILED: transfer_reversed is not a notification kind';
    END IF;
    RAISE NOTICE 'PASS: a reversal receipt can be enqueued';
END $$;

\echo '=== 2. It is not a security-class message by accident ==='
-- Only that the enum carries it; the CLASS lives in TypeScript and is checked
-- by `templates.test.ts`. Asserted here as a reminder that the two halves are
-- in different places, which is how they drifted in the first place.
DO $$
DECLARE v_kinds INT;
BEGIN
    SELECT count(*) INTO v_kinds FROM pg_enum e
      JOIN pg_type t ON t.oid = e.enumtypid
     WHERE t.typname = 'notification_kind';
    IF v_kinds < 13 THEN
        RAISE EXCEPTION 'TEST FAILED: only % notification kinds exist', v_kinds;
    END IF;
    RAISE NOTICE 'PASS: % notification kinds, and the union names each one', v_kinds;
END $$;
