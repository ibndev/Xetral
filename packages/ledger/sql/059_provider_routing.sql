-- ===========================================================================
--  059 — WHICH PROVIDER SERVES WHICH CURRENCY
--
--  `funding_provider` and `payout_provider` are ONE NAME EACH, and that is
--  the whole problem this migration exists for. They can say "Paystack" or
--  "Bitnob"; they cannot say "Paystack for naira and somebody else for
--  cedis", which is the only sentence that describes a platform operating in
--  three countries.
--
--  WHAT THAT COST, EXACTLY. Add Money in Accra offers mobile money, which is
--  a Paystack charge in GHS. A Paystack account registered in Nigeria settles
--  in naira: it either refuses the currency outright or accepts it and
--  converts, so the customer is charged cedis and the platform is credited
--  naira at a rate nobody chose. The screen said "Payments are unavailable
--  right now" and nothing anywhere could say which of those two had happened.
--
--  SO THE ROUTE IS DATA, per operation AND per currency.
--
--  A SETTING WOULD NOT HAVE DONE. `platform_settings` is a key and a string,
--  so expressing this in it means either one row per pair with a naming
--  convention parsed at read time — a table with extra steps, and one no
--  CHECK can constrain — or a JSON blob, which is a table nothing can index.
--  A route has a shape: two dimensions, a known set of operations, a currency
--  the money registry recognises. That is a table.
--
--  IT IS EDITABLE AND IT IS NOT A DEPLOY, for the reason 009 gives about
--  every operational decision: the moment you want to move a corridor onto
--  another rail is the moment that rail is having a bad afternoon, and a
--  release is the slowest possible response to one.
--
--  IT IS NOT A KILL SWITCH. Routing names WHO serves a currency, never
--  WHETHER it is served — the four switches in 009 do that, they are separate
--  on purpose, and an operator turning a flow off must not have to know which
--  rail it was on.
--
--  A ROUTE IS NOT A HISTORY. What served a given payment is recorded on the
--  payment (`bank_payouts.provider` since 046, `virtual_accounts.provider`
--  since 044, `link_payments.provider` here), because a provider-side id is
--  opaque and only its issuer can resolve it. Reading the rail off this table
--  when settling would make every payment in flight unresolvable the instant
--  an operator changed a row.
-- ===========================================================================
BEGIN;

-- ---------------------------------------------------------------------------
--  The routes.
--
--  `operation` is deliberately a small closed set rather than free text: a
--  row naming an operation nothing dispatches on is a route an operator
--  believes is in force. `collect` is money coming in (a checkout, a mobile
--  money charge, a dedicated account); `payout` is money going out to a bank
--  or a wallet.
--
--  CARD ISSUANCE IS ABSENT, deliberately. It is Bitnob's and there is no
--  second implementation to route to, so a row for it would be a choice that
--  does not exist — and the first operator to change it would silently break
--  every card on the platform.
--
--  The currency is TEXT rather than a foreign key because the money registry
--  is a TypeScript union, not a table: 040's argument is that a currency
--  invented at runtime has no exponent, no tier ceiling and nothing watching
--  it. `provider_routes_currency_known` is what keeps this table honest
--  against the accounts that actually exist.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS provider_routes (
    operation   TEXT NOT NULL CHECK (operation IN ('collect', 'payout')),
    currency    TEXT NOT NULL CHECK (currency ~ '^[A-Z]{3,4}$'),
    provider    TEXT NOT NULL CHECK (provider <> ''),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    /* Null for the seeded rows, which no person chose — the same shape, and
     * the same reason, as `fx_published_rates.created_by`. */
    updated_by  BIGINT REFERENCES users(id),
    PRIMARY KEY (operation, currency)
);

COMMENT ON TABLE provider_routes IS
  'Which provider serves which currency, per operation. Read per call with a '
  'few seconds of cache. Names WHO, never WHETHER — the kill switches in 009 '
  'decide whether, and are deliberately separate.';

