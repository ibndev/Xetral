-- ============================================================================
--  031 — Holds that never became spends.
--
--  WHAT WAS MISSING, AND WHY IT IS THE CARD FAILURE HARDEST TO SEE.
--
--  A Bitnob card spend is TWO events: an authorization, and a settlement up to
--  7-14 business days later. Between them the money sits in `customer_pending`
--  — committed, not yet spent. If the settlement webhook never arrives, that
--  money stays there for ever: the customer cannot spend it, the ledger still
--  balances, `ledger_drift` reports nothing, and every test stays green.
--
--  Nothing anywhere connected the two halves. `card_authorizations` records
--  the first with its entry id; the settlement posted its own entry and
--  matched to nothing. So "which holds are still open, and for how long?" —
--  the one question this flow's whole design turns on — had no answer, and a
--  lost settlement was indistinguishable from a hold that is simply young.
--
--  A SEPARATE TABLE RATHER THAN COLUMNS ON THE AUTHORIZATION. That row records
--  what the duplicate guard saw at the moment of the charge, and a settlement
--  is a different fact learned days later by a different path. Bolting it on
--  would also mean writing to a row 010's guard counts, which is how a
--  redelivered settlement becomes a second authorization for the purpose of
--  freezing a card. The same reasoning `028_risk_cases.sql` gives for
--  attaching signals through a join table.
--
--  A SETTLEMENT MAY DIFFER IN AMOUNT from its authorization, legitimately: a
--  tip added after the card was presented, a currency conversion settled at a
--  different rate. Both figures are recorded so the difference is visible
--  rather than being silently absorbed — an authorization for $10 that settles
--  at $400 is a real event and nothing else would show it.
-- ============================================================================

BEGIN;

CREATE TYPE card_hold_outcome AS ENUM (
    /** The hold became a real spend. */
    'settled',
    /** The hold lapsed and the money returned to the card. */
    'expired'
);

CREATE TABLE card_settlements (
    id               BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

    /** One outcome per hold. A hold cannot both settle and expire, and a
     *  redelivered webhook must not become a second outcome — the ledger's own
     *  idempotency key already makes the posting a replay, and this makes the
     *  record agree. */
    authorization_id BIGINT      NOT NULL REFERENCES card_authorizations(id),

    outcome          card_hold_outcome NOT NULL,
    /** The entry that moved the money out of pending. */
    entry_id         BIGINT      NOT NULL REFERENCES journal_entries(id),

    /** What the settlement was FOR, which is not always what was authorised. */
    amount_minor     BIGINT      NOT NULL CHECK (amount_minor > 0),
    currency         TEXT        NOT NULL,

    occurred_at      TIMESTAMPTZ NOT NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT card_settlements_one_per_hold UNIQUE (authorization_id)
);

CREATE INDEX card_settlements_entry ON card_settlements (entry_id);

/**
 * Append-only. A record of how a hold resolved is what a customer's statement
 * rests on, and the difference between an authorised amount and a settled one
 * is exactly the field somebody would want to tidy away.
 */
CREATE OR REPLACE FUNCTION refuse_card_settlement_change() RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'card_settlements is append-only; % is refused', TG_OP
        USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER card_settlements_append_only
    BEFORE UPDATE OR DELETE ON card_settlements
    FOR EACH ROW EXECUTE FUNCTION refuse_card_settlement_change();

INSERT INTO platform_settings
  (key, value, value_type, min_value, max_value, label, description, category, sensitive)
VALUES
  ('card_hold_window_days', '16', 'integer', 1, 90,
   'A card hold is stale after (days)',
   'Bitnob settles a card authorization up to 7-14 BUSINESS days after it is '
   'made, so this is deliberately longer than fourteen: a hold flagged before '
   'the provider''s own window closes is a false alarm every fortnight, and an '
   'alert people learn to ignore is worse than none. Past this, a hold is '
   'either a lost settlement webhook or an expiry nobody told us about, and '
   'both need a person.',
   'cards', TRUE)
ON CONFLICT (key) DO NOTHING;

/**
 * Holds nobody ever resolved.
 *
 * The money is in `customer_pending`: the customer cannot spend it and the
 * ledger balances perfectly, which is why nothing else reports this. Ordered
 * oldest first, because age is the whole signal.
 */
CREATE VIEW card_holds_stuck AS
SELECT a.id                    AS authorization_id,
       c.uuid                  AS card_id,
       c.user_id,
       u.email,
       c.last4,
       a.provider_txn_id,
       a.merchant_label,
       a.amount_minor,
       a.currency,
       a.occurred_at,
       extract(day FROM now() - a.occurred_at)::INT AS age_days,
       e.uuid                  AS entry_id
  FROM card_authorizations a
  JOIN cards c           ON c.id = a.card_id
  JOIN users u           ON u.id = c.user_id
  JOIN journal_entries e ON e.id = a.entry_id
  LEFT JOIN card_settlements s ON s.authorization_id = a.id
 WHERE s.authorization_id IS NULL
   AND a.occurred_at < now() - make_interval(days => (
         SELECT value::INT FROM platform_settings WHERE key = 'card_hold_window_days'
       ))
 ORDER BY a.occurred_at;

/**
 * Settlements that did not match what was authorised.
 *
 * A tip added after the card was presented is a few percent; a settlement many
 * times the authorisation is a merchant error or a compromised terminal, and
 * before this nothing anywhere compared the two.
 */
CREATE VIEW card_settlement_differences AS
SELECT s.id,
       c.uuid           AS card_id,
       u.email,
       a.merchant_label,
       a.amount_minor   AS authorised_minor,
       s.amount_minor   AS settled_minor,
       s.currency,
       s.occurred_at
  FROM card_settlements s
  JOIN card_authorizations a ON a.id = s.authorization_id
  JOIN cards c ON c.id = a.card_id
  JOIN users u ON u.id = c.user_id
 WHERE s.outcome = 'settled' AND s.amount_minor <> a.amount_minor
 ORDER BY s.occurred_at DESC;

INSERT INTO retention_decisions (table_name, decision, rationale) VALUES
  ('card_settlements', 'keep',
   'How each card hold resolved, and for how much. A customer''s statement '
   'rests on this, and the gap between an authorised and a settled amount is '
   'exactly the field somebody would want to tidy away.')
ON CONFLICT (table_name) DO NOTHING;

COMMIT;
