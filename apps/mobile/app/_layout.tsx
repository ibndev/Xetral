import { useEffect, useState } from 'react';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useFonts } from 'expo-font';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import * as SystemUI from 'expo-system-ui';
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

  /*
   * THE BRAND FACES WERE NEVER LOADED.
   *
   * `theme.ts` sets `fontFamily: 'BricolageGrotesque'` on every heading and
   * `'SplineSansMono'` on every amount, and its comment said they were "loaded
   * by `_layout.tsx` through `expo-font`". They were not: the package was not a
   * dependency, no font file existed under `apps/mobile`, and nothing called
   * `useFonts`. An unregistered family name does not error on either platform —
   * it silently falls back to the system face — so the whole app rendered in
   * Roboto while the code said otherwise, which is the shape of comment this
   * codebase keeps having to correct.
   *
   * The files are the WEB'S OWN, converted from woff2 to ttf because React
   * Native cannot read woff2. Same three faces, so a customer on a laptop and
   * the same customer on a bus are looking at one product.
   *
   * THE KEYS ARE WHAT `fontFamily` MATCHES, not the family name inside the
   * file — Bricolage's internal name is "Bricolage Grotesque 96pt ExtraBold",
   * which nothing here would ever guess.
   */
  const [fontsLoaded, fontError] = useFonts({
    BricolageGrotesque: require('../assets/fonts/BricolageGrotesque.ttf'),
    InstrumentSans: require('../assets/fonts/InstrumentSans.ttf'),
    SplineSansMono: require('../assets/fonts/SplineSansMono.ttf'),
  });

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

  /*
   * `|| fontError !== null` IS THE IMPORTANT HALF. Waiting only on `loaded`
   * means a font that fails to decode on some device leaves that customer
   * looking at a blank screen for ever — a worse outcome than the wrong
   * typeface, and one only they would ever see. A failure falls through to the
   * system face, which is exactly what the app rendered before today.
   */
  if (!fontsLoaded && fontError === null) return null;

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

  /*
   * THE WINDOW ITSELF, not just the views drawn on it.
   *
   * Behind every React view is the Android window background, and it comes
   * from the generated theme XML — which is WHITE, because nothing here ever
   * said otherwise. That shows up in three places a customer sees and no test
   * can: for one frame on cold start before the first view paints, behind the
   * screen during a navigation transition, and under the system bars, since
   * SDK 54 is edge-to-edge and the bars are transparent by design. On the
   * dark theme all three are a white flash or a white band.
   *
   * `expo-navigation-bar` is deliberately NOT used for this. Under the
   * edge-to-edge that Android 15 enforces, its colour setter is a no-op: the
   * platform draws a transparent bar and expects the APP to draw behind it.
   * The right fix is therefore this window colour plus each screen extending
   * its own background under the insets, which `Shell` does — not a native
   * module that would add build risk to change nothing.
   *
   * Fire-and-forget: it returns a promise and a window background that failed
   * to apply must not stop the app rendering.
   */
  useEffect(() => {
    void SystemUI.setBackgroundColorAsync(colors.bg).catch(() => undefined);
  }, [colors.bg]);

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