-- ---------------------------------------------------------------------------
--  Every change is recorded, and the record cannot be edited.
--
--  Same argument as `platform_settings_history`: a route decides where a
--  customer's money goes, so "who pointed this at that, and when" is a
--  question somebody will ask after an incident. A log the person with access
--  can rewrite answers it with whatever they would like to have been true.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS provider_route_history (
    id          BIGSERIAL PRIMARY KEY,
    operation   TEXT NOT NULL,
    currency    TEXT NOT NULL,
    was         TEXT,
    now_is      TEXT NOT NULL,
    changed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    changed_by  BIGINT REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS provider_route_history_recent
    ON provider_route_history (operation, currency, changed_at DESC);

CREATE OR REPLACE FUNCTION assert_route_history_append_only()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'provider_route_history is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS provider_route_history_immutable ON provider_route_history;
CREATE TRIGGER provider_route_history_immutable
    BEFORE UPDATE OR DELETE ON provider_route_history
    FOR EACH ROW EXECUTE FUNCTION assert_route_history_append_only();

-- ---------------------------------------------------------------------------
--  The history is written BY TRIGGER, not by the endpoint.
--
--  026's lesson about the credential rotation log: a write the endpoint
--  performs is a write a psql prompt skips, and the prompt is exactly where
--  somebody goes at three in the morning. On the table, it cannot be.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION record_route_change()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'UPDATE' AND OLD.provider = NEW.provider THEN
        RETURN NEW;
    END IF;

    INSERT INTO provider_route_history (operation, currency, was, now_is, changed_by)
    VALUES (NEW.operation, NEW.currency,
            CASE WHEN TG_OP = 'UPDATE' THEN OLD.provider ELSE NULL END,
            NEW.provider, NEW.updated_by);
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS provider_routes_recorded ON provider_routes;
CREATE TRIGGER provider_routes_recorded
    AFTER INSERT OR UPDATE ON provider_routes
    FOR EACH ROW EXECUTE FUNCTION record_route_change();

-- ---------------------------------------------------------------------------
--  WHICH PAYMENT WAS SERVED BY WHOM.
--
--  `link_payments` predates any second collection rail, so every row it holds
--  was Paystack's — which is why the default is `paystack` rather than NULL.
--  It is immutable once written for the reason `bank_payouts.provider` is: a
--  provider-side reference is opaque and only its issuer can verify it, so a
--  row whose provider could change is a payment nothing can settle.
-- ---------------------------------------------------------------------------
ALTER TABLE link_payments
    ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'paystack';

CREATE OR REPLACE FUNCTION assert_link_payment_provider_immutable()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.provider IS DISTINCT FROM OLD.provider THEN
        RAISE EXCEPTION 'a payment cannot change provider: % -> %',
            OLD.provider, NEW.provider;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS link_payments_provider_immutable ON link_payments;
CREATE TRIGGER link_payments_provider_immutable
    BEFORE UPDATE ON link_payments
    FOR EACH ROW EXECUTE FUNCTION assert_link_payment_provider_immutable();

-- ---------------------------------------------------------------------------
--  The credential slots.
--
--  ONE SECRET AND ONE HASH, and they are different things — unlike Paystack,
--  where the one secret key both authorises calls and verifies webhooks.
--  Flutterwave signs an inbound event with a SEPARATE value an operator sets
--  on their dashboard, so a deployment holding only the secret key would
--  authorise every outbound call correctly and reject every webhook, which
--  from inside reads as a broken integration rather than a missing box.
--
--  The public key is deliberately absent: it belongs to their inline
--  JavaScript widget, and this checkout is a hosted redirect. A slot for it
--  would be a box an operator fills with a value nothing reads — the state
--  026 records `in_use = FALSE` for.
-- ---------------------------------------------------------------------------
INSERT INTO provider_credential_slots
  (provider, name, label, description, env_var, in_use)
VALUES
  ('flutterwave', 'secret_key', 'Flutterwave secret key',
   'Authorises every Flutterwave call — the hosted checkout that collects '
   'cedis and shillings, and the transfers that pay a mobile money wallet. '
   'Starts FLWSECK. Without it those corridors have no rail and the route '
   'table says so.',
   'FLUTTERWAVE_SECRET_KEY', TRUE),
  ('flutterwave', 'webhook_hash', 'Flutterwave webhook hash',
   'The secret hash you set on Flutterwave''s webhook settings page. It is '
   'NOT the secret key: they send it verbatim in the verif-hash header, and '
   'a deployment holding only the key authorises every outbound call and '
   'rejects every inbound event.',
   'FLUTTERWAVE_WEBHOOK_HASH', TRUE)
ON CONFLICT (provider, name) DO UPDATE
   SET label       = EXCLUDED.label,
       description = EXCLUDED.description,
       env_var     = EXCLUDED.env_var,
       in_use      = EXCLUDED.in_use;

-- ---------------------------------------------------------------------------
--  The seed.
--
--  NIGERIA IS UNCHANGED, and that is the point of naming it here rather than
--  leaving it to a fallback: naira collection and naira payouts are the only
--  corridors on this platform that have ever worked, and a migration that
--  moved them would be a migration that broke the working half to fix the
--  broken one.
--
--  Cedis and shillings go to Flutterwave because the failure they are fixing
--  is a Paystack account registered in Nigeria being asked to settle GHS.
--
--  THE STABLECOINS AND THE DOLLAR ARE ABSENT, deliberately. They are Bitnob's
--  and they do not move on either of these rails — an unrouted currency is
--  refused by the router with a reason, which is the correct answer for a
--  corridor nobody has opened, and far better than a default that quietly
--  sends dollars somewhere that cannot take them.
-- ---------------------------------------------------------------------------
INSERT INTO provider_routes (operation, currency, provider)
VALUES
  ('collect', 'NGN', 'paystack'),
  ('collect', 'GHS', 'flutterwave'),
  ('collect', 'KES', 'flutterwave'),
  ('payout',  'NGN', 'paystack'),
  ('payout',  'GHS', 'flutterwave'),
  ('payout',  'KES', 'flutterwave')
ON CONFLICT (operation, currency) DO NOTHING;

-- ---------------------------------------------------------------------------
--  What an operator reads.
--
--  Both directions, the shape every coverage view in this schema takes:
--  a corridor the platform OPERATES IN with no route is a currency whose
--  customers will be refused, and a route naming a provider no adapter
--  implements is a row an operator believes is in force.
--
--  It is driven off `countries`, not off `accounts`: a country being open is
--  the decision that creates the obligation, and it is true before the first
--  customer there has signed up. Waiting for an account would mean the gap
--  becomes visible only once somebody is already standing in it.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW provider_route_coverage AS
WITH operating AS (
    SELECT DISTINCT currency FROM countries WHERE enabled
),
wanted AS (
    SELECT o.operation, c.currency
      FROM operating c
     CROSS JOIN (VALUES ('collect'), ('payout')) AS o(operation)
)
SELECT w.operation,
       w.currency,
       r.provider,
       CASE WHEN r.provider IS NULL THEN 'UNROUTED' ELSE 'ok' END AS status
  FROM wanted w
  LEFT JOIN provider_routes r
    ON r.operation = w.operation AND r.currency = w.currency;

COMMENT ON VIEW provider_route_coverage IS
  'Every currency the platform is open in, against the provider that serves '
  'it. An UNROUTED row is a corridor whose customers are refused with no '
  'error anywhere — the state cedis were in before this migration.';

INSERT INTO attention_sources (source, decision, queue_name, rationale)
VALUES
  ('provider_route_coverage', 'watch', NULL,
   'A currency the platform is open in with no provider routed to it. Nothing '
   'errors: customers are simply refused, which reads as their own problem.')
ON CONFLICT (source) DO UPDATE
   SET decision = EXCLUDED.decision,
       queue_name = EXCLUDED.queue_name,
       rationale = EXCLUDED.rationale;

INSERT INTO retention_decisions (table_name, decision, rationale)
VALUES
  ('provider_routes', 'keep',
   'Operational configuration, not personal data. Which rail served a '
   'corridor is part of reconstructing any payment made through it.'),
  ('provider_route_history', 'keep',
   'Who pointed a currency at which provider, and when. The question asked '
   'after an incident, so it outlives the incident.')
ON CONFLICT (table_name) DO UPDATE
   SET decision = EXCLUDED.decision,
       rationale = EXCLUDED.rationale;

COMMIT;
