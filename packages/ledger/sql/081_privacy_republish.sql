-- ============================================================================
--  081 — republishing the privacy notice, because Bitnob can open naira accounts
--
--  THE NOTICE SAID BITNOB RECEIVES "A REFERENCE THAT MEANS NOTHING OUTSIDE
--  THEIR SYSTEM". That was true of cards, crypto and conversion, and it was
--  about to stop being true of the whole company: Bitnob can be chosen on
--  `/admin/providers` to open naira account numbers, and their documentation
--  (`docs/virtual-accounts/overview.mdx`) puts the BVN — with a name and date
--  of birth that must match the national registry — on the Bitnob CUSTOMER.
--
--  The adapter never did send those, and that was a bug of its own: it sent a
--  `customer_id` of `xetral-<uuid>` — a string WE mint at KYC approval — to an
--  API that had never issued it, so no naira account could have opened there
--  for anybody. Now it registers the customer, and for a VERIFIED customer
--  only; an unverified one is skipped with nothing sent and opens on a rail
--  that needs neither. The notice says so before the first one leaves.
--
--  THE TERMS ARE NOT REPUBLISHED — they did not change — and 075's guards
--  apply: retire only what is OLDER and publish only if nothing NEWER is
--  live, so a fresh database, whose seed carries this version, is untouched.
-- ============================================================================

UPDATE consent_documents
   SET retired_at = now()
 WHERE kind = 'privacy'
   AND retired_at IS NULL
   AND version < '2026-09-25';

INSERT INTO consent_documents (kind, version, body_sha256, summary)
SELECT 'privacy', '2026-09-25',
       '4109639543a30bcf63136cd763b416ea6b234a5fe8043660199c576920f20689',
       'What personal data Xetral Ltd holds, why, exactly which companies receive '
       'it and what reaches them — including Flutterwave or Bitnob, whichever opens '
       'your naira account number, which is given your BVN — how long it is kept, '
       'and how to get a copy or have it erased.'
 WHERE NOT EXISTS (
       SELECT 1 FROM consent_documents
        WHERE kind = 'privacy' AND retired_at IS NULL AND version > '2026-09-25')
ON CONFLICT (kind, version) DO NOTHING;
