import { z } from 'zod';
import { ProviderContractError, ProviderRejectedError } from '../ports/errors.js';
import type { PaystackClient } from './client.js';

const PROVIDER = 'paystack';

/**
 * A PAYSTACK-HOSTED CHECKOUT, and why this is not the funding adapter.
 *
 * `FundingPort` is about a DEDICATED ACCOUNT: a bank account number issued in
 * a customer's name that receives transfers for ever. This is the other
 * shape — one payment, for one amount, by whatever method the payer has, on a
 * page Paystack renders. It is what makes a payment link payable by somebody
 * who has no Xetral account, and what lets a customer in Ghana top up from
 * their own mobile money wallet, where no dedicated account exists to pay
 * into.
 *
 * THE WIRE CONTRACT, verified against Paystack's published API and their own
 * Node SDK (`paystack-api@2.0.6`, resources/transactions.js):
 *
 *   - initialize   `POST /transaction/initialize`
 *                  `{ email, amount, currency, reference, callback_url,
 *                     metadata }`
 *                  → `{ status, data: { authorization_url, reference } }`
 *   - verify       `GET /transaction/verify/:reference`
 *                  → `{ status, data: { status, amount, currency, ... } }`
 *
 * `amount` IS IN THE CURRENCY'S SUBUNIT — kobo, pesewa, cent — which is the
 * same minor unit the ledger holds. There is no conversion here, and that is
 * worth stating rather than assuming: it is the one thing about this call
 * that, if wrong, is wrong by a factor of a hundred in the direction of
 * crediting too much.
 *
 * THE REFERENCE IS OURS. Paystack will generate one if we do not send one, and
 * sending our own is what makes the webhook resolvable: the event names a row
 * we wrote before the payer was ever sent to the page, and that row says whose
 * wallet the money belongs in. Without it, `charge.success` on a checkout
 * carries nothing that identifies a customer — 044's `dedicated_nuban` test
 * cannot apply, because a checkout has no dedicated account.
 */
export const PAYSTACK_CHECKOUT_ENDPOINTS = {
  initialize: '/transaction/initialize',
  verify: (reference: string) => `/transaction/verify/${encodeURIComponent(reference)}`,
} as const;

const initializeResponse = z.object({
  status: z.boolean().optional(),
  message: z.string().optional(),
  data: z
    .object({
      authorization_url: z.string().min(1),
      access_code: z.string().optional(),
      reference: z.string().min(1),
    })
    .optional(),
});

const verifyResponse = z.object({
  status: z.boolean().optional(),
  message: z.string().optional(),
  data: z
    .object({
      /** `success`, `failed`, `abandoned`, `ongoing`, … */
      status: z.string().min(1),
      reference: z.string().min(1),
      /** Left `unknown` and narrowed by the caller: a `z.number()` would
       *  accept a value `JSON.parse` has already rounded. */
      amount: z.unknown(),
      currency: z.string().min(1),
      channel: z.string().nullish(),
      paid_at: z.string().nullish(),
    })
    .optional(),
});

export interface CheckoutRequest {
  /**
   * REQUIRED BY PAYSTACK, and it is the PAYER'S, not the payee's.
   *
   * They send the receipt there. A payment link is paid by strangers, so the
   * page asks for it — and it is the only thing the page asks for beyond an
   * amount, because every additional field on a checkout is a payer who
   * changed their mind.
   */
  readonly payerEmail: string;
  /** Minor units — kobo, pesewa, cent. The same unit the ledger holds. */
  readonly amountMinor: bigint;
  readonly currency: string;
  /** OURS. See the header: this is what makes the webhook resolvable. */
  readonly reference: string;
  /** Where Paystack returns the payer after they pay. */
  readonly callbackUrl?: string;
  /** Shown to the payer on Paystack's own page, so they can see who they are
   *  paying before they part with money. */
  readonly payeeName?: string;
}

