import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { colors } from '@/theme';

export default function Layout() {
  return (
    <>
      <StatusBar style="light" />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: colors.panel },
          headerTintColor: colors.text,
          contentStyle: { backgroundColor: colors.bg },
        }}
      >
        <Stack.Screen name="index" options={{ title: 'Xetral' }} />
        <Stack.Screen name="signin" options={{ title: 'Sign in' }} />
        <Stack.Screen name="wallet" options={{ title: 'Wallet' }} />
        <Stack.Screen name="transfer" options={{ title: 'Send money' }} />
        <Stack.Screen name="add-money" options={{ title: 'Add money' }} />
      </Stack>
    </>
  );
}
