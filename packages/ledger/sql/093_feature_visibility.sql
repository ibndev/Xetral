-- ============================================================================
--  093 — what a switched-off service looks like: "Coming soon" or HIDDEN
--
--  A KILL SWITCH HAD TWO STATES AND THE PRODUCT NEEDED THREE. Off meant the
--  service stayed on every screen under "Coming soon" — right for a pause
--  during an incident, and wrong for a product that is not launched in this
--  market at all, where the honest screen is one that never mentions it.
--
--  `<service>_enabled` IS UNTOUCHED AND STILL DECIDES ON OR OFF. Every refusal
--  in the API reads it, and every existing deployment keeps exactly the state
--  it has. What this adds is one row per service saying what OFF means:
--
--     enabled = true                       Enabled
--     enabled = false, when_off = coming_soon   Coming soon   (the default)
--     enabled = false, when_off = hidden        Hidden
--
--  TWO ROWS RATHER THAN ONE THREE-VALUED ROW, so no combination is incoherent:
--  `when_off` is a statement about the off state and is simply not read while
--  the service is on. Every state the admin control can pass through on its
--  way between two others is itself one of the three.
--
--  THE VALUE IS CHECKED HERE, NOT IN A FORM. `platform_settings` validates a
--  boolean and an integer by trigger and takes any text; a typo in this row
--  would otherwise read as "not hidden" — which shows a product somebody meant
--  to remove.
-- ============================================================================

BEGIN;

INSERT INTO platform_settings (key, value, value_type, min_value, max_value, label, description, category, sensitive)
VALUES
  ('crypto_when_off', 'coming_soon', 'text', NULL, NULL,
   'Crypto, when switched off',
   'coming_soon keeps crypto on every screen marked Coming soon; hidden removes '
   'it from the apps entirely and refuses its customer endpoints. Read only '
   'while crypto_enabled is off.',
   'features', TRUE),
  ('fx_when_off', 'coming_soon', 'text', NULL, NULL,
   'Currency conversion, when switched off',
   'coming_soon keeps Convert on every screen marked Coming soon; hidden removes '
   'it from the apps entirely and refuses its customer endpoints. Read only '
   'while fx_enabled is off.',
   'features', TRUE),
  ('cards_when_off', 'coming_soon', 'text', NULL, NULL,
   'USD cards, when switched off',
   'coming_soon keeps cards on every screen marked Coming soon; hidden removes '
   'them from the apps entirely and refuses their customer endpoints. Read only '
   'while cards_enabled is off.',
   'features', TRUE),
  ('bills_when_off', 'coming_soon', 'text', NULL, NULL,
   'Bills and eSIM, when switched off',
   'coming_soon keeps bills and eSIM on every screen marked Coming soon; hidden '
   'removes them from the apps entirely and refuses their customer endpoints. '
   'Read only while bills_enabled is off.',
   'features', TRUE),
  ('payouts_when_off', 'coming_soon', 'text', NULL, NULL,
   'Bank and mobile money payouts, when switched off',
   'coming_soon keeps payouts offered and marked Coming soon; hidden removes '
   'them from the apps entirely and refuses their customer endpoints. Read only '
   'while payouts_enabled is off.',
   'features', TRUE)
ON CONFLICT (key) DO NOTHING;

ALTER TABLE platform_settings DROP CONSTRAINT IF EXISTS feature_off_state_is_known;
ALTER TABLE platform_settings ADD CONSTRAINT feature_off_state_is_known CHECK (
    key NOT IN ('crypto_when_off', 'fx_when_off', 'cards_when_off', 'bills_when_off', 'payouts_when_off')
    OR value IN ('coming_soon', 'hidden')
);

COMMIT;
