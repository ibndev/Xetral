import * as LocalAuthentication from 'expo-local-authentication';
import * as SecureStore from 'expo-secure-store';

/**
 * Biometric unlock.
 *
 * READ THIS BEFORE CHANGING ANYTHING HERE. Face ID does not authorise a
 * transfer and is not a second factor for one. What it does is UNLOCK THE PIN:
 * the customer's real transaction PIN is stored in the Keychain behind the
 * OS's biometric gate, and a successful scan hands it back so the app can send
 * it to the server exactly as if it had been typed.
 *
 * The server is unchanged by any of this. It receives a PIN, verifies it
 * against the scrypt hash, and counts a wrong one toward the five-attempt
 * lockout. There is no endpoint that accepts "the user passed Face ID" in
 * place of a PIN, and `002_identity.sql` enforces the same thing from the
 * other side: enrolment is refused for a user with no PIN, by trigger.
 *
 * Why that division matters. Face ID proves the phone is being held by
 * somebody whose face it knows. On a device where a family member's face is
 * also enrolled, it does not even prove that much — and it never proves the
 * holder meant to send money. Treating it as the whole check would make the
 * customer's savings a property of who has handled their phone.
 */

/** The PIN, stored behind the OS gate. Never in plain SecureStore. */
const PIN_KEY = 'xetral.pin.biometric';

/**
 * `requireAuthentication` is what makes this safe.
 *
 * It tells the Keychain/Keystore to refuse the value until the OS has
 * authenticated the user — Face ID, Touch ID, or the device passcode. Without
 * it the PIN would sit in the app's sandbox readable by anything that could
 * read the sandbox, which is strictly worse than not storing it at all.
 */
const GATED: SecureStore.SecureStoreOptions = {
  requireAuthentication: true,
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  authenticationPrompt: 'Unlock your transaction PIN',
};

export type BiometricKind = 'face' | 'fingerprint' | 'iris' | 'other';

export type BiometricSupport =
  | { readonly available: true; readonly kind: BiometricKind }
  | { readonly available: false; readonly reason: 'no_hardware' | 'not_enrolled' };

/**
 * Can this device do it at all?
 *
 * Both halves are checked. Hardware without an enrolled face or finger is a
 * sensor nobody has registered with, and `requireAuthentication` would fail at
 * write time — better to tell the customer why than to show them a switch that
 * throws.
 */
export async function biometricSupport(): Promise<BiometricSupport> {
  if (!(await LocalAuthentication.hasHardwareAsync())) {
    return { available: false, reason: 'no_hardware' };
  }
  if (!(await LocalAuthentication.isEnrolledAsync())) {
    return { available: false, reason: 'not_enrolled' };
  }

  const types = await LocalAuthentication.supportedAuthenticationTypesAsync();
  if (types.includes(LocalAuthentication.AuthenticationType.FACIAL_RECOGNITION)) {
    return { available: true, kind: 'face' };
  }
  if (types.includes(LocalAuthentication.AuthenticationType.FINGERPRINT)) {
    return { available: true, kind: 'fingerprint' };
  }
  if (types.includes(LocalAuthentication.AuthenticationType.IRIS)) {
    return { available: true, kind: 'iris' };
  }
  return { available: true, kind: 'other' };
}

export function biometricName(kind: BiometricKind): string {
  switch (kind) {
    case 'face':
      return 'Face ID';
    case 'fingerprint':
      return 'fingerprint';
    case 'iris':
      return 'iris scan';
    default:
      return 'biometrics';
  }
}

/** Is a PIN currently stored behind the gate on this device? */
export async function isEnrolled(): Promise<boolean> {
  try {
    // Deliberately does NOT read the value: that would prompt for a face
    // every time a screen wanted to know whether to show a button.
    return (await SecureStore.getItemAsync(`${PIN_KEY}.marker`)) !== null;
  } catch {
    return false;
  }
}

/**
 * Stores the PIN behind the biometric gate.
 *
 * The caller must have CONFIRMED the PIN with the server first. Storing an
 * unverified one means the customer discovers the mistake on a real transfer,
 * which spends one of their five attempts on a request they did not intend to
 * make — and after five, locks them out of their own money for fifteen
 * minutes.
 */
export async function enrol(pin: string): Promise<void> {
  await SecureStore.setItemAsync(PIN_KEY, pin, GATED);
  // A separate, ungated marker so `isEnrolled()` can answer without a prompt.
  // It holds no secret — only the fact that one exists.
  await SecureStore.setItemAsync(`${PIN_KEY}.marker`, '1');
}

export type UnlockResult =
  | { readonly ok: true; readonly pin: string }
  | { readonly ok: false; readonly reason: 'cancelled' | 'unavailable' };

/**
 * Prompts for a face or finger and returns the PIN.
 *
 * The prompt is the OS's, not ours — the app never sees the biometric data,
 * only whether the Keychain agreed to hand the value back.
 *
 * A cancellation is NOT an error. Customers dismiss the sheet to type the PIN
 * instead, and every screen that calls this keeps the manual entry path
 * available for exactly that reason.
 */
export async function unlock(): Promise<UnlockResult> {
  try {
    const pin = await SecureStore.getItemAsync(PIN_KEY, GATED);
    if (pin === null) return { ok: false, reason: 'unavailable' };
    return { ok: true, pin };
  } catch {
    // SecureStore throws when the user dismisses the prompt or fails the
    // check. There is nothing to distinguish and nothing to report: they can
    // type the PIN.
    return { ok: false, reason: 'cancelled' };
  }
}

/**
 * Forgets the stored PIN.
 *
 * Called on sign-out and whenever the PIN changes. A stale copy is worse than
 * none: it fails on a real transfer and burns an attempt, and if the PIN was
 * changed because the customer thought it was compromised, the old one sitting
 * on the device is the opposite of what they asked for.
 */
export async function forget(): Promise<void> {
  await SecureStore.deleteItemAsync(PIN_KEY, GATED).catch(() => undefined);
  await SecureStore.deleteItemAsync(`${PIN_KEY}.marker`).catch(() => undefined);
}
