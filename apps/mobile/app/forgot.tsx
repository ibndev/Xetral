import { useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { Link, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { xetral } from '@/session';
import { messageFor } from '@/errors';
import { Logo } from '@/logo';
import { space, useStyles, useTheme } from '@/theme';

/**
 * Asking for a way back in, on the phone.
 *
 * THIS SCREEN DID NOT EXIST, and neither did the web's, while the API has had
 * `/v1/auth/password/forgot` since Tier 2. So a customer who forgot their
 * password had no route back to their money at all, on either platform.
 *
 * AND IT COULD NOT FINISH THE JOB. The reset was a LINK, so this screen asked
 * for an address and then sent the customer out to a browser — off the app,
 * onto a page that had to be told the deployment's hostname, and back. With
 * `APP_BASE_URL` unset the API refused the whole flow before it did anything:
 * "Password resets are unavailable right now. Contact support."
 *
 * A CODE FINISHES HERE. Six digits read off the mail app and typed into this
 * one, on the same handset, with nothing to configure and nowhere to go.
 *
 * IT ANSWERS THE SAME THING WHETHER OR NOT THE ADDRESS EXISTS. The server
 * returns 204 for every well-formed identifier and mints and hashes a code
 * either way so the paths do not differ in timing, because an endpoint that
 * answered differently would turn any address list into a customer list. So
 * the second step appears for an address with no account too, and the refusal
 * comes when a code is presented rather than when one is asked for.
 */
export default function Forgot() {
  const styles = useStyles();
  const colors = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const [identifier, setIdentifier] = useState('');
  /*
   * WHAT WAS ASKED FOR, kept apart from what is in the box. The code is bound
   * to the address it was issued against, so the second step must send the
   * SAME identifier — and the field stays editable, because a customer who
   * mistyped their address needs to fix it.
   */
  const [asked, setAsked] = useState<string | undefined>();
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  async function ask() {
    setBusy(true);
    setError(undefined);
    try {
      const wanted = identifier.trim();
      await xetral().session.forgotPassword(wanted);
      setAsked(wanted);
    } catch (cause) {
      setError(messageFor(cause));
    } finally {
      setBusy(false);
    }
  }

  async function finish() {
    setBusy(true);
    setError(undefined);
    try {
      await xetral().session.resetPassword(asked ?? identifier.trim(), code, password);
      // To SIGN IN. There is no session to carry, by design: a leaked code
      // grants a password that can be used, not a live session — and using it
      // revoked every other session on the account.
      router.replace('/signin');
    } catch (cause) {
      setError(messageFor(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: colors.bg }}
      /*
        `height` ON ANDROID, not nothing. It was `undefined`, which relies
        entirely on the window being resized by `adjustResize` — and under the
        edge-to-edge Android 15 enforces, the platform draws behind the
        keyboard and leaves the app to handle the inset. On these three
        screens, which are outside `Shell`, that meant the keyboard sat over
        the password field.

        Both behaviours are computed from the OVERLAP with the keyboard, so
        where the window HAS been resized this adds nothing rather than
        doubling up.
      */
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{
          flexGrow: 1,
          justifyContent: 'center',
          padding: space.lg,
          paddingTop: insets.top + space.xl,
          paddingBottom: insets.bottom + space.xxl,
        }}
      >
        <View style={{ alignItems: 'center', marginBottom: space.lg }}>
          <Logo size={32} />
        </View>

        <Text style={styles.h1}>
          {asked === undefined ? 'Reset your password' : 'Enter your code'}
        </Text>
        <Text style={styles.h2}>
          {asked === undefined
            ? 'We will email you a six-digit code'
            : 'If that address has a Xetral account, a code is on its way'}
        </Text>

        <View style={styles.card}>
          {asked === undefined ? (
            <>
              <Text style={styles.label}>Email</Text>
              <TextInput
                style={styles.input}
                value={identifier}
                onChangeText={setIdentifier}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="email-address"
                textContentType="username"
                placeholder="you@example.com"
                placeholderTextColor={colors.text3}
              />

              <Pressable
                style={styles.button}
                onPress={() => void ask()}
                disabled={busy || identifier.trim() === ''}
              >
                <Text style={styles.buttonText}>{busy ? 'Sending…' : 'Email me a code'}</Text>
              </Pressable>

              {error !== undefined && <Text style={styles.error}>{error}</Text>}
            </>
          ) : (
            <>
              <Text style={styles.label}>Code from the email</Text>
              <TextInput
                style={styles.input}
                value={code}
                onChangeText={setCode}
                // `number-pad`, and the value stays TEXT: a code with a leading
                // zero is a real code, and anything that treats it as a number
                // eats the zero.
                keyboardType="number-pad"
                textContentType="oneTimeCode"
                autoComplete="one-time-code"
                maxLength={16}
                placeholder="123456"
                placeholderTextColor={colors.text3}
              />
              <Text style={styles.hint}>
                It expires in thirty minutes and works once. Five wrong tries and you will need a
                new one.
              </Text>

              <Text style={[styles.label, { marginTop: space.sm }]}>New password</Text>
              <TextInput
                style={styles.input}
                value={password}
                onChangeText={setPassword}
                secureTextEntry
                autoCapitalize="none"
                autoCorrect={false}
                textContentType="newPassword"
                placeholder="At least 10 characters"
                placeholderTextColor={colors.text3}
              />

              <Pressable
                style={styles.button}
                onPress={() => void finish()}
                disabled={busy || code.trim() === '' || password === ''}
              >
                <Text style={styles.buttonText}>{busy ? 'Saving…' : 'Set my password'}</Text>
              </Pressable>

              {error !== undefined && <Text style={styles.error}>{error}</Text>}

              {/* The way out of a code that will never work — a mistyped
                  address, or five wrong tries. Without it the only escape is
                  killing the app. */}
              <Pressable
                onPress={() => {
                  setAsked(undefined);
                  setCode('');
                  setError(undefined);
                }}
              >
                <Text style={[styles.link, { marginTop: space.md }]}>
                  Use a different address, or ask for a new code
                </Text>
              </Pressable>
            </>
          )}

          <Link href="/signin" style={[styles.link, { marginTop: space.md }]}>
            Back to sign in
          </Link>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
