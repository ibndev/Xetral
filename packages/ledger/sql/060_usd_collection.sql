-- ===========================================================================
--  060 — A DOLLAR ON THE PAYMENT LINK
--
--  The checkout offers what `provider_routes` says can be COLLECTED, which is
--  the right shape — a hardcoded list in a screen goes stale the first time an
--  operator opens a corridor. 059 seeded naira, cedis and shillings, which is
--  every currency this platform has a COUNTRY in.
--
--  A DOLLAR HAS NO COUNTRY, and that is exactly why it was missed. Every other
--  routing decision here starts from "where is the customer"; the dollar
--  starts from "who is paying them", and the answer is somebody abroad with a
--  card. A payment link that cannot take dollars is a payment link that cannot
--  be paid by most of the world.
--
--  FLUTTERWAVE, BECAUSE IT IS THE RAIL THAT TAKES CARDS ACROSS BORDERS.
--  `FLUTTERWAVE_PAYMENT_OPTIONS` already answers `card` for USD — there is no
--  wallet rail for a dollar, so a card is the only thing a stranger can pay
--  one with.
--
--  IT IS COLLECT ONLY. There is deliberately no `payout` row: paying a dollar
--  OUT means an international transfer to a bank we have not built, and a
--  route naming a rail that cannot perform the operation is worse than no
--  route — it turns a clear refusal into a provider error about something
--  else. `provider_route_coverage` does not report the gap because no country
--  here settles in dollars, which is the true statement.
--
--  AND IT MAY REFUSE, WHICH IS FINE. A Flutterwave account not enabled for USD
--  answers with its own reason, the customer sees `checkout_unavailable`, and
--  an operator moves or removes the row. That is a better failure than a
--  currency nobody can choose.
-- ===========================================================================
BEGIN;

INSERT INTO provider_routes (operation, currency, provider)
VALUES ('collect', 'USD', 'flutterwave')
ON CONFLICT (operation, currency) DO NOTHING;

COMMIT;
