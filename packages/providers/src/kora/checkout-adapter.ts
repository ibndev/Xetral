import { z } from 'zod';
import { ProviderContractError, ProviderRejectedError } from '../ports/errors.js';
import type {
  CheckoutMethod,
  CheckoutOutcome,
  CheckoutPort,
  CheckoutRequest,
  CheckoutSession,
} from '../ports/checkout.js';
import { KORA_ENDPOINTS, type KoraClient } from './client.js';
import { koraMajor, koraMinor } from './amounts.js';

const PROVIDER = 'kora';

/**
 * WHICH OF KORA'S CHANNELS EACH OF OUR METHODS IS, per currency.
 *
 * The Checkout Redirect guide names four channels — `card`, `bank_transfer`,
 * `pay_with_bank`, `mobile_money` — and the Pay-ins Overview says where each
 * works: "Card Payments: Available in Nigeria (NGN). Mobile Money: Available
 * in Kenya (KES), Ghana (GHS) ... Bank Transfers: Available in Nigeria
 * (NGN)."
 *
 * THERE IS NO USSD CHANNEL ON KORA, and none is invented. A method this table
 * cannot name is refused here, before anything is sent, so a payer is told
 * the method is not available rather than landing on a page without it.
 */
export function koraChannel(method: CheckoutMethod, currency: string): string | undefined {
  switch (method) {
    case 'card':
      return currency === 'NGN' ? 'card' : undefined;
    case 'bank':
      return currency === 'NGN' ? 'bank_transfer' : undefined;
    case 'mobile_money':
      return currency === 'GHS' || currency === 'KES' ? 'mobile_money' : undefined;
    case 'ussd':
      return undefined;
  }
}

/**
 * The channels a stranger who chose nothing is offered. Only where the guides
 * document a single wallet rail is the page narrowed to it; everywhere else
 * Kora renders what the account is enabled for.
 */
const DEFAULT_CHANNELS: Readonly<Record<string, readonly string[]>> = {
  GHS: ['mobile_money'],
  KES: ['mobile_money'],
};

const initializeResponse = z.object({
  status: z.literal(true),
  message: z.string().optional(),
  data: z.object({
    reference: z.string().optional(),
    checkout_url: z.string().min(1),
  }),
});

const chargeResponse = z.object({
  status: z.literal(true),
  message: z.string().optional(),
  data: z.object({
    /** `success`, `failed`, `processing`, `pending`, `expired`. */
    status: z.string().min(1),
    /** Left `unknown` and read from its TEXT by `koraMinor`. */
    amount: z.unknown(),
    amount_paid: z.unknown().optional(),
    currency: z.string().min(1),
    payment_method: z.string().nullish(),
    channel: z.string().nullish(),
    transaction_date: z.string().nullish(),
  }),
});

/**
 * A KORA-HOSTED CHECKOUT, the redirect kind.
 *
 * `POST /api/v1/charges/initialize` answers a `checkout_url` the payer is
 * sent to (Checkout Redirect guide), and the outcome is read back with
 * `GET /api/v1/charges/:reference` — "It is very important to confirm the
 * status of the transaction before you give value to the customer."
 *
 * A redirect, not the inline widget, because the widget needs the PUBLIC key
 * in the page and keeps nothing off our origin that a redirect does not.
 */
export class KoraCheckoutAdapter implements CheckoutPort {
  readonly provider = PROVIDER;
  readonly #client: KoraClient;
  readonly #notificationUrl: string | undefined;

  /**
   * `notificationUrl` is where Kora posts the outcome. The guide accepts it
   * per charge as well as on the dashboard; passing it means a deployment
   * whose dashboard setting is stale still hears about its own checkouts.
   */
  constructor(client: KoraClient, options: { readonly notificationUrl?: string } = {}) {
    this.#client = client;
    this.#notificationUrl = options.notificationUrl;
  }

