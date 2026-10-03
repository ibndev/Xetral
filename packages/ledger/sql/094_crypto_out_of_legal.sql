-- ============================================================================
--  094 — the terms and the privacy notice stop describing crypto
--
--  CRYPTO IS HIDDEN UNTIL IT LAUNCHES (093), AND THE LEGAL PAGES STILL
--  OFFERED IT. The terms listed "a crypto withdrawal" among the things that
--  cannot be undone and named "a blockchain" among the outages we are not
--  responsible for; the privacy notice said Bitnob receives instructions "for
--  cards, crypto and conversion". A document a customer agrees to describing a
--  service the app does not show them is a statement about a product that is
--  not offered. Both come back with crypto, as a new version.
--
--  NOTHING ELSE IN THE WORDING MOVED. Bitnob stays listed with what it does
--  receive — cards, conversion and, for a verified customer, a naira account.
--
--  075's GUARDS, as every republish since: retire only what is OLDER, publish
--  only if nothing NEWER is live, so a fresh database whose seed already
--  carries these versions is untouched and a database ahead of this file is
--  not moved backwards. Every customer is asked to accept both again — that is
--  `consent_outstanding` doing its job.
-- ============================================================================

BEGIN;

UPDATE consent_documents
   SET retired_at = now()
 WHERE kind IN ('terms', 'privacy')
   AND retired_at IS NULL
   AND version < '2026-10-03';

INSERT INTO consent_documents (kind, version, body_sha256, summary)
SELECT 'terms', '2026-10-03',
       '4900d74dcbf601e1872b53a830aee1774f76ae638794210a8ab9504ef61f9c71',
       'The terms on which Xetral Ltd (RC 9748553) holds and moves your money, '
       'including who may open an account, what cannot be undone, how refunds '
       'work and how to complain.'
 WHERE NOT EXISTS (
       SELECT 1 FROM consent_documents
        WHERE kind = 'terms' AND retired_at IS NULL AND version > '2026-10-03')
ON CONFLICT (kind, version) DO NOTHING;

INSERT INTO consent_documents (kind, version, body_sha256, summary)
SELECT 'privacy', '2026-10-03',
       '10385b116c49514bbfc88c54c85c23aa82184cb781586a22dc53a2c126c8eb3e',
       'What personal data Xetral Ltd holds, why, exactly which companies receive '
       'it and what reaches them — including Paystack, which is given your BVN and '
       'a bank account on it when it needs them to open your naira account number '
       '— how long it is kept, and how to get a copy or have it erased.'
 WHERE NOT EXISTS (
       SELECT 1 FROM consent_documents
        WHERE kind = 'privacy' AND retired_at IS NULL AND version > '2026-10-03')
ON CONFLICT (kind, version) DO NOTHING;

COMMIT;
