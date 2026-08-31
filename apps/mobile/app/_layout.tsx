import { useEffect, useState } from 'react';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ThemeChoiceContext, isThemeChoice, useResolvedScheme, useTheme } from '@/theme';
import type { ThemeChoice } from '@/theme';
import { ScreenPrivacy } from '@/screen-privacy';
import { THEME_CHOICE, readPreference, writePreference } from '@/preferences';

export default function Layout() {
  /*
   * THE THEME CHOICE LIVES HERE, above every screen.
   *
   * It defaults to `system` and is replaced once storage answers. The store is
   * async, so the first frame is always the device's own scheme — which is the
   * right thing to be wrong about: a customer who has never touched the toggle
   * gets exactly what they had before, and one who has gets a single frame of
   * the other palette rather than a flash of the wrong content.
   */
  const [choice, setChoice] = useState<ThemeChoice>('system');

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const stored = await readPreference(THEME_CHOICE);
      if (!cancelled && stored !== undefined && isThemeChoice(stored)) setChoice(stored);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  function set(next: ThemeChoice) {
    setChoice(next);
    void writePreference(THEME_CHOICE, next);
  }

  return (
    <SafeAreaProvider>
      <ThemeChoiceContext.Provider value={{ choice, set }}>
        {/*
         * WRAPS EVERYTHING, deliberately. Applying this per screen means the
         * one screen somebody adds without it is the one that leaks — and the
         * screens worth protecting are the ordinary ones: a wallet balance in
         * the app switcher is the picture nobody chose to take.
         */}
        <ScreenPrivacy>
          <Chrome />
        </ScreenPrivacy>
      </ThemeChoiceContext.Provider>
    </SafeAreaProvider>
  );
}

/**
 * Split out so it renders INSIDE the provider.
 *
 * `useTheme` reads the context, and a component that provides a context cannot
 * consume it in the same render — the header would have been painted from the
 * default palette while every screen under it used the chosen one.
 */
function Chrome() {
  const colors = useTheme();
  const scheme = useResolvedScheme();

  return (
    <>
      {/* Follows the palette rather than being pinned to `light`: white status
          text on the white header is invisible, which is what a hardcoded
          style gave the light theme. */}
      <StatusBar style={scheme === 'dark' ? 'light' : 'dark'} />
      <Stack
        screenOptions={{
          // Every signed-in screen draws its own header through `Shell`, so
          // the navigator's is off. Two headers is what you get otherwise.
          headerShown: false,
          contentStyle: { backgroundColor: colors.bg },
        }}
      >
        <Stack.Screen name="index" />
        <Stack.Screen name="signin" options={{ headerShown: true, title: 'Sign in' }} />
        <Stack.Screen name="signup" options={{ headerShown: true, title: 'Create account' }} />
        <Stack.Screen name="wallet" />
        <Stack.Screen name="cards" />
        <Stack.Screen name="activity" />
        <Stack.Screen name="more" />
        <Stack.Screen name="transfer" />
        <Stack.Screen name="add-money" />
        <Stack.Screen name="bills" />
        <Stack.Screen name="fx" />
        <Stack.Screen name="crypto" />
        <Stack.Screen name="kyc" />
        <Stack.Screen name="settings" />
        <Stack.Screen name="security" />
      </Stack>
    </>
  );
}
