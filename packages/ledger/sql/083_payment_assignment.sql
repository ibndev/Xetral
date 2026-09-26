-- ============================================================================
--  083 — who carries which money, as the payment architecture now states it
--
--  THE PRODUCT OWNER'S ASSIGNMENT (September 2026), per role and per
--  corridor, applied to the route table 059 built and 076 widened:
--
--    account   NGN  paystack      Bitnob's naira account needs a full BVN, so
--                                 it cannot be the no-KYC tier 1 rail.
--    payout    NGN  paystack      a Nigerian bank list from a Nigerian rail.
--    collect   GHS  flutterwave
--    payout    GHS  flutterwave
--    payout    KES  bitnob        M-Pesa, KSh 150–100,000 per transaction —
--                                 declared on the adapter, enforced before
--                                 anything is held (`PayoutPort.limits`).
--    collect   KES  (none)        NO CONFIRMED PROVIDER. Left unrouted, so a
--                                 Kenyan checkout is refused with a code the
--                                 screen turns into words, and
--                                 `provider_route_coverage` shows UNROUTED
--                                 until one is confirmed and routed.
--
--  THE ACCOUNT ROW IS THE ONE CUSTOMERS WERE FEELING. 076 pointed naira
--  account numbers at Flutterwave, which opens a permanent account only with
--  a BVN — so every unverified Nigerian was refused there first and the
--  answer they read was whatever the fallback said. Paystack first is the
--  rail that opens a tier 1 account from a name.
--
--  A REMOVED ROUTE IS NOW HISTORY TOO. 059's trigger recorded an INSERT and an
--  UPDATE and nothing else, so a corridor switched OFF left no trace of who
--  did it or when — the one change most likely to be asked about. `now_is`
--  becomes nullable, and NULL means "routed nowhere".
--
--  RE-RUNNING THIS RE-APPLIES THE ASSIGNMENT. Migrations here are applied
--  once, by hand; an operator moving a corridor on `/admin/providers`
--  afterwards is the normal path, and is recorded against their name.
-- ============================================================================
BEGIN;

ALTER TABLE provider_route_history ALTER COLUMN now_is DROP NOT NULL;

CREATE OR REPLACE FUNCTION record_route_change()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        INSERT INTO provider_route_history (operation, currency, was, now_is, changed_by)
        VALUES (OLD.operation, OLD.currency, OLD.provider, NULL, NULL);
        RETURN OLD;
    END IF;

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
    AFTER INSERT OR UPDATE OR DELETE ON provider_routes
    FOR EACH ROW EXECUTE FUNCTION record_route_change();

INSERT INTO provider_routes (operation, currency, provider, updated_by)
VALUES ('account', 'NGN', 'paystack',    NULL),
       ('payout',  'NGN', 'paystack',    NULL),
       ('collect', 'GHS', 'flutterwave', NULL),
       ('payout',  'GHS', 'flutterwave', NULL),
       ('payout',  'KES', 'bitnob',      NULL)
ON CONFLICT (operation, currency) DO UPDATE
   SET provider   = EXCLUDED.provider,
       updated_by = NULL,
       updated_at = now()
 WHERE provider_routes.provider IS DISTINCT FROM EXCLUDED.provider;

DELETE FROM provider_routes WHERE operation = 'collect' AND currency = 'KES';

/*
 * AND OUT OF COVERAGE, or `by_coverage` would put it straight back. Coverage
 * says what this platform can use, and a Flutterwave M-Pesa charge is not
 * something it can use while the Kenyan registration is unresolved. When a
 * provider is confirmed, a migration adds its row with the evidence — 079's
 * rule that coverage is widened by migration, never from a form.
 */
DELETE FROM provider_coverage WHERE operation = 'collect' AND currency = 'KES';

COMMIT;
