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
export const CRYPTO_ASSETS = ['BTC', 'USDT'] as const;
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
