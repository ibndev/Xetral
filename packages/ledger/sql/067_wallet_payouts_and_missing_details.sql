-- 067: A WALLET HAS NO NAME, AND A VERIFIED CUSTOMER'S OWN DETAILS WERE BLANK.
--
-- Two repairs, both of which had the same shape: a rule written for one rail
-- applied to a rail it was never true of, and a record held in one table while
-- a screen read another.
--
-- ---------------------------------------------------------------------------
-- 1. `bank_payouts.account_name` WAS NOT NULL, AND THAT REFUSED GHANA ENTIRELY
-- ---------------------------------------------------------------------------
--
-- 043 makes the beneficiary name mandatory for the best of reasons: an account
-- number that passes every format check can still belong to a stranger, and
-- the BANK'S answer is the only claim about the beneficiary that does not come
-- from the sender. So the column is NOT NULL, the service re-fetches the name
-- rather than accepting one, and `payoutSchema` is `.strict()` so a
-- caller-supplied name is refused rather than ignored.
--
-- ALL OF THAT IS ABOUT A BANK ACCOUNT. A MOBILE MONEY WALLET HAS NO NAME
-- ENQUIRY — not "not yet", not "not on this provider": the networks do not
-- offer one, which 043 itself records as `name_unavailable` and 059 repeats.
-- So the send path asked for a name that cannot exist, was correctly told it
-- could not have one, and refused the payout. Every mobile money send in Ghana
-- and Kenya, from the day the corridor opened.
--
-- The column is NULLABLE now and means exactly what its absence says: NOBODY
-- CONFIRMED WHO HOLDS THIS. That is strictly more honest than the alternative
-- somebody reaches for under deadline — writing the sender's own typed name
-- into it — which is a confirmation screen that confirms nothing while looking
-- exactly like one. 043's rule is unchanged where it applies: where a rail CAN
-- answer, the answer is fetched, stored and sent, and is never the sender's.
ALTER TABLE bank_payouts ALTER COLUMN account_name DROP NOT NULL;

-- The shape check stays for a name that IS present, so "we have no name" and
-- "we have a blank name" cannot both mean the same row.
ALTER TABLE bank_payouts DROP CONSTRAINT IF EXISTS bank_payouts_account_name_check;
ALTER TABLE bank_payouts ADD CONSTRAINT bank_payouts_account_name_check
    CHECK (account_name IS NULL OR length(btrim(account_name)) BETWEEN 1 AND 140);

COMMENT ON COLUMN bank_payouts.account_name IS
    'The name the RAIL returned for this destination, never the sender''s. '
    'NULL where the rail has no name enquiry at all — a mobile money wallet — '
    'which is a fact about the product rather than about the number.';

-- ---------------------------------------------------------------------------
-- 2. THE NAME AND PHONE WERE ON THE KYC SUBMISSION AND NOT ON THE USER
-- ---------------------------------------------------------------------------
--
-- 040 keeps `users.full_name` and `kyc_submissions.full_name` apart on
-- purpose, and that decision is right: one is what somebody typed about
-- themselves and greets them on day one, the other is what a reviewer read off
-- a document and is the only one a money decision may read.
--
-- WHAT NOTHING NOTICED IS THAT AN ACCOUNT CAN HOLD THE SECOND AND NOT THE
-- FIRST. Every account opened before 040 has a null `full_name`, and every
-- account opened before the phone was collected has a null `phone` — and then
-- the customer submits identity documents carrying BOTH, a reviewer approves
-- them, and the platform now knows this person's name and number while their
-- own settings screen renders an em dash for each. The admin dashboard reads
-- the submission and shows them; the customer's own screen reads `users` and
-- shows nothing. Same person, same database, two answers.
--
-- THE PHONE IS THE HALF THAT COSTS MONEY. It is the Xetral-to-Xetral
-- identifier: a customer with a null one cannot be found on the Send screen,
-- so nobody can pay them, and their Request payment panel has nothing to
-- share. They are a verified customer who cannot receive money.
--
-- THIS REPAIRS RATHER THAN ASSERTS — 061's rule, for 061's reason. Every
-- statement is idempotent, touches only rows that hold NOTHING, and overrules
-- no decision anybody made: a customer who set their own name keeps it.
DO $$
DECLARE
    named   INT := 0;
    phoned  INT := 0;
