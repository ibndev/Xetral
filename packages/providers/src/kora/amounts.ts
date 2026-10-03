import { fromMajor, isCurrency, money, toMajor } from '@xetral/shared';
import { ProviderContractError } from '../ports/errors.js';

const PROVIDER = 'kora';

/**
 * THE ONE PLACE A KORA AMOUNT CROSSES THE UNIT BOUNDARY, in both directions.
 *
 * EVERY KORA AMOUNT IS MAJOR UNITS. A payout's `amount` is "transaction
 * amount in two decimal places" (Payout API guide), a charge reads back as
 * `"amount": "2000.00"`, and the sandbox credit's minimum is "NGN 100".
 * Paystack, one directory away, takes MINOR units — so copying its
 * `amountMinor.toString()` here charges a payer a HUNDRED TIMES the amount,
 * in the direction that takes their money, and nothing on either API would
 * refuse it. `toMajor` and `fromMajor` are the only code that knows an
 * exponent is per currency.
 */
export function koraMajor(amountMinor: bigint, currency: string): string {
  if (!isCurrency(currency)) {
    throw new ProviderContractError(PROVIDER, `not a currency this platform knows: ${currency}`);
  }
  return toMajor(money(amountMinor, currency));
}

/**
 * A Kora amount back into the ledger's minor units — FROM ITS TEXT.
 *
 * Kora sends the same field as a string in one sample (`"2000.00"`) and a
 * JSON number in another (`150.99`). A number has already been rounded by
 * `JSON.parse` by the time it gets here, which is why `fromMajor` takes a
 * string and a number is turned into one before it is read — and why an
 * unsafe or non-finite one is refused rather than coerced.
 */
export function koraMinor(amount: unknown, currency: string): bigint {
  if (!isCurrency(currency)) {
    throw new ProviderContractError(PROVIDER, `not a currency this platform knows: ${currency}`);
  }
  const text =
    typeof amount === 'string'
      ? amount.trim()
      : typeof amount === 'number' && Number.isFinite(amount) && Math.abs(amount) < 1e15
        ? String(amount)
        : undefined;
  if (text === undefined || text === '') {
    throw new ProviderContractError(PROVIDER, 'an amount was missing or unreadable');
  }
  try {
    return fromMajor(text, currency).amount;
  } catch (cause) {
    throw new ProviderContractError(PROVIDER, `unreadable amount ${text} ${currency}`, cause);
  }
}
