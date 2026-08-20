---
paths:
  - "**/providers/**"
  - "**/adapters/**"
  - "**/*bitnob*"
  - "**/*vtpass*"
  - "**/*airalo*"
  - "**/*twilio*"
---

# Working on a provider adapter

Live set: Bitnob, VTpass, Airalo, Twilio. Do not add Reloadly, Maplerad, Anchor,
Paystack or ALAT — they exist in the reference plugin and are out of scope.

## Boundary rules

- Provider types never leak past the adapter. The rest of the system sees domain
  types from `@xetral/shared`.
- Amount conversion happens at **one** place per adapter, with its own tests. This
  matters most for Bitnob, whose webhooks use micro-units (1 USD = 1,000,000)
  against a ledger in cents.
- `display_amount` and any other float field is **display only**. It must never
  reach a ledger posting.
- Every inbound webhook derives `idempotency_key` as `<provider>:<event_id>`.
  Signature verification happens before parsing, and a failed verification is
  logged and dropped, never retried into the ledger.

## Where things live

`packages/providers/src/ports/` is the platform-facing side; anything under
`bitnob/` is one implementation of it. `ledger-intent.ts` is what every adapter
produces — a *request* for a journal entry, naming accounts by role — because
Rule 1 says only the Ledger writes postings.

Build legs with `posting()`. It is generic over the currency, so an amount
cannot be paired with the wrong code; a hand-written object literal can.

## Writing a new adapter

1. Implement the port interface. Do not widen the port to fit one provider's
   quirks — absorb the quirk in the adapter.
2. Test the amount conversion in both directions, including a value that would
   lose precision as a float.
3. Test replay: the same webhook delivered twice must produce one journal entry.
4. Test partial failure: provider accepted, our write failed. The reconciliation
   path must be able to detect and resolve it.
5. Classify every failure by what the caller should DO. `retryable` is required
   on `ProviderError` so a new error type cannot be added without someone
   deciding. A timeout is **not** retryable: it means we do not know whether the
   provider acted, and retrying a funding is how one becomes two.
6. Add the adapter's intents to the e2e suite. `EntryKind` and `AccountRef` are
   TypeScript literals and Postgres enums, and only an insert proves they still
   agree.

## Async operations

Bitnob card funding returns immediately with `status: "pending"` and
`balance_before === balance_after`. Do not treat that response as success. The
final state arrives by webhook, or by polling the card transactions endpoint.
