/**
 * HOW A PAYER CAN PAY, per currency, as the pay page offers it.
 *
 * The SAME table the API validates against (`CHECKOUT_METHODS` in
 * `@xetral/providers`), bound by `pay-methods.test.ts` rather than imported:
 * this package ships to the phone and carries no provider code. A method
 * offered here and refused there is a button that cannot be used; one
 * accepted there and missing here is a way to pay nobody can pick.
 */
export type PayMethod = 'card' | 'ussd' | 'mobile_money' | 'bank';

export const PAY_METHODS: Readonly<Record<string, readonly PayMethod[]>> = {
  NGN: ['bank', 'card', 'ussd'],
  GHS: ['mobile_money'],
  KES: ['mobile_money'],
  USD: ['card'],
};

/** The methods for a currency, first being the default; card where none is listed. */
export function payMethodsFor(currency: string): readonly PayMethod[] {
  return PAY_METHODS[currency] ?? ['card'];
}

/** What each method is called on a button. */
export const PAY_METHOD_LABEL: Readonly<Record<PayMethod, string>> = {
  mobile_money: 'Mobile money',
  bank: 'Bank',
  card: 'Card',
  ussd: 'USSD',
};
