import { Platform } from 'react-native';
import Constants from 'expo-constants';
import * as Notifications from 'expo-notifications';
import { xetral } from './session';

/**
 * REGISTERING THIS HANDSET AS AN ADDRESS.
 *
 * A push token identifies one installation of this app on one phone. Holding
 * it lets its holder send a notification to that handset and nothing else: it
 * reads nothing, authorises nothing, and stops working the moment the app is
 * uninstalled. That is why 065 stores it in the clear under a shape CHECK
 * rather than as a hash, and why registering it takes no transaction PIN.
 *
 * IT IS NOT ASKED FOR AT SIGN-UP. The permission prompt is the OS's and can
 * only be answered once — a customer who refuses it while they are still
 * working out what this app is has refused it for good, from their point of
 * view. So it is requested after they are signed in and have something to be
 * notified about.
 *
 * `projectId` IS REQUIRED AND CANNOT BE INVENTED. Since SDK 49 Expo mints a
 * token against a specific EAS project, and a token minted against the wrong
 * one is delivered to somebody else's app or to nothing at all — silently, in
 * both directions. So an absent one REFUSES rather than guessing: an operator
 * runs `eas init`, which writes `extra.eas.projectId`, and the same build then
 * works. The failure this avoids is the worst kind here — a token that looks
 * valid, is stored, and never delivers.
 */
export function pushProjectId(): string | undefined {
  const extra = Constants.expoConfig?.extra as { eas?: { projectId?: unknown } } | undefined;
  const id = extra?.eas?.projectId;
  return typeof id === 'string' && id !== '' ? id : undefined;
}

/**
 * Asks the OS, mints a token and tells the server about it.
 *
 * EVERY FAILURE IS SWALLOWED. Not being reachable by notification is not a
 * reason for a sign-in to fail, for a screen to show an error, or for anything
 * a customer is doing to stop — the same argument the provider-health recorder
 * makes about never failing the call it records.
 */
export async function registerForPush(): Promise<void> {
  try {
    const projectId = pushProjectId();
    if (projectId === undefined) {
      // Deliberately quiet on the screen and loud in the log: this is an
      // operator's missing value, not something a customer can act on.
      console.warn(
        'push notifications are off: this build has no EAS projectId, so no ' +
          'token can be minted. Run `eas init` and rebuild.',
      );
      return;
    }

    const existing = await Notifications.getPermissionsAsync();
    // ASKED ONLY IF NOT ALREADY DECIDED. Re-requesting a denied permission
    // does nothing on either platform and is not a way to change somebody's
    // mind; it just returns denied again.
    const granted =
      existing.granted ||
      (existing.canAskAgain && (await Notifications.requestPermissionsAsync()).granted);
    if (!granted) return;

    if (Platform.OS === 'android') {
      // Android 8+ refuses to show a notification with no channel, silently.
      // The default channel has to exist before the first one arrives.
      await Notifications.setNotificationChannelAsync('default', {
        name: 'Xetral',
        importance: Notifications.AndroidImportance.DEFAULT,
      });
    }

    const token = await Notifications.getExpoPushTokenAsync({ projectId });
    await xetral().client.registerPushDevice(
      token.data,
      Platform.OS === 'ios' ? 'ios' : 'android',
    );
  } catch (error: unknown) {
    console.warn(`push registration failed and was ignored: ${String(error)}`);
  }
}

/**
 * Retires this handset — part of signing out.
 *
 * FOR THE REASON THE PIN IS FORGOTTEN ON SIGN-OUT: a phone somebody hands over
 * must stop showing the previous account's notifications on its lock screen.
 * Swallowed like the rest, and ordered so a failed request cannot stop the
 * sign-out itself.
 */
export async function unregisterFromPush(): Promise<void> {
  try {
    const projectId = pushProjectId();
    if (projectId === undefined) return;
    const token = await Notifications.getExpoPushTokenAsync({ projectId });
    await xetral().client.revokePushDevice(token.data);
  } catch {
    // Nothing to do. The token is also retired by the push service itself the
    // moment the app is uninstalled, which is the case this cannot cover.
  }
}
