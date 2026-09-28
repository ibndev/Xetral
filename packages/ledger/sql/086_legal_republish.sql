-- ============================================================================
--  086 — republishing the terms and the privacy notice for the payment partner
--
--  FLUTTERWAVE'S REVIEW ASKED FOR THREE THINGS, and two of them change words a
--  customer agreed to:
--
--    * The terms must name the contracting party as its registry does —
--      "Xetral Ltd", registration number RC 9748553 — not the legal name
--      alone. `company.ts` carries both, and the terms now render it, so from
--      this version the terms hash covers `company.ts` as well as the page:
--      a registration number changed under an unchanged version would be the
--      same drift 077 closed for the recipient list.
--    * The privacy notice must address the NDPR — the principles, the rights
--      it adds (restriction, portability, no solely automated decisions),
--      the 72-hour breach notice to the NDPC — and state how a card number is
--      and is not handled.
--
--  The third, the refund and cancellation policy, is a new page and NOT a
--  consent document: the terms incorporate it by reference, and nothing about
--  it asks a customer to agree again.
--
--  BOTH ARE REPUBLISHED because both changed. 075's guards apply: retire only
--  what is OLDER and publish only if nothing NEWER is live, so a fresh
--  database, whose seed carries this version, is untouched.
-- ============================================================================

UPDATE consent_documents
   SET retired_at = now()
 WHERE kind IN ('terms', 'privacy')
   AND retired_at IS NULL
   AND version < '2026-09-28';

INSERT INTO consent_documents (kind, version, body_sha256, summary)
SELECT 'terms', '2026-09-28',
       '02f53bb837abb9146dd33a1ba90022fd9ce33169e83e2aea82e92693a65a94d0',
       'The terms on which Xetral Ltd (RC 9748553) holds and moves your money, '
       'including who may open an account, what cannot be undone, how refunds '
       'work and how to complain.'
 WHERE NOT EXISTS (
       SELECT 1 FROM consent_documents
        WHERE kind = 'terms' AND retired_at IS NULL AND version > '2026-09-28')
ON CONFLICT (kind, version) DO NOTHING;

INSERT INTO consent_documents (kind, version, body_sha256, summary)
SELECT 'privacy', '2026-09-28',
       '77d0bf612f99ee4ba3f84416ec58492716e726aa4dd640d031debdf7489aec59',
       'What personal data Xetral Ltd holds, why, exactly which companies receive '
       'it and what reaches them, your rights under the NDPA and the NDPR, how a '
       'card number is handled, how long data is kept, and how to get a copy or '
       'have it erased.'
 WHERE NOT EXISTS (
       SELECT 1 FROM consent_documents
        WHERE kind = 'privacy' AND retired_at IS NULL AND version > '2026-09-28')
ON CONFLICT (kind, version) DO NOTHING;
