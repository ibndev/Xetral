import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';

/**
 * THE APP CLOSED, AND THAT IS THE PART TO FIX FIRST.
 *
 * "I click Send money and the app exits and stops working." A React render
 * that throws has no handler above it in a RELEASE build, so React unmounts
 * the whole tree and Android is left with a blank Activity that the system
 * closes. There is no red screen the way there is in development, no message,
 * and nothing written anywhere — so a customer sees the app die and the next
 * report is "it stopped working", which names no file, no screen and no line.
 *
 * NOTHING IN THIS APP HAD A BOUNDARY AT ALL. Every worker, sweep and webhook
 * on the server has a rule about not failing the thing it was reporting on;
 * the client had no equivalent, and the one place it matters most is the
 * screen money leaves from.
 *
 * IT SHOWS THE MESSAGE, deliberately. The instinct is to say "something went
 * wrong" and keep the detail back — 006's rule about a provider's sentence
 * naming our integration. That rule is about a REFUSAL crossing a trust
 * boundary to a stranger; this is a crash on the customer's own device, in
 * their own session, and the string is a TypeError from our own bundle. Held
 * back it costs another round of guessing; shown, the first screenshot names
 * the fault. It carries no balance, no number and no token because it is an
 * error object, never the state that produced it.
 *
 * TRY AGAIN RE-MOUNTS RATHER THAN RELOADS. The tree is rebuilt from the
 * providers down, so a transient failure — a response that arrived in a shape
 * one screen did not expect — clears without the customer signing in again.
 */
interface State {
  readonly error: Error | undefined;
}

export class CrashBoundary extends Component<{ readonly children: ReactNode }, State> {
  override state: State = { error: undefined };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    /* The console is what `adb logcat` shows and what a development build
       prints, so the stack is recoverable by somebody with the phone even
       though the screen below shows only the message. */
    // eslint-disable-next-line no-console
    console.error('[xetral] a screen crashed', error, info.componentStack);
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (error === undefined) return this.props.children;

    /*
     * DELIBERATELY NOT THEMED. This renders when the tree is already broken,
     * and reaching for `useTheme` — or any hook — is reaching THROUGH the
     * thing that just failed. Fixed colours cannot throw.
     */
    return (
      <View style={{ flex: 1, backgroundColor: '#0B0D12', padding: 24, justifyContent: 'center' }}>
        <Text style={{ color: '#FFFFFF', fontSize: 20, fontWeight: '700', marginBottom: 10 }}>
          This screen stopped
        </Text>
        <Text style={{ color: '#A9B1C1', fontSize: 14, lineHeight: 20, marginBottom: 16 }}>
          Your money is safe — nothing was sent. Tap below to go back to the app.
        </Text>

        <ScrollView style={{ maxHeight: 220, marginBottom: 20 }}>
          <Text selectable style={{ color: '#7E8799', fontSize: 12, lineHeight: 18 }}>
            {error.message}
          </Text>
        </ScrollView>

        <Pressable
          onPress={() => this.setState({ error: undefined })}
          accessibilityRole="button"
          style={{
            backgroundColor: '#FFFFFF',
            borderRadius: 999,
            paddingVertical: 15,
            alignItems: 'center',
          }}
        >
          <Text style={{ color: '#0B0D12', fontSize: 15, fontWeight: '600' }}>Try again</Text>
        </Pressable>
      </View>
    );
  }
}
