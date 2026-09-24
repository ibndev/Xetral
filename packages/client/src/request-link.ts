import { TRANSFER_CURRENCIES } from './catalogues.js';
import { exponentFor, isValidAmount } from './money.js';

/**
 * A REQUEST IS A PAYMENT LINK WITH A SUGGESTION ON IT.
 *
 * The comp's Request screen asks for an amount and a reason and produces a
 * link. The platform's payment link has always let the PAYER choose the
 * amount (058), and it still does: what a request adds is a PREFILL — the
 * amount, currency and reason ride on the query string, the checkout opens
 * with them filled in, and the payer can read them before paying.
 *
 * THAT IS WHY NOTHING HERE IS TRUSTED. A query string is text anybody can
 * edit, so it never touches the server's decision about money: the checkout
 * still posts whatever amount is in the box, the API still verifies the
 * charge against the provider before crediting, and the payee is credited
 * what was PAID. A tampered link can change what the payer is shown, which is
 * also true of any message the link arrives in.
 *
 * AND IT IS VALIDATED ON THE WAY IN, not just the way out: an amount the
 * currency cannot represent, or a currency the platform does not know, is
 * dropped rather than shown — a checkout opening on "₦25,000.505" is a
 * checkout that then refuses the payer for a number they did not type.
 */
export interface PaymentRequest {
  readonly amount?: string;
  readonly currency?: string;
  readonly note?: string;
}

/** The longest reason a request carries — the checkout's own note limit. */
export const REQUEST_NOTE_MAX = 140;

export function requestLinkFor(link: string, request: PaymentRequest): string {
  const clean = readRequest(
    new URLSearchParams({
      ...(request.amount === undefined ? {} : { amount: request.amount }),
      ...(request.currency === undefined ? {} : { currency: request.currency }),
      ...(request.note === undefined ? {} : { for: request.note }),
    }),
  );
  const query = new URLSearchParams();
  if (clean.amount !== undefined) query.set('amount', clean.amount);
  if (clean.currency !== undefined) query.set('currency', clean.currency);
  if (clean.note !== undefined) query.set('for', clean.note);
  const text = query.toString();
  return text === '' ? link : `${link}${link.includes('?') ? '&' : '?'}${text}`;
}

/** What a request link asks for, keeping only what is well formed. */
export function readRequest(query: URLSearchParams): PaymentRequest {
  const rawCurrency = query.get('currency')?.trim().toUpperCase();
  const currency =
    rawCurrency !== undefined && (TRANSFER_CURRENCIES as readonly string[]).includes(rawCurrency)
      ? rawCurrency
      : undefined;

  const rawAmount = query.get('amount')?.trim();
  // An amount is only meaningful in a currency, because the exponent is per
  // currency — so without one it is dropped rather than guessed at.
  const amount =
    rawAmount !== undefined &&
    currency !== undefined &&
    isValidAmount(rawAmount, exponentFor(currency)) &&
    !/^0+(\.0+)?$/.test(rawAmount)
      ? rawAmount
      : undefined;

  const rawNote = query.get('for')?.replace(/\s+/g, ' ').trim();
  const note =
    rawNote === undefined || rawNote === '' ? undefined : rawNote.slice(0, REQUEST_NOTE_MAX);

  return {
    ...(amount === undefined ? {} : { amount }),
    ...(currency === undefined ? {} : { currency }),
    ...(note === undefined ? {} : { note }),
  };
}
