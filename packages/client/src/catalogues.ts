/**
 * THE LISTS BOTH APPS CHOOSE FROM, and the reason they live here.
 *
 * These were written out in `apps/web` and again in `apps/mobile`, and one of
 * the copies was WRONG IN A WAY THAT BROKE A WHOLE PRODUCT: the web's crypto
 * screen sent `TRON`, `ETHEREUM` and `BITCOIN`, while the API's schema is
 * `z.enum(['bitcoin','ethereum','tron','bsc'])`. Zod is case-sensitive, so
 * every deposit address, every fee quote and every withdrawal attempted from a
 * browser was refused with `400 invalid_request` on the `network` field —
 * which the customer reads as "Some details are missing or invalid", pointing
 * at a form they filled in correctly.
 *
 * Proved against a running API rather than by reading: `TRON` answers 400,
 * `tron` answers `409 kyc_required`, which is the request being VALID and
 * refused for the right business reason.
 *
 * The web was also missing BSC entirely, which the API has always accepted.
 *
 * `crypto-networks.test.ts` in `apps/api` compares this file against that zod
 * enum in both directions and fails the build on a mismatch.
 */

/** Exactly the API's `NETWORKS`, in `apps/api/src/crypto/dto.ts`. */
export const CRYPTO_NETWORKS = ['bitcoin', 'ethereum', 'tron', 'bsc'] as const;
export type CryptoNetworkCode = (typeof CRYPTO_NETWORKS)[number];

/** Exactly the API's `ASSETS`. */
export const CRYPTO_ASSETS = ['BTC', 'USDT', 'USDC'] as const;
export type CryptoAssetCode = (typeof CRYPTO_ASSETS)[number];

/**
 * The asset/network pairs a customer can pick, with the wording they read.
 *
 * A pair rather than two independent pickers, because most combinations do not
 * exist — there is no Bitcoin on Tron — and a screen that let somebody choose
 * one would generate an address for a chain nothing watches.
 */
export interface CryptoPair {
  readonly asset: CryptoAssetCode;
  readonly network: CryptoNetworkCode;
  readonly label: string;
}

/* `as const satisfies` rather than a plain annotation: the repo compiles with
 * `noUncheckedIndexedAccess`, so indexing a `readonly T[]` yields `T |
 * undefined` and every screen would need a null check for a list it wrote
 * itself. A tuple keeps `PAIRS[0]` exact while `satisfies` still checks every
 * entry against the shape. */
export const CRYPTO_PAIRS = [
  { asset: 'USDT', network: 'tron', label: 'USDT on Tron (TRC-20)' },
  { asset: 'USDT', network: 'ethereum', label: 'USDT on Ethereum (ERC-20)' },
  { asset: 'USDT', network: 'bsc', label: 'USDT on BNB Chain (BEP-20)' },
  // USDC on the same three chains. The address FORMATS are the chain's, not
  // the token's — an ERC-20 USDC address is an Ethereum address — so
  // `address.ts` needs nothing new: it validates per network and has since
  // Phase 9.
  { asset: 'USDC', network: 'tron', label: 'USDC on Tron (TRC-20)' },
  { asset: 'USDC', network: 'ethereum', label: 'USDC on Ethereum (ERC-20)' },
  { asset: 'USDC', network: 'bsc', label: 'USDC on BNB Chain (BEP-20)' },
  { asset: 'BTC', network: 'bitcoin', label: 'Bitcoin' },
] as const satisfies readonly CryptoPair[];

/**
 * The five things a customer can buy, and what each calls its target.
 *
 * They differ only in the label on one field and the keyboard it wants. The
 * MONEY QUESTION does not differ at all, which is why the API has one endpoint
 * and both apps have one form.
 */
export interface PurchaseService {
  readonly code: 'airtime' | 'data' | 'electricity' | 'esim' | 'number';
  readonly label: string;
  /** What the recipient field is called, in the customer's words. */
  readonly target: string;
  /** Which keyboard to raise for it. */
  readonly mode: 'tel' | 'numeric' | 'email' | 'text';
}

export const PURCHASE_SERVICES = [
  { code: 'airtime', label: 'Airtime', target: 'Phone number', mode: 'tel' },
  { code: 'data', label: 'Data', target: 'Phone number', mode: 'tel' },
  { code: 'electricity', label: 'Electricity', target: 'Meter number', mode: 'numeric' },
  { code: 'esim', label: 'eSIM', target: 'Email for the QR code', mode: 'email' },
  { code: 'number', label: 'Virtual number', target: 'Country code', mode: 'text' },
] as const satisfies readonly PurchaseService[];

/**
 * WHAT A CUSTOMER MAY SEND, in both apps, in one list.
 *
 * The transfer form used to derive its options from the customer's BALANCES,
 * which reads as sensible and is not: a balance list is what they hold, and
 * the options should be what they may send. A customer holding only naira was
 * offered only naira, so the currency picker had exactly one entry and looked
 * broken; and any currency that happened to appear in a balance — a gift card
 * payout, a currency an operator had retired — became a transfer option
 * nothing had decided to offer.
 *
 * GIFT CARDS ARE DELIBERATELY ABSENT. Selling one is not sending money to
 * somebody: it is an offer we review and pay out for, with its own screen and
 * its own hold. Listing it beside four currencies would put two unrelated
 * actions behind one control.
 *
 * `wallet-currencies.test.ts` fails the build if this and the API's
 * `TRANSFER_CURRENCIES` disagree, in either direction — a currency here the
 * API refuses is a form that 400s on a field the customer filled in
 * correctly, which is the exact failure the `TRON` casing bug produced.
 */
export const TRANSFER_CURRENCIES = ['NGN', 'USD', 'USDT', 'USDC'] as const;
export type TransferCurrency = (typeof TRANSFER_CURRENCIES)[number];

/**
 * How a customer narrows their activity, as one horizontal rail.
 *
 * FOUR OF THE FIVE ARE CURRENCIES AND ONE IS NOT, which is why this is a list
 * of objects rather than a list of codes. Gift cards settle in NAIRA — the
 * payout is an ordinary naira entry — so "Gift" cannot be a currency the
 * history endpoint is asked for. It is the same naira history narrowed to the
 * two entry kinds a gift card produces.
 *
 * Collapsing that into `currency=GIFT` would mean either a currency the money
 * primitives do not know, or a special case inside the ledger's history
 * query. Both are worse than saying plainly that one of these five filters
 * asks a different question.
 *
 * "Gift" rather than "Gift Card": five labels have to sit on one line on a
 * phone, and the longer wording is what pushes the rail into wrapping or
 * scrolling.
 */
export interface ActivityFilter {
  /** Stable id for the selected state — never shown. */
  readonly id: string;
  readonly label: string;
  /** The wallet whose history is read. */
  readonly currency: string;
  /** Absent means every kind. */
  readonly kinds?: readonly string[];
}

export const ACTIVITY_FILTERS = [
  { id: 'NGN', label: 'NGN', currency: 'NGN' },
  { id: 'USD', label: 'USD', currency: 'USD' },
  { id: 'USDT', label: 'USDT', currency: 'USDT' },
  { id: 'USDC', label: 'USDC', currency: 'USDC' },
  {
    id: 'gift',
    label: 'Gift',
    currency: 'NGN',
    kinds: ['giftcard_purchase', 'giftcard_hold_release'],
  },
] as const satisfies readonly ActivityFilter[];
