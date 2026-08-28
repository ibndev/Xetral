import { useEffect, useRef, useState } from 'react';
import { AppState, Platform, View } from 'react-native';
import type { AppStateStatus } from 'react-native';
import * as ScreenCapture from 'expo-screen-capture';
import { useTheme } from '@/theme';

/**
 * Keeps a balance off the app switcher and out of a screenshot.
 *
 * WHAT THE OS DOES WITHOUT THIS. When the app is backgrounded, both platforms
 * take a picture of whatever is on screen and WRITE IT TO DISK, so the switcher
 * has something to show. For this app that picture is a customer's balance and
 * their recent transactions, and it survives in a cache directory that any
 * process reading the device's storage — a backup, a forensic tool, whoever
 * picks the phone up — can reach without ever unlocking the app.
 *
 * THE TWO PLATFORMS NEED DIFFERENT ANSWERS, and pretending otherwise is how
 * one of them ends up unprotected:
 *
 *   ANDROID can be told properly. `preventScreenCaptureAsync` sets
 *   FLAG_SECURE, which blocks screenshots, blocks screen recording, and makes
 *   the switcher render a blank card instead of the snapshot. One call covers
 *   all three.
 *
 *   IOS CANNOT BLOCK A SCREENSHOT AT ALL — there is no API, by Apple's
 *   deliberate design, and any library claiming otherwise is detecting one
 *   after the fact. What it can do is control what is on screen at the moment
 *   the snapshot is taken, which is why this covers the UI when the app leaves
 *   the foreground rather than when it is already gone. `inactive` is the
 *   state that matters: it arrives BEFORE `background`, and it is also what
 *   the app switcher itself triggers.
 *
 * A DELIBERATE SCREENSHOT ON IOS IS STILL POSSIBLE, and the customer taking it
 * is not the threat this addresses. The threat is the copy nobody chose to
 * make.
 */
export function ScreenPrivacy({ children }: { children: React.ReactNode }): React.ReactElement {
  const colors = useTheme();
  const [covered, setCovered] = useState(false);
  const state = useRef<AppStateStatus>(AppState.currentState);

  useEffect(() => {
    /*
     * Android only. On iOS this resolves and does nothing, which would be a
     * false sense of protection if the cover below did not exist — so the
     * platform check is here to make the asymmetry visible in the code rather
     * than buried in a library's behaviour.
     */
    if (Platform.OS === 'android') {
      void ScreenCapture.preventScreenCaptureAsync();
    }

    const subscription = AppState.addEventListener('change', (next) => {
      // `inactive` is the one that matters and the one that is easy to miss:
      // it is what the app switcher triggers, and it arrives before
      // `background`. Waiting for `background` covers the screen after the
      // picture has been taken.
      setCovered(next !== 'active');
      state.current = next;
    });

    return () => {
      subscription.remove();
      if (Platform.OS === 'android') {
        void ScreenCapture.allowScreenCaptureAsync();
      }
    };
  }, []);

  return (
    <View style={{ flex: 1 }}>
      {children}
      {covered && (
        /*
         * An opaque cover rather than a blur. A blur of a balance is still a
         * picture of the shape of a balance, and the number of digits is
         * exactly what somebody glancing at a switcher would read.
         *
         * `pointerEvents="none"` so this can never swallow a tap: a cover that
         * outlived its state would otherwise make the app inert, which is the
         * failure mode that looks like a crash and is not one.
         */
        <View
          pointerEvents="none"
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: colors.bg,
          }}
        />
      )}
    </View>
  );
}
