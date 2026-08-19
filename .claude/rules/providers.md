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

## Writing a new adapter

1. Implement the port interface. Do not widen the port to fit one provider's
   quirks — absorb the quirk in the adapter.
2. Test the amount conversion in both directions, including a value that would
   lose precision as a float.
3. Test replay: the same webhook delivered twice must produce one journal entry.
4. Test partial failure: provider accepted, our write failed. The reconciliation
   path must be able to detect and resolve it.

## Async operations

Bitnob card funding returns immediately with `status: "pending"` and
`balance_before === balance_after`. Do not treat that response as success. The
final state arrives by webhook, or by polling the card transactions endpoint.