BEGIN
    -- The name first, and only from an APPROVED submission. A pending one is a
    -- claim nobody has read yet, and a rejected one is a claim somebody
    -- disbelieved; neither belongs on the account.
    WITH approved AS (
        SELECT k.user_id, btrim(k.full_name) AS full_name
          FROM kyc_submissions k
         WHERE k.status = 'approved'
    )
    UPDATE users u
       SET full_name = a.full_name
      FROM approved a
     WHERE a.user_id = u.id
       AND u.full_name IS NULL
       AND length(a.full_name) BETWEEN 2 AND 120;
    GET DIAGNOSTICS named = ROW_COUNT;

    /*
     * THE NUMBER IS NORMALISED HERE THE WAY THE APPLICATION NORMALISES ONE,
     * because `users_phone_unique` is a plain unique index on text and cannot
     * see that `08031234567` and `+2348031234567` are one person. Writing the
     * submission's raw string would create exactly the duplicate that index
     * exists to refuse — on a table where every per-customer control assumes
     * one person is one number.
     *
     * `kyc_submissions.phone` is CHECKed `^\+?[0-9]{10,15}$`, so it is either
     * already international or national digits.
     */
    WITH approved AS (
        SELECT k.user_id,
               u.country,
               c.dial_code,
               regexp_replace(k.phone, '[^0-9]', '', 'g') AS digits,
               k.phone LIKE '+%'                          AS already_international
          FROM kyc_submissions k
          JOIN users     u ON u.id   = k.user_id
          LEFT JOIN countries c ON c.code = u.country
         WHERE k.status = 'approved'
           AND u.phone IS NULL
    ),
    built AS (
        SELECT user_id,
               CASE
                   WHEN already_international
                     OR (dial_code IS NOT NULL AND digits LIKE dial_code || '%'
                         AND digits NOT LIKE '0%')
                   THEN '+' || digits
                   WHEN dial_code IS NOT NULL
                   THEN '+' || dial_code || regexp_replace(digits, '^0+', '')
                   /*
                    * NO COUNTRY MEANS NO DIALLING CODE, AND GUESSING IS THE ONE
                    * THING THAT MUST NOT HAPPEN. Assuming the platform default
                    * would write a Nigerian number for a Ghanaian, and the
                    * index would then hold a string nobody can be reached on —
                    * which is worse than the blank it replaced, because a blank
                    * is visibly missing. 061 backfilled the country for exactly
                    * these rows; anything still without one is left for a
                    * person and reported by the view below.
                    */
                   ELSE NULL
               END AS phone
          FROM approved
    ),
    usable AS (
        SELECT b.user_id, b.phone
          FROM built b
         WHERE b.phone IS NOT NULL
           AND length(b.phone) BETWEEN 9 AND 16
           -- ONE NUMBER, ONE ACCOUNT. A collision here is two people having
           -- submitted the same number, which is a question for a person
           -- rather than for a migration: taking either side would silently
           -- decide whose it is.
           AND NOT EXISTS (SELECT 1 FROM users x WHERE x.phone = b.phone)
           AND (SELECT count(*) FROM built d WHERE d.phone = b.phone) = 1
    )
    UPDATE users u
       SET phone = s.phone
      FROM usable s
     WHERE s.user_id = u.id
       AND u.phone IS NULL;
    GET DIAGNOSTICS phoned = ROW_COUNT;

    RAISE NOTICE '067: filled in % name(s) and % phone number(s) from approved KYC', named, phoned;
END $$;

/**
 * WHO STILL CANNOT BE PAID, and why — because the failure is otherwise silent
 * in the way that matters most.
 *
 * A customer with no number does not see an error. Their Request payment panel
 * simply has nothing on it, and every person who tries to send them money is
 * told there is no such customer. Neither of them has any reason to think the
 * two facts are connected, and nothing anywhere counted it.
 *
 * NO NAME AND NO ADDRESS, the shape `customers_without_a_country` follows: a
 * count and a reason are what an operator acts on, and a list of people who
 * cannot receive money is not a list worth leaving on a dashboard.
 */
