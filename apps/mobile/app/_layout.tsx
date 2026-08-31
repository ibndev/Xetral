import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useTheme } from '@/theme';
import { ScreenPrivacy } from '@/screen-privacy';

export default function Layout() {
  const colors = useTheme();
  return (
    /*
     * WRAPS EVERYTHING, deliberately. Applying this per screen means the one
     * screen somebody adds without it is the one that leaks — and the screens
     * worth protecting are the ordinary ones: a wallet balance in the app
     * switcher is the picture nobody chose to take.
     */
    <ScreenPrivacy>
      <StatusBar style="light" />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: colors.surface },
          headerTintColor: colors.text,
          contentStyle: { backgroundColor: colors.bg },
        }}
      >
        <Stack.Screen name="index" options={{ title: 'Xetral' }} />
        <Stack.Screen name="signin" options={{ title: 'Sign in' }} />
        <Stack.Screen name="signup" options={{ title: 'Create account' }} />
        <Stack.Screen name="wallet" options={{ title: 'Wallet' }} />
        <Stack.Screen name="transfer" options={{ title: 'Send money' }} />
        <Stack.Screen name="add-money" options={{ title: 'Add money' }} />
        <Stack.Screen name="security" options={{ title: 'Security' }} />
      </Stack>
    </ScreenPrivacy>
  );
}
