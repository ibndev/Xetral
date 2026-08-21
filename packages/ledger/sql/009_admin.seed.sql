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

  ('support_email', 'support@xetral.ng', 'text', NULL, NULL,
   'Support email',
   'Shown to customers on error screens and in receipts.',
   'operations', FALSE)

ON CONFLICT (key) DO UPDATE SET
  -- Refresh the presentation and the bounds, never the VALUE. Re-running this
  -- after a deploy must not silently undo a change an operator made.
  label       = EXCLUDED.label,
  description = EXCLUDED.description,
  category    = EXCLUDED.category,
  min_value   = EXCLUDED.min_value,
  max_value   = EXCLUDED.max_value,
  sensitive   = EXCLUDED.sensitive;
