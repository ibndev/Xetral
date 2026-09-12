/**
 * THE MOBILE MONEY NETWORKS A CUSTOMER CAN PICK, per country.
 *
 * ONE CATALOGUE FOR BOTH APPS, the way `ACTIVITY_FILTERS` is. Two hand-written
 * pickers drift into offering two different lists, and the one that drifts is
 * the one nobody opens — a customer selecting a network the payout adapter
 * does not recognise gets a transfer that fails at the provider, days later,
 * with their money already reserved.
 *
 * THE CODES ARE THE PROVIDER'S OWN, not display names: they travel on the wire
 * to Flutterwave. `momo-networks.test.ts` reads this file and
 * `FLUTTERWAVE_MOBILE_MONEY_NETWORKS` as text and fails the build on a
 * disagreement in either direction — a network offered here and refused there
 * is a picker entry that cannot be used, and one accepted there and missing
 * here is a wallet nobody can link.
 *
 * A COUNTRY THAT IS NOT HERE HAS NO LIST, and the screen shows none rather
 * than a default. Offering an MTN wallet to somebody whose money cannot reach
 * one is the failure 046 records about a Nigerian bank list in Accra.
 */
export interface MomoNetwork {
  readonly code: string;
  readonly name: string;
}

export const MOMO_NETWORKS: Readonly<Record<string, readonly MomoNetwork[]>> = {
  GH: [
    { code: 'MTN', name: 'MTN Mobile Money' },
    { code: 'VOD', name: 'Telecel Cash' },
    { code: 'ATL', name: 'AirtelTigo Money' },
  ],
  KE: [{ code: 'MPS', name: 'M-PESA' }],
};

/**
 * WHAT A NETWORK IS CALLED ON SCREEN, keyed by the code that goes on the wire.
 *
 * The catalogue name is a provider string — "MTN Mobile Money", "Telecel Cash",
 * "AirtelTigo Money". A picker is read at a glance and a row is read in
 * passing, so both show the name people actually say: MTN, TELECEL,
 * AIRTELTIGO, M-PESA. Keyed by CODE rather than derived from the name, because
 * deriving it is how "Telecel Cash (formerly Vodafone Cash)" became
 * "TELECEL FORMERLY VODAFONE".
 *
 * Anything not a mobile money network — a Nigerian bank — keeps its own name.
 */
const NETWORK_LABELS: Readonly<Record<string, string>> = {
  MTN: 'MTN',
  VOD: 'TELECEL',
  ATL: 'AIRTELTIGO',
  MPS: 'M-PESA',
};

export function networkLabel(code: string | null, fallback: string | null): string {
  if (code !== null) {
    const named = NETWORK_LABELS[code.trim().toUpperCase()];
    if (named !== undefined) return named;
  }
  return fallback ?? '';
}
