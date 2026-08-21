import * as SecureStore from 'expo-secure-store';
import Constants from 'expo-constants';
import { Session, XetralClient } from '@xetral/client';
import type { Tokens, TokenStore } from '@xetral/client';

/**
 * Tokens on a phone go in the KEYCHAIN, not AsyncStorage.
 *
 * AsyncStorage is an unencrypted file in the app's sandbox. On a rooted or
 * jailbroken device — or off a backup — it is readable, and a refresh token
 * read out of one is a month of somebody else's session. SecureStore is the
 * iOS Keychain and the Android Keystore, which is where a long-lived
 * credential belongs.
 *
 * `WHEN_UNLOCKED_THIS_DEVICE_ONLY` is deliberate on both counts: not readable
 * while the phone is locked, and never carried to a new device by an iCloud
 * backup — a restored backup should require signing in, not silently resurrect
 * a session on hardware the customer may no longer own.
 */
const ACCESS = 'xetral.access';
const REFRESH = 'xetral.refresh';
const EXPIRES = 'xetral.expires';

const OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

export class KeychainTokenStore implements TokenStore {
  async read(): Promise<Tokens | undefined> {
    const [accessToken, refreshToken, expiresAt] = await Promise.all([
      SecureStore.getItemAsync(ACCESS, OPTIONS),
      SecureStore.getItemAsync(REFRESH, OPTIONS),
      SecureStore.getItemAsync(EXPIRES, OPTIONS),
    ]);

    if (accessToken === null || refreshToken === null || expiresAt === null) return undefined;
    return { accessToken, refreshToken, expiresAt: Number(expiresAt) };
  }

  async write(tokens: Tokens): Promise<void> {
    await Promise.all([
      SecureStore.setItemAsync(ACCESS, tokens.accessToken, OPTIONS),
      SecureStore.setItemAsync(REFRESH, tokens.refreshToken, OPTIONS),
      SecureStore.setItemAsync(EXPIRES, String(tokens.expiresAt), OPTIONS),
    ]);
  }

  async clear(): Promise<void> {
    await Promise.all([
      SecureStore.deleteItemAsync(ACCESS, OPTIONS),
      SecureStore.deleteItemAsync(REFRESH, OPTIONS),
      SecureStore.deleteItemAsync(EXPIRES, OPTIONS),
    ]);
  }
}

/**
 * Where the API is.
 *
 * `EXPO_PUBLIC_API_URL` wins, because a phone talking to a laptop needs that
 * laptop's address on the local network and that address changes with the
 * café. Editing a committed `app.json` to run the app is how somebody
 * eventually commits their home IP.
 *
 * `EXPO_PUBLIC_` is Expo's convention for values inlined into the bundle at
 * build time. Nothing secret may go in one — it ships to the device and can be
 * read out of the bundle. An API base URL is not secret; an API key would be,
 * which is why none is here.
 */
function apiUrl(): string {
  const fromEnv = process.env['EXPO_PUBLIC_API_URL'];
  if (typeof fromEnv === 'string' && fromEnv !== '') return fromEnv.replace(/\/+$/, '');

  const configured = Constants.expoConfig?.extra?.['apiUrl'];
  if (typeof configured !== 'string' || configured === '') {
    throw new Error(
      'Set EXPO_PUBLIC_API_URL to the API\'s address on your network, e.g. ' +
        'EXPO_PUBLIC_API_URL=http://192.168.1.20:3100 npx expo start',
    );
  }
  return configured.replace(/\/+$/, '');
}

let cached: { session: Session; client: XetralClient } | undefined;

/**
 * One session and one client for the whole app.
 *
 * A singleton because the single-flight refresh latch lives on the `Session`
 * instance. A screen that built its own would refresh in parallel with the
 * rest of the app — which is the exact race the latch exists to prevent, and
 * on this backend a replayed refresh token revokes the whole device family.
 */
export function xetral(onSignedOut?: () => void): { session: Session; client: XetralClient } {
  if (cached !== undefined) return cached;

  const session = new Session({
    baseUrl: apiUrl(),
    store: new KeychainTokenStore(),
    ...(onSignedOut === undefined ? {} : { onSignedOut }),
  });
  cached = { session, client: new XetralClient({ baseUrl: apiUrl(), session }) };
  return cached;
}

export function resetXetral(): void {
  cached = undefined;
}
