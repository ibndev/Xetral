-- ============================================================================
--  078 — Which wallets pay for a card, and the record of what each paid.
--
--  WHAT BITNOB DOES AND DOES NOT DO, which decides where this lives. A Bitnob
--  virtual card is a prepaid USD card. Every authorization is approved against
--  the CARD'S OWN balance by the network before we hear of it — a card at $0
--  declines even while the customer's wallets hold money, and four
--  insufficient-funds declines in a row cost a penalty and terminate the card.
--  Bitnob converts nothing at the moment of a spend and offers no request we
--  can answer to fund one. So the cascade is OURS, and it runs where money can
--  still be chosen: on its way ONTO the card.
--
--  1. A BASE CURRENCY PER CARD, set once. After the card's own currency it is
--     the first wallet a top-up draws on. NULL means "the customer's home
--     currency", read at the time — so an account that has never chosen one
--     follows its country rather than whatever was true the day the card was
--     issued. Named from the money registry's shape, never invented here.
--
--  2. THE PLAN IS WRITTEN BEFORE ANYTHING MOVES. A top-up converts one or more
--     wallets into dollars and then moves dollars onto the card; a retry must
--     run THE SAME PLAN, not a new one computed against balances the first
--     attempt already changed. So the plan's legs are rows keyed by the
--     attempt, inserted ON CONFLICT DO NOTHING, and the executor reads them
--     back. A retry replays each conversion (fx_trades is unique per customer
--     key) and the top-up (the ledger answers `replayed`).
--
--  3. APPEND-ONLY. A plan is a statement about what was decided at a moment;
--     changing one after the fact would make the record of which wallet paid
--     for a card say something the conversions never did.
--
--  4. THE VIEW JOINS THE PLAN TO WHAT HAPPENED: the conversion that executed
--     (with the rate actually applied, which a provider fill can move) and the
--     top-up entry. A plan whose conversion never happened shows a NULL trade,
--     which is the honest state of an attempt that stopped half way — the
--     money is in the customer's own dollar wallet, not lost.
-- ============================================================================
BEGIN;

ALTER TABLE cards
    ADD COLUMN IF NOT EXISTS base_currency TEXT NULL;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'cards_base_currency_shape'
    ) THEN
        ALTER TABLE cards
            ADD CONSTRAINT cards_base_currency_shape
            CHECK (base_currency IS NULL OR base_currency ~ '^[A-Z]{3,5}$');
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS card_topup_sources (
    id                  BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    card_id             BIGINT      NOT NULL REFERENCES cards(id),
    user_id             BIGINT      NOT NULL REFERENCES users(id),
    -- The customer's idempotency key for the top-up attempt. The top-up entry
    -- is `card-fund:<key>` and each conversion `card-fx:<key>:<currency>`.
    topup_key           TEXT        NOT NULL CHECK (length(topup_key) BETWEEN 1 AND 200),
    seq                 SMALLINT    NOT NULL CHECK (seq >= 0),
    currency            TEXT        NOT NULL CHECK (currency ~ '^[A-Z]{3,5}$'),
    target_currency     TEXT        NOT NULL CHECK (target_currency ~ '^[A-Z]{3,5}$'),
    debit_minor         BIGINT      NOT NULL CHECK (debit_minor > 0),
    delivers_minor      BIGINT      NOT NULL CHECK (delivers_minor > 0),
    converted           BOOLEAN     NOT NULL,
    spread_basis_points INTEGER     NOT NULL CHECK (spread_basis_points BETWEEN 0 AND 10000),
    -- The rate the PLAN applied, spread included. The executed trade's own
    -- rate is on fx_trades and the view shows both.
    applied_numerator   BIGINT      NOT NULL CHECK (applied_numerator > 0),
    applied_denominator BIGINT      NOT NULL CHECK (applied_denominator > 0),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT card_topup_sources_seq_key UNIQUE (card_id, topup_key, seq),
    CONSTRAINT card_topup_sources_currency_key UNIQUE (card_id, topup_key, currency),
    -- A leg in the card's own currency converts nothing and is charged
    -- nothing: no fee for the cascade deciding, only for a conversion.
    CONSTRAINT card_topup_leg_shape CHECK (
        (converted AND currency <> target_currency)
        OR (NOT converted AND currency = target_currency
            AND debit_minor = delivers_minor AND spread_basis_points = 0)
    )
);

CREATE INDEX IF NOT EXISTS card_topup_sources_card_idx ON card_topup_sources (card_id, created_at DESC);

CREATE OR REPLACE FUNCTION card_topup_sources_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'card_topup_sources is append-only: a funding plan records a decision already taken';
END $$;

DROP TRIGGER IF EXISTS card_topup_sources_append_only ON card_topup_sources;
CREATE TRIGGER card_topup_sources_append_only
    BEFORE UPDATE OR DELETE ON card_topup_sources
    FOR EACH ROW EXECUTE FUNCTION card_topup_sources_append_only();

CREATE OR REPLACE VIEW card_topup_funding AS
SELECT s.card_id,
       c.uuid                          AS card_uuid,
       s.user_id,
       s.topup_key,
       s.seq,
       s.currency,
       s.target_currency,
       s.debit_minor,
       s.delivers_minor,
       s.converted,
       s.spread_basis_points,
       s.applied_numerator             AS planned_numerator,
       s.applied_denominator           AS planned_denominator,
       t.uuid                          AS fx_trade_uuid,
       t.base_minor                    AS traded_minor,
       t.quote_minor                   AS received_minor,
       t.rate_numerator                AS executed_numerator,
       t.rate_denominator              AS executed_denominator,
       e.uuid                          AS topup_entry_uuid,
       s.created_at
  FROM card_topup_sources s
  JOIN cards c ON c.id = s.card_id
  LEFT JOIN fx_trades t
         ON s.converted
        AND t.user_id = s.user_id
        AND t.idempotency_key = 'card-fx:' || s.topup_key || ':' || s.currency
  LEFT JOIN journal_entries e
         ON e.idempotency_key = 'card-fund:' || s.topup_key;

INSERT INTO retention_decisions (table_name, decision, rationale)
VALUES (
    'card_topup_sources',
    'keep',
    'Part of the financial record: which of a customer''s wallets paid for a '
    'card top-up and at what rate. It explains postings that are kept, so it '
    'is kept on the same terms as the ledger it describes.'
)
ON CONFLICT (table_name) DO NOTHING;

INSERT INTO attention_sources (source, decision, rationale) VALUES
  ('card_topup_funding', 'internal',
   'What a card receipt and a support agent read: the wallets a top-up drew '
   'on and the rate each was converted at. Every row is a normal state — '
   'nothing here is waiting for a person.')
ON CONFLICT (source) DO NOTHING;

COMMIT;
