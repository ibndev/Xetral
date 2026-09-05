\echo '=== 054: elevation measured from idleness, and capped ==='

\echo '=== 1. Both timestamps exist, because they answer different questions ==='
-- `totp_verified_at` slides and says when this stopped being idle;
-- `totp_first_verified_at` does not move and says how long the run has gone
-- on. Neither can be derived from the other, which is why there are two.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_name = 'auth_sessions' AND column_name = 'totp_first_verified_at'
    ) THEN
        RAISE EXCEPTION 'TEST FAILED: there is no record of when elevation began';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_name = 'auth_sessions' AND column_name = 'totp_verified_at'
    ) THEN
        RAISE EXCEPTION 'TEST FAILED: there is no record of the last elevated action';
    END IF;
    RAISE NOTICE 'PASS: idleness and total age are recorded separately';
END $$;

\echo '=== 2. A session elevated before this migration is not thrown out ==='
-- The backfill. Without it every session elevated at the moment of deployment
-- would have a NULL start, be measured from the epoch, and be refused at once
-- — asking every operator for a code simultaneously, which is exactly the
-- interruption this file removes.
DO $$
DECLARE v_stragglers BIGINT;
BEGIN
    SELECT count(*) INTO v_stragglers
      FROM auth_sessions
     WHERE totp_verified_at IS NOT NULL AND totp_first_verified_at IS NULL;
    IF v_stragglers > 0 THEN
        RAISE EXCEPTION
            'TEST FAILED: % elevated sessions have no start time', v_stragglers;
    END IF;
    RAISE NOTICE 'PASS: sessions elevated before the change keep their elevation';
END $$;
