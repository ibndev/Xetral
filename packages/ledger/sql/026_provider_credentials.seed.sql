-- ============================================================================
--  026 seed — the credential slots this platform knows about.
--
--  `in_use` is the honest column. A slot marked FALSE is one an operator may
--  fill today and nothing reads yet, and the dashboard says so — because a
--  settings page that shows a filled box implies the integration is live, and
--  an operator who believes identity checks are running when they are not is
--  worse off than one who knows they are not.
-- ============================================================================

BEGIN;

INSERT INTO provider_credential_slots (provider, name, label, description, env_var, in_use)
VALUES
  ('bitnob', 'api_key', 'Bitnob API key',
   'Authorises every Bitnob call: virtual USD cards, dedicated Nigerian '
   'account numbers, crypto and FX. Replacing it takes effect on the next '
   'request, with no deploy.',
   'BITNOB_API_KEY', TRUE),

  ('bitnob', 'webhook_secret', 'Bitnob webhook secret',
   'Verifies the HMAC-SHA512 signature on every inbound Bitnob webhook, '
   'BEFORE a single byte is parsed. A wrong value here answers 401 to real '
   'events, so a deposit will sit unrecorded rather than be credited twice.',
   'BITNOB_WEBHOOK_SECRET', TRUE),

  ('vtpass', 'api_key',    'VTpass API key',
   'Airtime, data and utility bills.', 'VTPASS_API_KEY', TRUE),
  ('vtpass', 'secret_key', 'VTpass secret key',
   'Paired with the API key on every purchase request.', 'VTPASS_SECRET_KEY', TRUE),
  ('vtpass', 'public_key', 'VTpass public key',
   'Used on the read paths where VTpass does not accept the secret key.',
   'VTPASS_PUBLIC_KEY', TRUE),

  ('airalo', 'client_secret', 'Airalo client secret',
   'Exchanged for a short-lived token, and separately the HMAC-SHA512 key '
   'that signs every body Airalo receives.',
   'AIRALO_CLIENT_SECRET', TRUE),

  ('twilio', 'auth_token', 'Twilio auth token',
   'Virtual numbers. Note that a number is priced by US and not by Twilio: an '
   'instance with no price set cannot sell one whatever this holds.',
   'TWILIO_AUTH_TOKEN', TRUE),

  /**
   * BREVO — the only thing that sends email.
   *
   * A TRANSACTIONAL key (v3, prefixed `xkeysib-`), not a campaign one: every
   * message this platform sends is addressed to one person about their own
   * account and must reach somebody who has unsubscribed from marketing.
   * 033's trigger already refuses a `marketing`-class message to a customer
   * with no live grant, and the point of that rule is that security mail is
   * untouched by it.
   */
  ('brevo', 'api_key', 'Brevo API key',
   'The only thing that sends email. Without it the outbox fills, the API '
   'answers "check your inbox", and nothing is ever delivered. The sender '
   'domain must also be authenticated in Brevo or every send is refused.',
   'BREVO_API_KEY', TRUE),

  /**
   * DOJAH — identity verification.
   *
   * `in_use` is FALSE deliberately, and it is not a placeholder for its own
   * sake. The slots exist so a key can be pasted now and be in the right
   * place when the adapter lands; the flag exists so the dashboard cannot
   * imply that pasting one turned identity checks on.
   *
   * Nothing reads these yet. KYC today is a human review of a submitted BVN
   * and documents — see `009_admin.sql` — and the BVN is checked for
   * uniqueness rather than verified against anything. Wiring Dojah in means
   * an adapter behind a port, with its endpoint table and its auth scheme
   * verified against Dojah's own documentation, because every provider
   * constant in this codebase that was a guess turned out to be wrong.
   */
  ('dojah', 'app_id', 'Dojah app ID',
   'Identifies the Dojah application. Sent alongside the secret key on every '
   'request. NOT YET WIRED: pasting it stores it safely and changes nothing '
   'until the adapter lands.',
   'DOJAH_APP_ID', FALSE),

  ('dojah', 'secret_key', 'Dojah secret key',
   'Authorises Dojah identity lookups — BVN, NIN, document and liveness '
   'checks. NOT YET WIRED: stored sealed, read by nothing until the adapter '
   'lands.',
   'DOJAH_SECRET_KEY', FALSE),

  ('dojah', 'webhook_secret', 'Dojah webhook secret',
   'Will verify asynchronous verification results. Until the adapter exists '
   'there is no endpoint to verify against, and an unverified inbound result '
   'must never be trusted — so this being set is not the same as it being '
   'used.',
   'DOJAH_WEBHOOK_SECRET', FALSE)
ON CONFLICT (provider, name) DO UPDATE
   SET label = EXCLUDED.label,
       description = EXCLUDED.description,
       env_var = EXCLUDED.env_var,
       in_use = EXCLUDED.in_use;

COMMIT;
