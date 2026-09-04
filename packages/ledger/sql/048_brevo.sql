-- ---------------------------------------------------------------------------
--  048 — Brevo replaces Resend as the thing that sends email
--
--  ONE PROVIDER SENDS EVERY MESSAGE THIS PLATFORM OWES, so swapping it is not
--  a preference: a password reset, a new-device alert and a transaction
--  receipt all go through the same port, and the one that does not arrive is
--  a customer locked out of their own money.
--
--  THE SLOT IS RETIRED, NOT RENAMED, and that is the whole substance of this
--  migration. A stored Resend key carried into a slot Brevo reads is a
--  credential that authenticates against nothing — and the 401 it produces
--  reads as "your key is wrong" rather than "that is the wrong provider's
--  key". 042 records exactly this about the retired Bitnob v1 credential:
--  carrying the value forward preserves the misdiagnosis in the schema.
--
--  So the old row is marked out of use and left in place. Deleting it would
--  erase the rotation history 026 keeps deliberately — who set a credential
--  and when, never what — and that history is a record about a secret that
--  once existed, which is worth keeping after the secret stops being read.
-- ---------------------------------------------------------------------------

BEGIN;

-- ---------------------------------------------------------------------------
--  The new slot. `in_use` TRUE: the adapter exists and reads it.
-- ---------------------------------------------------------------------------
INSERT INTO provider_credential_slots
  (provider, name, label, description, env_var, in_use)
VALUES
  ('brevo', 'api_key', 'Brevo API key',
   'The only thing that sends email. Without it the outbox fills, the API '
   'answers "check your inbox", and nothing is ever delivered. This is a '
   'TRANSACTIONAL key (v3, prefixed xkeysib-) — the sender domain must also '
   'be authenticated in Brevo or every send is refused.',
   'BREVO_API_KEY', TRUE)
ON CONFLICT (provider, name) DO UPDATE
   SET label       = EXCLUDED.label,
       description = EXCLUDED.description,
       env_var     = EXCLUDED.env_var,
       in_use      = TRUE;

-- ---------------------------------------------------------------------------
--  The old one. `in_use` FALSE is what the dashboard renders as "stored and
--  read by nothing" — 026's own state for a slot documented ahead of its
--  adapter, used here for the opposite case: an adapter that has gone.
--
--  A FILLED BOX ON AN OPERATIONS SCREEN READS AS SOMETHING THAT IS RUNNING,
--  which is why this cannot simply be left alone.
-- ---------------------------------------------------------------------------
UPDATE provider_credential_slots
   SET in_use      = FALSE,
       label       = 'Resend API key (retired)',
       description = 'RETIRED. Email is sent through Brevo now and nothing '
                     'reads this. It is kept rather than deleted so 026''s '
                     'rotation history — who set a credential and when — '
                     'survives the provider it belonged to.'
 WHERE provider = 'resend' AND name = 'api_key';

COMMIT;
