import { useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { Link } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { xetral } from '@/session';
import { messageFor } from '@/errors';
import { Logo } from '@/logo';
import { font, space, useStyles, useTheme } from '@/theme';

/**
 * Asking for a way back in, on the phone.
 *
 * THIS SCREEN DID NOT EXIST, and neither did the web's, while the API has had
 * `/v1/auth/password/forgot` since Tier 2. So a customer who forgot their
 * password had no route back to their money at all, on either platform.
 *
 * The RESET itself is finished on the WEB, from the link in the email, and
 * that is deliberate rather than a gap: the link opens in a browser, and a
 * phone screen that asked for a token would be asking somebody to copy a
 * bearer credential out of an email by hand.
 *
 * IT ANSWERS THE SAME THING WHETHER OR NOT THE ADDRESS EXISTS. The server
 * returns 204 for every well-formed identifier and mints and hashes a token
 * either way so the paths do not differ in timing, because an endpoint that
 * answered differently would turn any address list into a customer list. So
 * the words here promise nothing they cannot know.
 */
export default function Forgot() {
  const styles = useStyles();
  const colors = useTheme();
  const insets = useSafeAreaInsets();
  const [identifier, setIdentifier] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  async function submit() {
    setBusy(true);
    setError(undefined);
    try {
      await xetral().session.forgotPassword(identifier.trim());
      setSent(true);
    } catch (cause) {
      setError(messageFor(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: colors.bg }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
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

        <Text style={styles.h1}>{sent ? 'Check your inbox' : 'Reset your password'}</Text>
        <Text style={styles.h2}>
          {sent
            ? 'If that address has a Xetral account, a link is on its way.'
            : 'We will email you a link to set a new one'}
        </Text>

        <View style={styles.card}>
          {sent ? (
            // NO CONFIRMATION THAT ANYTHING WAS SENT. The server does not tell
            // us, on purpose, and inventing certainty here would leave somebody
            // who mistyped their address waiting for mail that is not coming.
            <Text style={styles.lead}>
              The link lasts one hour and works once.
            </Text>
          ) : (
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
                onPress={() => void submit()}
                disabled={busy || identifier.trim() === ''}
              >
                <Text style={styles.buttonText}>
                  {busy ? 'Sending…' : 'Email me a link'}
                </Text>
              </Pressable>

              {error !== undefined && <Text style={styles.error}>{error}</Text>}
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
