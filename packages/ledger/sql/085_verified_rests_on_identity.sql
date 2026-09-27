-- ===========================================================================
--  Xetral — "verified" rests on a reviewed identity, never on a tier alone
--  packages/ledger/sql/085_verified_rests_on_identity.sql
--
--  WHAT WAS WRONG: customers were shown as VERIFIED with no BVN on file. KYC
--  approval is a person reading a submission that must carry a BVN — that
--  path was sound. The other one was not: an administrator could raise
--  `users.kyc_tier` to 1 directly, and both apps read tier 1 as "Verified",
--  so an account whose identity nobody had ever checked got a verified
--  ceiling and a verified badge.
--
--  SO A TIER ABOVE 0 REQUIRES AN APPROVED SUBMISSION, BY TRIGGER. 029 already
--  makes each tier rest on the one below; this makes tier 1 rest on the thing
--  "verified" means. Raising only — going DOWN stays unrestricted, 029's rule
--  that finding out we were wrong must never be harder than the mistake.
--
--  AND THE ACCOUNTS ALREADY IN THAT STATE ARE PUT BACK TO 0, recorded by 029's
--  own trigger with the reason. A customer demoted here keeps every naira:
--  a tier is a daily ceiling, never a balance. They verify the ordinary way.
--
--  NO AUTOMATIC PATH EXISTS: there is no identity-verification adapter
--  (026's Dojah slots are `in_use = FALSE`), so a person approves every one.
-- ===========================================================================

BEGIN;

CREATE OR REPLACE FUNCTION assert_tier_rests_on_identity() RETURNS TRIGGER AS $$
BEGIN
    IF NEW.kyc_tier >= 1
       AND (TG_OP = 'INSERT' OR NEW.kyc_tier > OLD.kyc_tier)
       AND NOT EXISTS (SELECT 1 FROM kyc_submissions k
                        WHERE k.user_id = NEW.id AND k.status = 'approved') THEN
        RAISE EXCEPTION
            'a verified tier rests on an approved identity: user % has no reviewed '
            'submission (with its BVN) behind tier %', NEW.id, NEW.kyc_tier
            USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS users_tier_rests_on_identity ON users;
CREATE TRIGGER users_tier_rests_on_identity
    BEFORE INSERT OR UPDATE OF kyc_tier ON users
    FOR EACH ROW EXECUTE FUNCTION assert_tier_rests_on_identity();

-- The repair. 029's recording trigger writes each change; the reason is
-- completed here on the same transaction, as the admin endpoint does.
WITH demoted AS (
    UPDATE users u SET kyc_tier = 0
     WHERE u.kyc_tier >= 1
       AND NOT EXISTS (SELECT 1 FROM kyc_submissions k
                        WHERE k.user_id = u.id AND k.status = 'approved')
    RETURNING u.id
)
UPDATE kyc_tier_changes t
   SET reason = '085: no reviewed identity behind the tier'
  FROM demoted d
 WHERE t.user_id = d.id
   AND t.id = (SELECT max(id) FROM kyc_tier_changes x WHERE x.user_id = d.id)
   AND t.reason IS NULL;

COMMIT;
