import { ProviderNotSentError } from './errors.js';

/**
 * A credential, as an adapter receives it: a value, or a way to ask for one.
 *
 * THE FUNCTION FORM IS WHAT MAKES `/admin/credentials` REAL. The database is
 * authoritative and the environment is the fallback (026), so a key pasted on
 * the dashboard has to reach the adapter on the NEXT request — which a string
 * captured at boot never can. VTpass, Airalo and Twilio took strings from the
 * environment alone, so their slots on that screen accepted a key, showed its
 * hint, and were read by nothing: 026's "a credential nothing reads is one an
 * operator believes is live", in the three adapters that predate the rule.
 *
 * Bitnob, Paystack and Flutterwave each declare the same shape under their own
 * name; this is the one the fulfilment adapters share.
 */
export type SecretSource = string | (() => Promise<string | undefined>);

/**
 * Resolve a credential or refuse BEFORE anything is sent.
 *
 * `ProviderNotSentError` is the definite answer — nothing left this process —
 * so a purchase refused for a missing key is reversed rather than held, and
 * the message names where the key goes rather than reading as an outage.
 */
export async function requireSecret(
  provider: string,
  source: SecretSource,
  label: string,
): Promise<string> {
  const value = typeof source === 'string' ? source : await source();
  if (value === undefined || value === '') {
    throw new ProviderNotSentError(
      provider,
      `no ${label} is configured. Paste one on the Provider keys screen ` +
        `(/admin/credentials) or set it in the environment.`,
    );
  }
  return value;
}
