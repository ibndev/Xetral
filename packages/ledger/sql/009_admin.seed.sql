-- ===========================================================================
--  Default platform settings.
--
--  Idempotent, so it can be re-run after adding a setting without resetting
--  values an operator has since changed. The DEFAULTS ARE THE SAFE DIRECTION
--  in every case: fees at zero, the fraud surface off, limits low enough that
--  an unconfigured instance refuses rather than over-serves.
-- ===========================================================================

INSERT INTO platform_settings
  (key, value, value_type, min_value, max_value, label, description, category, sensitive)
VALUES
  -- ---- Fees --------------------------------------------------------------
  ('transfer_fee_basis_points', '0', 'integer', 0, 500,
   'Transfer fee (basis points)',
   'Charged on wallet-to-wallet transfers. 150 = 1.5%. Capped at 5% so a '
   'mistyped value cannot take a fifth of every transfer.',
   'fees', TRUE),

  -- ---- Limits ------------------------------------------------------------
  ('deposit_ceiling_kobo', '100000000', 'integer', 100000, 100000000000,
   'Automatic deposit ceiling (kobo)',
   'Deposits above this are held in suspense for review instead of credited. '
   'This is what makes a misread amount recoverable rather than spent.',
   'limits', TRUE),

  ('transfer_daily_limit_kobo', '500000000', 'integer', 100000, 10000000000,
   'Daily transfer limit per customer (kobo)',
   'The most one customer can send in 24 hours. Caps what a stolen session '
   'can move before anyone notices.',
   'limits', TRUE),

  ('purchase_daily_limit_kobo', '20000000', 'integer', 100000, 10000000000,
   'Daily purchase limit per customer (kobo)',
   'Airtime, data, bills, eSIMs and numbers combined, per 24 hours.',
   'limits', TRUE),

  -- ---- Features ----------------------------------------------------------
  ('gift_cards_enabled', 'false', 'boolean', NULL, NULL,
   'Gift card trading',
   'Buying gift cards FROM customers. The highest-fraud surface in the '
   'product; every payout is approved by a human and held before release.',
   'features', TRUE),

  ('crypto_enabled', 'true', 'boolean', NULL, NULL,
   'Crypto deposits and withdrawals',
   'On-chain USDT and BTC. Withdrawals are irreversible once broadcast.',
   'features', TRUE),

  ('fx_enabled', 'true', 'boolean', NULL, NULL,
   'Currency conversion and remittance',
   'Converting between wallet currencies, and sending across them.',
   'features', TRUE),

  ('registration_enabled', 'true', 'boolean', NULL, NULL,
   'New account registration',
   'Turn off to stop new sign-ups without taking the platform down — useful '
   'during an incident or an abuse wave.',
   'features', FALSE),

  -- ---- Gift cards --------------------------------------------------------
  ('giftcard_hold_days', '3', 'integer', 1, 30,
   'Gift card hold period (days)',
   'How long an approved payout stays unspendable. This window is what makes '
   'a clawback recoverable rather than a loss.',
   'giftcards', TRUE),

  -- ---- Operations --------------------------------------------------------
  ('reconcile_stale_hours', '24', 'integer', 1, 168,
   'Escalate held purchases after (hours)',
   'A purchase still unresolved after this is escalated to a person. It is '
   'never auto-reversed: by then both remaining answers can be wrong.',
   'operations', FALSE),

  ('support_email', 'support@xetral.com', 'text', NULL, NULL,
   'Support email',
   'Shown to customers on error screens and in receipts.',
   'operations', FALSE),

  -- ---- Card protection ---------------------------------------------------
  -- These are the numbers a fraud analyst tunes during an incident, which is
  -- exactly why they are rows and not constants: tightening a window at 2am
  -- must not be a deploy.
  ('card_duplicate_window_seconds', '90', 'integer', 0, 3600,
   'Duplicate charge window (seconds)',
   'Two charges from the same merchant for the same amount inside this window '
   'are treated as a double charge. 0 turns the check off. Wider catches more '
   'and starts calling a genuine second purchase a duplicate.',
   'cards', TRUE),

  ('card_freeze_on_duplicate', 'true', 'boolean', NULL, NULL,
   'Freeze a card on a duplicate charge',
   'The charge itself cannot be blocked — it has already been approved by the '
   'network when we hear about it. Freezing stops the THIRD one, which is the '
   'only one still preventable.',
   'cards', TRUE),

  ('card_freeze_on_insufficient_funds', 'true', 'boolean', NULL, NULL,
   'Freeze a card on the first insufficient-funds decline',
   'A subscription that fails once retries on a schedule. Left alone it runs '
   'the customer through a week of declines and any per-attempt fee the '
   'merchant charges, and repeated declines are themselves a fraud signal to '
   'the network.',
   'cards', TRUE),

  ('card_decline_burst_threshold', '4', 'integer', 0, 50,
   'Freeze after this many declines in an hour',
   'A burst of declines on one card is what card testing looks like: someone '
   'is trying amounts against a stolen PAN. 0 turns the check off.',
   'cards', TRUE),

  ('card_daily_spend_limit_cents', '200000', 'integer', 0, 100000000,
   'Daily spend limit per card (US cents)',
   'Caps what a leaked card number can spend in a day. 0 means no limit, and '
   'no limit means one leaked card is worth its whole balance.',
   'cards', TRUE),

  ('card_hourly_authorization_limit', '25', 'integer', 0, 1000,
   'Authorizations per card per hour',
   'A velocity cap. Ordinary use is a handful an hour; scripted use is not. '
   '0 turns the check off.',
   'cards', TRUE)

ON CONFLICT (key) DO UPDATE SET
  -- Refresh the presentation and the bounds, never the VALUE. Re-running this
  -- after a deploy must not silently undo a change an operator made.
  label       = EXCLUDED.label,
  description = EXCLUDED.description,
  category    = EXCLUDED.category,
  min_value   = EXCLUDED.min_value,
  max_value   = EXCLUDED.max_value,
  sensitive   = EXCLUDED.sensitive;
