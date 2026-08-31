import * as SecureStore from 'expo-secure-store';

/**
 * A preference this device remembers.
 *
 * SecureStore rather than AsyncStorage, and NOT because a preference is a
 * secret. It is the storage this app already ships — adding AsyncStorage would
 * mean a new native dependency, a new entry in every build, and a second place
 * to reason about, for one string. The keychain will hold a string that does
 * not need protecting perfectly well.
 *
 * `AFTER_FIRST_UNLOCK` and not `WHEN_UNLOCKED_THIS_DEVICE_ONLY`, which is what
 * `session.ts` uses for tokens. That is the point of keeping them apart: a
 * token must be unreadable while the phone is locked and must never survive a
 * restore onto different hardware. A display preference has neither
 * requirement, and borrowing the stricter class for it would mean the app
 * cannot read its own settings during a background refresh.
 */
const OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK,
};

export async function readPreference(key: string): Promise<string | undefined> {
  try {
    return (await SecureStore.getItemAsync(key, OPTIONS)) ?? undefined;
  } catch {
    // A device that refuses storage still gets a working app on the default.
    return undefined;
  }
}

export async function writePreference(key: string, value: string): Promise<void> {
  try {
    await SecureStore.setItemAsync(key, value, OPTIONS);
  } catch {
    // The choice applies for this run; it simply is not remembered.
  }
}

/** Whether the balance is masked. See the wallet screen. */
export const BALANCE_VISIBILITY = 'xetral.balance-visibility';

/** `light`, `dark` or `system`. The web keeps the same choice in
 *  `localStorage` under `xetral-theme`; the two apps are separate installs
 *  with separate storage, so a customer sets it once per device. */
export const THEME_CHOICE = 'xetral.theme';
