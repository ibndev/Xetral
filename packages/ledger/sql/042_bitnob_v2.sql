-- ============================================================================
--  042 — Bitnob v2: two credentials, because a request is SIGNED not BORNE.
--
--  WHAT WAS BROKEN
--
--  Every Bitnob call was being refused, and had been since the credential was
--  first pasted. The client sent `authorization: Bearer <api key>`, which is
--  how Bitnob's v1 API worked and how their published Node SDK still reads.
--  v2 does not accept it: it wants four headers carrying an HMAC-SHA256 over
--  `CLIENT_ID:TIMESTAMP:NONCE:PAYLOAD`, and a bearer token gets a
--  `401 UNAUTHORIZED` reading "Invalid HMAC signature".
--
--  From inside the app that is indistinguishable from a wrong key — which is
--  exactly what it looked like. Cards, crypto, FX quotes and dedicated naira
--  account numbers all reported "something went wrong"; `/admin/credentials`
--  said the credential was set, because it was. It was the wrong SHAPE of
--  credential, sent the wrong way, and nothing anywhere could say so.
--
--  WHY THIS IS NOT A RENAME
--
--  `api_key` is not reused under a new name and its value is not copied into
--  either new slot. A v1 key is neither an id their API recognises nor a
--  secret it can verify against, so carrying it forward would turn "you are
--  still on the old credential" into "your credential is wrong" — the same
--  misdiagnosis, preserved in the schema.
--
--  So the slot is marked `in_use = FALSE` instead. That column exists for
--  precisely this: 026's own header says a filled box on an operations screen
--  reads as "this is running", and an operator who believes Bitnob is
--  authorised when it is not is worse off than one who knows it is not. The
--  stored value is left alone rather than deleted — `credential_rotations`
--  records who set it and when, and quietly removing the row it refers to
--  would leave a rotation log pointing at nothing.
--
--  THE ASYMMETRY BETWEEN THE TWO NEW SLOTS IS REAL
--
--  `client_id` identifies the caller and travels in every request; it is not
--  secret. `client_secret` signs and is never transmitted. Both live here
--  anyway, because 026's argument is about the TABLE and not about secrecy: a
--  credential belongs where it can be replaced during an incident without a
--  deploy, and where its history is a rotation log rather than a
--  `platform_settings_history` row that can never be scrubbed.
--
--  AND THE SECRET SELECTS THE ENVIRONMENT
--
--  Bitnob serves sandbox and production from ONE host, `https://api.bitnob.com`.
--  The client id is the same in both; the secret differs, and the secret you
--  sign with is what decides whether the money is real. That is why the
--  staging guard can no longer be a substring test on a URL — see
--  `assertProviderSandbox` in `apps/api/src/config.ts`.
-- ============================================================================

BEGIN;

INSERT INTO provider_credential_slots (provider, name, label, description, env_var, in_use)
VALUES
  ('bitnob', 'client_id', 'Bitnob client ID',
   'Identifies this platform on every Bitnob request. Not secret — it travels '
   'in the clear in the x-auth-client header. The SAME value in sandbox and '
   'production.',
   'BITNOB_CLIENT_ID', TRUE),

  ('bitnob', 'client_secret', 'Bitnob client secret',
   'Signs every Bitnob request and is never transmitted. Shown once when the '
   'key is generated. SANDBOX AND PRODUCTION HAVE DIFFERENT SECRETS, and the '
   'one signed with is what selects the environment — so this value is what '
   'decides whether a card issued is real.',
   'BITNOB_CLIENT_SECRET', TRUE)
ON CONFLICT (provider, name) DO NOTHING;

-- Retired, not deleted. See the header.
UPDATE provider_credential_slots
   SET in_use = FALSE,
       description =
         'RETIRED. This was the v1 bearer key. Bitnob v2 signs each request '
         'with a client id and secret instead, so nothing reads this value '
         'and filling it authorises nothing. Use the Bitnob client ID and '
         'client secret above.'
 WHERE provider = 'bitnob' AND name = 'api_key';

COMMIT;
