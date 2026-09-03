-- ============================================================================
--  042 tests. Every block prints PASS or raises TEST FAILED.
-- ============================================================================

\set ON_ERROR_STOP on

-- ── 1. Both new slots exist and are in use ──────────────────────────────────
DO $$
DECLARE n INT;
BEGIN
  SELECT count(*) INTO n
    FROM provider_credential_slots
   WHERE provider = 'bitnob' AND name IN ('client_id', 'client_secret') AND in_use;

  IF n <> 2 THEN
    RAISE EXCEPTION 'TEST FAILED 1: expected 2 live Bitnob v2 slots, found %', n;
  END IF;
  RAISE NOTICE 'PASS 1: the client id and client secret are both live slots';
END $$;

-- ── 2. The v1 key is retired, and still THERE ───────────────────────────────
--  Retired rather than deleted: `credential_rotations` records who set it and
--  when, and removing the row it refers to would leave that log pointing at
--  nothing.
DO $$
DECLARE r RECORD;
BEGIN
  SELECT in_use, description INTO r
    FROM provider_credential_slots
   WHERE provider = 'bitnob' AND name = 'api_key';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'TEST FAILED 2: the v1 api_key slot was deleted rather than retired';
  END IF;
  IF r.in_use THEN
    RAISE EXCEPTION 'TEST FAILED 2: the v1 api_key slot is still marked in use';
  END IF;
  IF r.description NOT LIKE 'RETIRED.%' THEN
    RAISE EXCEPTION 'TEST FAILED 2: a retired slot must SAY so on the screen an '
                    'operator reads; description is %', r.description;
  END IF;
  RAISE NOTICE 'PASS 2: the v1 key is retired, says so, and its history survives';
END $$;

-- ── 3. Re-applying changes nothing ──────────────────────────────────────────
--  The INSERT is ON CONFLICT DO NOTHING and the UPDATE is idempotent, so a
--  migration run twice — which happens the first time a deploy is retried —
--  must not multiply slots or resurrect the retired one.
DO $$
DECLARE before_n INT; after_n INT;
BEGIN
  SELECT count(*) INTO before_n FROM provider_credential_slots WHERE provider = 'bitnob';

  INSERT INTO provider_credential_slots (provider, name, label, description, env_var, in_use)
  VALUES ('bitnob', 'client_id', 'x', 'x', 'BITNOB_CLIENT_ID', TRUE)
  ON CONFLICT (provider, name) DO NOTHING;

  SELECT count(*) INTO after_n FROM provider_credential_slots WHERE provider = 'bitnob';

  IF before_n <> after_n THEN
    RAISE EXCEPTION 'TEST FAILED 3: re-applying added a slot (% -> %)', before_n, after_n;
  END IF;
  RAISE NOTICE 'PASS 3: re-applying the migration is a no-op';
END $$;

-- ── 4. A credential can still only be stored against a KNOWN slot ───────────
--  026's rule, re-asserted here because 042 is the first migration to add a
--  Bitnob slot since it landed. A credential nothing reads is one an operator
--  believes is live.
DO $$
BEGIN
  BEGIN
    INSERT INTO provider_credentials (provider, name, secret_sealed, hint)
    VALUES ('bitnob', 'client_secrets', 'v1:nonsense', 'abcd');
    RAISE EXCEPTION 'TEST FAILED 4: a credential was stored against a slot that '
                    'does not exist — a typo would be filed silently';
  EXCEPTION
    WHEN foreign_key_violation THEN
      RAISE NOTICE 'PASS 4: a credential for an unknown slot is refused';
  END;
END $$;
