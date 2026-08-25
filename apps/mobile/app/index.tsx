import { useEffect } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { router } from 'expo-router';
import { xetral } from '@/session';
import { useTheme } from '@/theme';

/**
 * Decides where to start.
 *
 * Asking the session for a token is the check: it reads the Keychain and, if
 * the access token has expired, refreshes before answering. So a customer who
 * last opened the app a week ago lands on their wallet rather than a sign-in
 * screen, and one whose device family was revoked lands on sign-in rather than
 * on a wallet that fails to load.
 */
export default function Index() {
  const colors = useTheme();
  useEffect(() => {
    void (async () => {
      try {
        await xetral().session.accessToken();
        router.replace('/wallet');
      } catch {
        router.replace('/signin');
      }
    })();
  }, []);

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg, justifyContent: 'center' }}>
      <ActivityIndicator color={colors.accent} />
    </View>
  );
}