CREATE OR REPLACE VIEW customers_without_a_phone AS
SELECT count(*)                                                  AS customers,
       count(*) FILTER (WHERE country IS NULL)                    AS also_without_a_country,
       count(*) FILTER (WHERE kyc_tier >= 1)                      AS verified
  FROM users
 WHERE phone IS NULL
   AND status <> 'closed';

COMMENT ON VIEW customers_without_a_phone IS
    'Customers who cannot be found on the Send screen and cannot share a '
    'payment number, because the one identifier this product uses is missing. '
    'Filled in by the customer on their own settings screen, or backfilled '
    'from an approved KYC submission by 067.';

-- 036 fails the build on a view nothing classified, in both directions.
INSERT INTO attention_sources (source, decision, rationale)
VALUES (
    'customers_without_a_phone',
    'watch',
    'A customer with no phone number cannot be paid by anybody and cannot ask '
    'to be. It is not a queue: the fix is the customer filling it in on their '
    'own settings screen, so this counts rather than lists.'
)
ON CONFLICT (source) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 3. WHY A CHECKOUT REFUSED, WHERE AN OPERATOR CAN READ IT
-- ---------------------------------------------------------------------------
--
-- "Payment error" is what a payer saw when a cedi, shilling or dollar checkout
-- could not be started, and the only place the actual reason existed was one
-- log line written at the moment a stranger pressed a button. An operator
-- cannot page back through application logs looking for the afternoon somebody
-- tried to pay a customer they have never heard of.
--
-- SO THE PROVIDER'S OWN SENTENCE IS RECORDED ON THE ROW. That is 006's rule,
-- the one the funding rail has followed since it was written: the sentence
-- names our integration, so it goes to the row an operator reads and never to
-- the customer, who gets a code their app turns into words.
--
-- AND THE RAIL IS RECORDED WITH IT, because two providers serve this endpoint
-- and "no secret key is configured" is true of both. 061 records exactly that
-- fault — a log naming the global default sent an operator to check a
-- credential that had nothing to do with the failure.
--
-- `provider` is 059's and is already immutable by trigger; only the reason is
-- new here.
ALTER TABLE link_payments ADD COLUMN IF NOT EXISTS refusal_reason TEXT;

COMMENT ON COLUMN link_payments.refusal_reason IS
    'The provider''s OWN sentence when the checkout could not be started. Never '
    'shown to a payer — it names our integration — and the only place the cause '
    'of a "payment error" is answerable afterwards.';

/**
 * CHECKOUTS THAT NEVER STARTED, newest first.
 *
 * Every row here is somebody who tried to pay a Xetral customer and could not.
 * That is the most expensive failure on this platform and it was the quietest:
 * nothing was written down, the payer went away, and the customer never knew
 * anybody had tried.
 *
 * IT CARRIES NO PAYER EMAIL AND NO NAME. What an operator needs is the
 * currency, the rail and the sentence — who the stranger was is not part of
 * diagnosing a credential.
 */
CREATE OR REPLACE VIEW checkout_refusals AS
SELECT p.created_at,
       p.currency,
       p.provider,
       p.refusal_reason,
       p.amount_minor,
       p.reference
  FROM link_payments p
 WHERE p.refusal_reason IS NOT NULL
 ORDER BY p.created_at DESC;

COMMENT ON VIEW checkout_refusals IS
    'Payment links a payer opened and could not pay, with the rail''s own '
    'reason. A row here with "no secret key is configured" is a credential '
    'nobody pasted, not an outage.';

INSERT INTO attention_sources (source, decision, rationale)
VALUES (
    'checkout_refusals',
    'watch',
    'Somebody tried to pay a customer and the rail refused. Read when a '
    'customer reports a broken payment link; the reason on the row is what '
    'distinguishes a missing credential from an outage.'
)
ON CONFLICT (source) DO NOTHING;
