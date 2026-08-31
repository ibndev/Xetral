import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';

/**
 * What this install tells the server about itself.
 *
 * SHARED BY SIGN-IN AND SIGN-UP rather than copied into each, because the two
 * screens must describe the same device the same way. A fingerprint that
 * differed between registering and signing in would make the account's very
 * first sign-in look like one from new hardware, and the new-device alert —
 * which exists to tell a customer somebody else got in — would fire on the
 * customer themselves, on day one. An alert that is wrong the first time it
 * fires is one nobody reads the second time.
 */

/**
 * THE PLATFORM IS READ, NOT ASSUMED.
 *
 * `signin.tsx` had `platform: 'ios'` written into it as a literal, so every
 * Android sign-in was recorded as an iPhone. Nothing failed: the API stores
 * whatever it is told, and the string only surfaces later — in a customer's
 * device list, and in the alert email that says which device just signed in.
 * A customer checking whether the sign-in from "iOS" was theirs, on an
 * Android phone, is being actively misled by the one screen meant to help
 * them notice a takeover.
 */
export function devicePlatform(): string {
  // `Platform.OS` is 'ios' | 'android' | 'web' | … — the value the device
  // actually reports, never a guess about which build this is.
  return Platform.OS;
}

const FINGERPRINT_KEY = 'xetral.device';

/**
 * A per-install identifier the server binds sessions to.
 *
 * Kept in the Keychain with everything else, so it survives an app update but
 * NOT a reinstall — which is the behaviour that matters: a reinstalled app is
 * a device the customer should be asked about again, and a fingerprint that
 * outlived the app's own storage would quietly stop being evidence of
 * anything.
 */
export async function deviceFingerprint(): Promise<string> {
  const held = await SecureStore.getItemAsync(FINGERPRINT_KEY);
  if (held !== null) return held;

  const created = `${Date.now()}-${Math.random().toString(36).slice(2)}-${devicePlatform()}`;
  await SecureStore.setItemAsync(FINGERPRINT_KEY, created);
  return created;
}

/** Everything the auth endpoints want to know about this install. */
export async function deviceDescriptor(): Promise<{
  fingerprint: string;
  platform: string;
}> {
  return { fingerprint: await deviceFingerprint(), platform: devicePlatform() };
}
