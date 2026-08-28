-- ============================================================================
--  017 — Velocity limits for transfers.
--
--  WHAT WAS MISSING, AND WHY IT IS NOT THE DAILY LIMIT AGAIN.
--
--  A card spend has had two protections since Phase 12: a duplicate check and
--  an automatic freeze on the second suspicious authorization. A transfer has
--  had exactly one — a daily total in kobo — and a total is blind to the shape
--  of what is happening. An account takeover does not look like one large
--  transfer; it looks like several ordinary ones, to people this customer has
--  never paid, in the space of a few minutes. Every one of them fits under the
--  ceiling, and the ceiling is reached only when the account is empty.
--
--  So two rules, and both are about COUNT rather than amount:
--
--    * how many people this customer has never paid before they are paying
--      today, and
--    * how many transfers they have sent in the last hour.
--
--  THE RESPONSE IS A REFUSAL, NOT A FREEZE, and that is the difference from
--  the card protections rather than an inconsistency with them. A card
--  authorization is a NOTIFICATION: the network approved the charge before we
--  heard, so the only thing left to protect is the next one, and freezing is
--  the lever. A transfer has not happened yet when this runs. We are on the
--  right side of the event, so the correct action is to not do it — and
--  freezing an account over a velocity rule would turn a fraud control into a
--  seizure of a customer's own money, which `009_admin.sql` is careful to keep
--  separate.
--
--  BOTH RULES APPLY IN EVERY CURRENCY, unlike the daily kobo ceiling. That
--  limit is published in kobo and is therefore a statement about naira alone —
--  applying it to USDT because both are integers is the same mistake as adding
--  kobo to cents. A COUNT carries no units, so there is nothing to mis-apply,
--  and a drain denominated in USDT is a drain.
-- ============================================================================

-- The customer needs telling when this fires: a refusal they did not cause is
-- the first evidence they will get that somebody else is in their account.
-- Outside a transaction, and unusable in the same one — the same rule
-- 013_password_reset.sql and 015_error_events.sql both record.
ALTER TYPE notification_kind ADD VALUE IF NOT EXISTS 'transfer_blocked';
BEGIN;

INSERT INTO platform_settings
  (key, value, value_type, min_value, max_value, label, description, category, sensitive)
VALUES
  -- The signature of a drain. A customer paying a landlord, a school and a
  -- vendor on the same morning is three; a stolen session walking through a
  -- list of mule accounts is however many it can reach before the balance runs
  -- out. The bound is deliberately low at the bottom — an operator narrowing
  -- this during an incident is the intended use.
  ('transfer_new_recipients_daily', '10', 'integer', 1, 100,
   'New recipients per customer per day',
   'How many people a customer may pay for the FIRST time in one Lagos day. '
   'Paying someone already paid before does not count. This is the control '
   'that sees an account takeover, which looks like several ordinary '
   'transfers to strangers rather than one large one.',
   'limits', TRUE),

  ('transfer_count_hourly', '20', 'integer', 1, 500,
   'Transfers per customer per hour',
   'How many transfers one customer may send in a rolling hour, in any '
   'currency. Catches a scripted drain that stays under the daily total and '
   'pays only people the customer has paid before.',
   'limits', TRUE)
ON CONFLICT (key) DO NOTHING;

COMMIT;
