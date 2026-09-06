import type { ProviderError } from './errors.js';

/**
 * A HOSTED CHECKOUT — one payment, one amount, on a page the provider renders.
 *
 * WHY THIS IS A PORT NOW, having been two loose functions in
 * `paystack/checkout.ts`. It had exactly one implementation, and one
 * implementation does not need an interface — that was true and it stopped
 * being true the moment a second rail existed. A Paystack account registered
 * in Nigeria settles in naira: asked for cedis it either refuses outright or
 * accepts and converts at a rate nobody chose, so Ghana and Kenya need
 * somebody else, and the caller must not know which.
 *
 * WHAT THIS IS NOT is `FundingPort`, which is about a DEDICATED ACCOUNT — a
 * bank account number issued in a customer's name that receives transfers for
 * ever. This is the other shape, and the two are kept apart because a
 * checkout has no account number and therefore cannot carry 044's
 * `dedicated_nuban` test.
 *
 * AMOUNTS ARE MINOR UNITS ACROSS THIS PORT, always, in both directions. That
 * is the ledger's unit and it is the only one that cannot lose a fraction.
 * Paystack happens to want minor units on the wire and Flutterwave happens to
 * want major ones — a difference of a FACTOR OF A HUNDRED, in the direction
 * of charging a customer a hundred times too much — so each adapter converts
 * at its own boundary and neither convention reaches a caller. That is the
 * rule `bitnob/amounts.ts` records for micro-units, applied one provider on.
 */
export interface CheckoutRequest {
  /**
   * REQUIRED BY BOTH PROVIDERS, and it is the PAYER'S, not the payee's.
   *
   * They send the receipt there. A payment link is paid by strangers, so the
   * page asks for it — and it is nearly the only thing the page asks for
   * beyond an amount, because every additional field on a checkout is a payer
   * who changed their mind.
   */
  readonly payerEmail: string;
  /** Minor units — kobo, pesewa, cent. The same unit the ledger holds. */
  readonly amountMinor: bigint;
  readonly currency: string;
  /**
   * OURS, never theirs.
   *
   * It names a row written BEFORE the payer left, so an inbound event that
   * matches no row credits nobody — the security argument 058 makes, and the
   * reason verification asks by our reference rather than by their id.
   */
  readonly reference: string;
  /** Where the provider returns the payer after they pay. */
  readonly callbackUrl?: string;
  /** Shown to the payer on the provider's page, so they can see who they are
   *  paying before they part with money. */
  readonly payeeName?: string;
  /** The payer's own name, when they gave one. */
  readonly payerName?: string;
  /**
   * WHAT THE PAYMENT IS FOR, in the payer's words.
   *
   * Carried into the provider's metadata and shown on their dashboard and
   * receipt. It is deliberately inert: it can never alter the amount, the
   * currency or who is credited, because a free-text box that could would be
   * a free-text box worth attacking.
   */
  readonly note?: string;
}

export interface CheckoutSession {
  /** Where to send the payer. The provider renders the method picker. */
  readonly authorizationUrl: string;
  readonly reference: string;
}

export interface CheckoutOutcome {
  /**
   * THREE STATES, AND ANYTHING UNFINISHED IS `pending` RATHER THAN `failed`.
   *
   * A payer who opened the page and walked away has abandoned it FOR NOW —
   * the reference stays live and the page stays payable. Turning that into an
   * outcome is the mistake the purchase reconciler exists not to make: never
   * decide, only relay.
   */
  readonly status: 'success' | 'failed' | 'pending';
  readonly reference: string;
  /**
   * MINOR UNITS, as a bigint, whatever the provider sent on the wire.
   *
   * Narrowed by the adapter rather than by the caller, because the two rails
   * disagree about the unit and the caller must not have to know which one
   * answered.
   */
  readonly amountMinor: bigint;
  readonly currency: string;
  readonly channel: string | undefined;
  readonly paidAt: string | undefined;
}

export interface CheckoutPort {
  /** Which rail this is — recorded on the payment, because a provider-side
   *  reference is opaque and only its issuer can verify it. */
  readonly provider: string;

  /** Start a payment and answer where to send the payer. */
  begin(request: CheckoutRequest): Promise<CheckoutSession>;

  /**
   * Ask what became of one, BY OUR OWN REFERENCE.
   *
   * Throws `ProviderRejectedError` for a reference the provider does not
   * know — which is the honest answer for one nobody ever paid, and must not
   * be collapsed into `failed`.
   */
  verify(reference: string): Promise<CheckoutOutcome>;
}

/** Narrowing helper for callers that must tell a refusal from an outage. */
export type CheckoutFailure = ProviderError;