export interface CheckoutSession {
  /** Where to send the payer. Paystack renders the method picker. */
  readonly authorizationUrl: string;
  readonly reference: string;
}

export async function initializeCheckout(
  client: PaystackClient,
  request: CheckoutRequest,
): Promise<CheckoutSession> {
  const body = await client.request('POST', PAYSTACK_CHECKOUT_ENDPOINTS.initialize, {
    email: request.payerEmail,
    /*
     * A STRING, NOT A NUMBER, and this is a money path so it matters. The
     * amount is a bigint here — it can exceed 2^53 in kobo — and
     * `JSON.stringify` throws on one rather than rounding it, which is the
     * behaviour this codebase relies on. Sending the decimal text is the one
     * conversion that loses nothing.
     */
    amount: request.amountMinor.toString(),
    currency: request.currency,
    reference: request.reference,
    ...(request.callbackUrl === undefined ? {} : { callback_url: request.callbackUrl }),
    metadata: {
      // Shown on Paystack's page and on their dashboard. The payer sees who
      // they are paying before they pay, which is the whole difference
      // between a checkout and a form that takes money.
      ...(request.payeeName === undefined
        ? {}
        : { custom_fields: [{ display_name: 'Paying', variable_name: 'paying', value: request.payeeName }] }),
      xetral_reference: request.reference,
    },
  });

  const parsed = initializeResponse.safeParse(body);
  if (!parsed.success || parsed.data.data === undefined) {
    // A CONTRACT BREAK, not an outage. Waiting does not fix a response shape,
    // and a retry loop would hide it.
    throw new ProviderContractError(
      PROVIDER,
      `unexpected transaction/initialize response: ${parsed.success ? (parsed.data.message ?? 'no data') : parsed.error.message}`,
    );
  }

  return {
    authorizationUrl: parsed.data.data.authorization_url,
    reference: parsed.data.data.reference,
  };
}

export interface CheckoutOutcome {
  readonly status: 'success' | 'failed' | 'pending';
  readonly reference: string;
  /** Minor units, as text. Narrowed by the caller against what it asked for. */
  readonly amount: unknown;
  readonly currency: string;
  readonly channel: string | undefined;
  readonly paidAt: string | undefined;
}

/**
 * ASK, rather than wait to be told.
 *
 * The same argument the deposit reconciliation sweep makes: a webhook that
 * never arrives is money the payer has parted with and the customer never
 * sees, and nothing is retrying. This is also what the payer's own return
 * from Paystack triggers, so the common case is credited in the second it
 * takes them to come back rather than whenever the webhook lands.
 */
export async function verifyCheckout(
  client: PaystackClient,
  reference: string,
): Promise<CheckoutOutcome> {
  const body = await client.request('GET', PAYSTACK_CHECKOUT_ENDPOINTS.verify(reference));

  const parsed = verifyResponse.safeParse(body);
  if (!parsed.success || parsed.data.data === undefined) {
    throw new ProviderRejectedError(
      PROVIDER,
      parsed.success ? (parsed.data.message ?? 'no such transaction') : parsed.error.message,
      'unknown_reference',
    );
  }

  const data = parsed.data.data;
  return {
    /*
     * THREE STATES, AND `abandoned` IS PENDING RATHER THAN FAILED.
     *
     * A payer who opened the page and walked away has abandoned it FOR NOW —
     * Paystack's own checkout stays payable, and the reference stays live. A
     * `failed` we can record as failed; anything else is "not yet", which is
     * the state that must not be turned into an outcome by a sweep. Same rule
     * the purchase reconciler follows: never decide, only relay.
     */
    status:
      data.status === 'success' ? 'success' : data.status === 'failed' ? 'failed' : 'pending',
    reference: data.reference,
    amount: data.amount,
    currency: data.currency,
    channel: data.channel ?? undefined,
    paidAt: data.paid_at ?? undefined,
  };
}