  async begin(request: CheckoutRequest): Promise<CheckoutSession> {
    let channels: readonly string[] | undefined = DEFAULT_CHANNELS[request.currency];
    if (request.method !== undefined) {
      const channel = koraChannel(request.method, request.currency);
      if (channel === undefined) {
        throw new ProviderRejectedError(
          PROVIDER,
          `Kora has no ${request.method} checkout for ${request.currency}`,
          'method_unavailable',
        );
      }
      channels = [channel];
    }

    const body = await this.#client.request('POST', KORA_ENDPOINTS.initializeCharge, {
      /* OURS. It names a row written before the payer left, so an event that
       * matches no row credits nobody — 058's security argument. */
      reference: request.reference,
      amount: koraMajor(request.amountMinor, request.currency),
      currency: request.currency,
      customer: {
        email: request.payerEmail,
        ...(request.payerName === undefined ? {} : { name: request.payerName }),
      },
      /* What the payer is told the payment is for. Inert: it cannot alter the
       * amount, the currency or who is credited. */
      narration:
        request.note ?? (request.payeeName === undefined ? 'Payment' : `Payment to ${request.payeeName}`),
      ...(channels === undefined
        ? {}
        : { channels, default_channel: channels[0] }),
      ...(request.callbackUrl === undefined || request.callbackUrl === ''
        ? {}
        : { redirect_url: request.callbackUrl }),
      ...(this.#notificationUrl === undefined ? {} : { notification_url: this.#notificationUrl }),
      /* The merchant bears the fee — Kora's default, stated rather than
       * assumed, because the opposite makes the amount the payer is charged
       * differ from the amount the row was written for, and the settle then
       * refuses a payment that was made. */
      merchant_bears_cost: true,
    });

    const parsed = initializeResponse.safeParse(body);
    if (!parsed.success) {
      throw new ProviderContractError(
        PROVIDER,
        `unexpected /charges/initialize response: ${parsed.error.message}`,
      );
    }
    return { authorizationUrl: parsed.data.data.checkout_url, reference: request.reference };
  }

  async verify(reference: string): Promise<CheckoutOutcome> {
    let body: unknown;
    try {
      body = await this.#client.request('GET', KORA_ENDPOINTS.charge(reference));
    } catch (error) {
      /* "Charge not found — ... This can be treated as a failed transaction"
       * (Errors guide). The port asks for a refusal, not `failed`, for a
       * reference the rail does not know: an unpaid reference is not a
       * failed payment. */
      if (error instanceof ProviderRejectedError && /charge not found/i.test(error.message)) {
        throw new ProviderRejectedError(PROVIDER, error.message, 'unknown_reference', error);
      }
      throw error;
    }
    const parsed = chargeResponse.safeParse(body);
    if (!parsed.success) {
      throw new ProviderContractError(
        PROVIDER,
        `unexpected /charges/:reference response: ${parsed.error.message}`,
      );
    }
    const data = parsed.data.data;
    const status = data.status.trim().toLowerCase();
    return {
      /* Only `success` is money and only `failed` is a refusal; anything else
       * — processing, pending, expired — is left PENDING, because the relay
       * never decides an outcome the rail did not state. */
      status: status === 'success' ? 'success' : status === 'failed' ? 'failed' : 'pending',
      reference,
      /*
       * WHAT WAS PAID, where Kora says. `amount_paid` is what the payer
       * actually sent; `amount` is what was asked. With the merchant bearing
       * the fee the two agree on a normal payment, and where they do not the
       * settle compares against the row and refuses — crediting `amount`
       * after an underpayment would credit money that never arrived.
       */
      amountMinor:
        status === 'success' && data.amount_paid !== undefined && data.amount_paid !== 0
          ? koraMinor(data.amount_paid, data.currency)
          : koraMinor(data.amount, data.currency),
      currency: data.currency,
      channel: data.payment_method ?? data.channel ?? undefined,
      paidAt: data.transaction_date ?? undefined,
    };
  }
}
