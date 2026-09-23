/**
 * HOW TO RECOGNISE A MOBILE MONEY NETWORK IN A PROVIDER'S OWN CATALOGUE.
 *
 * The codes this platform uses for a network — `MTN`, `VOD`, `ATL`, `MPS` —
 * are OURS, and no vendor document in this repository produces them. So an
 * adapter never sends one: it reads the provider's institution list, finds
 * the row whose NAME contains one of these terms, and sends THAT row's code.
 * A stale term costs a match and can never invent a destination.
 *
 * Shared, because two adapters read their catalogues this way and a second
 * copy is how the half nobody is looking at goes missing — the Kenya entry
 * that one table had and the other did not is the example this repository
 * already paid for.
 */
export const NETWORK_NAME_HINTS: Readonly<Record<string, readonly string[]>> = {
  MTN: ['MTN'],
  /* Vodafone Ghana is Telecel now, and their surfaces disagree about it. */
  VOD: ['VODAFONE', 'TELECEL', 'VOD'],
  /* AirtelTigo, from the Airtel and Tigo merger. */
  ATL: ['AIRTELTIGO', 'TIGO', 'AIRTEL', 'ATL'],
  /* M-PESA is Safaricom's, and their catalogue may name either. The hyphen is
     not assumed: `MPESA` is matched as well, because a name is matched by
     CONTAINMENT and "M-PESA" does not contain "MPESA". */
  MPS: ['M-PESA', 'MPESA', 'SAFARICOM', 'MPS'],
};

/** Whether a code is one of OUR network codes rather than a provider's. */
export function isOurNetworkCode(code: string): boolean {
  return Object.prototype.hasOwnProperty.call(NETWORK_NAME_HINTS, code.toUpperCase());
}
