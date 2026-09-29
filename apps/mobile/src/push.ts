import { Platform } from 'react-native';
import Constants from 'expo-constants';
import * as Notifications from 'expo-notifications';
import * as SecureStore from 'expo-secure-store';
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
    /*
     * PERMISSION AND THE CHANNEL COME FIRST, WHATEVER THE BUILD CAN DO. They
     * were behind the projectId check, so a build without one never asked —
     * and then not even a LOCAL notification could reach the status bar,
     * because Android 13 shows none without the permission and Android 8
     * shows none without a channel. Announcements are shown locally when the
     * app opens (`notifyNewAnnouncements`); only the push TOKEN needs EAS.
     */
    if (!(await notificationsAllowed())) return;

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
 * Whether this app may put something in the status bar — asking once if the
 * customer has not decided, and making the Android channel exist.
 */
async function notificationsAllowed(): Promise<boolean> {
  const existing = await Notifications.getPermissionsAsync();
  // ASKED ONLY IF NOT ALREADY DECIDED. Re-requesting a denied permission does
  // nothing on either platform and is not a way to change somebody's mind; it
  // just returns denied again.
  const granted =
    existing.granted ||
    (existing.canAskAgain && (await Notifications.requestPermissionsAsync()).granted);
  if (!granted) return false;

  if (Platform.OS === 'android') {
    // Android 8+ refuses to show a notification with no channel, silently.
    // The default channel has to exist before the first one arrives.
    await Notifications.setNotificationChannelAsync('default', {
      name: 'Xetral',
      importance: Notifications.AndroidImportance.DEFAULT,
      lightColor: '#0D1B3E',
    });
  }
  return true;
}

/*
 * SHOWN EVEN WHILE THE APP IS OPEN. Without a handler the OS drops a
 * notification that arrives in the foreground, and the announcement a
 * customer is told about on opening the app is exactly that case.
 */
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: false,
    shouldSetBadge: false,
  }),
});

/**
 * PUTS NEW ANNOUNCEMENTS IN THE STATUS BAR, from the feed, with no push
 * service involved.
 *
 * Real push needs an EAS project and FCM credentials, which only the owner's
 * accounts can mint — until then no handset has a token and every broadcast
 * reaches "no phones". This is the half that needs neither: whenever the app
 * opens or comes back to the foreground it reads the feed, and anything newer
 * than the last announcement it NOTIFIED about is raised as a local
 * notification with the app's icon. A closed app is not woken — that is what
 * push is for — so the owner's two steps still matter.
 *
 * A SEPARATE MARKER FROM "SEEN". Seen means the bell's feed was opened;
 * notified means the status bar was told. Sharing one would either repeat a
 * notification the customer dismissed or skip one they never read. The first
 * run records the newest WITHOUT notifying, so installing the app does not
 * replay a month of announcements at once.
 */
export async function notifyNewAnnouncements(
  items: readonly { readonly uuid: string; readonly title: string; readonly body: string; readonly at: string }[],
): Promise<void> {
  try {
    const newest = items.reduce<string | undefined>((max, item) => (max === undefined || item.at > max ? item.at : max), undefined);
    if (newest === undefined) return;
    const notified = await SecureStore.getItemAsync(NOTIFIED_KEY).catch(() => null);
    await SecureStore.setItemAsync(NOTIFIED_KEY, newest).catch(() => undefined);
    if (notified === null) return;

    const fresh = items.filter((item) => item.at > notified).slice(0, 3);
    if (fresh.length === 0) return;
    const permission = await Notifications.getPermissionsAsync();
    if (!permission.granted) return;
    for (const item of fresh) {
      await Notifications.scheduleNotificationAsync({
        content: { title: item.title, body: item.body, data: { route: '/notifications' } },
        trigger: null,
      });
    }
  } catch {
    // A notification that could not be raised is still in the bell's feed.
  }
}

const NOTIFIED_KEY = 'xetral.announcements.notified';

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
