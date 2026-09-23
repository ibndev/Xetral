import { CRYPTO_ASSETS } from './catalogues.js';
import type { Balance, DollarTotal } from './client.js';

/**
 * THE CRYPTO SCREEN'S PORTFOLIO, read off `/v1/wallets/total` and the
 * balances — one derivation for both apps, so the web and the phone cannot
 * show a customer two different values for the same coins.
 *
 * THE DOLLAR FIGURES ARE THE API'S OWN LINES, never a price computed here.
 * That route values each balance at what a conversion would actually pay,
 * and the portfolio is the crypto half of the same arithmetic the home
 * headline sums. A client with no prices of its own cannot invent one.
 *
 * AN UNPRICED HOLDING IS NAMED, NEVER VALUED. `value` is undefined for it and
 * `unpriced` lists it, so the card can say what the total leaves out rather
 * than reading as money gone.
 */
export interface PortfolioRow {
  readonly asset: string;
  /** Spendable, major units, in the asset itself. */
  readonly held: string;
  readonly empty: boolean;
  /** Dollar value in cents, or undefined when this platform has no
   *  published price for a non-zero holding. Zero for an empty one. */
  readonly valueMinor: string | undefined;
}

export interface Portfolio {
  /** The sum of every priced row, in dollar cents. */
  readonly totalMinor: string;
  readonly rows: readonly PortfolioRow[];
  /** Held and left out of the total for want of a price. */
  readonly unpriced: readonly string[];
  /** The largest priced holding — what Sell opens on. */
  readonly largest: string | undefined;
}

/** A major-unit string that is zero at any precision. */
const ZERO = /^0(\.0+)?$/;

export function cryptoPortfolio(
  total: Pick<DollarTotal, 'lines'> | undefined,
  balances: readonly Pick<Balance, 'currency' | 'spendable'>[] | undefined,
): Portfolio {
  const lines = new Map((total?.lines ?? []).map((l) => [l.currency, l]));
  const held = new Map((balances ?? []).map((b) => [b.currency, b.spendable]));

  let cents = 0n;
  let largest: string | undefined;
  let largestCents = 0n;
  const unpriced: string[] = [];
  const rows = CRYPTO_ASSETS.map((asset): PortfolioRow => {
    const amount = held.get(asset) ?? '0';
    const empty = ZERO.test(amount);
    const line = lines.get(asset);
    if (line !== undefined) {
      const value = BigInt(line.amount_minor);
      cents += value;
      if (value > largestCents) {
        largest = asset;
        largestCents = value;
      }
      return { asset, held: amount, empty, valueMinor: line.amount_minor };
    }
    if (!empty) unpriced.push(asset);
    return { asset, held: amount, empty, valueMinor: empty ? '0' : undefined };
  });

  return { totalMinor: cents.toString(), rows, unpriced, largest };
}
