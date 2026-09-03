import { useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { Link, router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { deviceDescriptor } from '@/device';
import { resetXetral, xetral } from '@/session';
import { messageFor } from '@/errors';
import { Logo } from '@/logo';
import { Icon } from '@/icon';
import { font, radius, space, useStyles, useTheme } from '@/theme';

/**
 * Sign in, laid out as the web app lays it out.
 *
 * IT WAS THE SAME FIELDS IN A DIFFERENT SHAPE, and the difference was all the
 * ones that are invisible in code: the web opens with the mark, then a 30px
 * heading and a line under it, then the card; this opened with a heading
 * inside the card and no mark at all. The metrics here are the web's own —
 * 30/15 for the head, 18 between fields, 13 for a label, 16 on the submit —
 * read out of `globals.css` rather than chosen again.
 *
 * THE HEAD IS OUTSIDE THE CARD, which is the structural half. On the web the
 * card holds the form and nothing else, so the page reads as "here is who we
 * are, here is what this is, here is the thing to fill in". Putting the
 * heading inside made the card the whole screen and the mark disappear.
 */
export default function SignIn() {
  const styles = useStyles();
  const colors = useTheme();
  const insets = useSafeAreaInsets();

  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [reveal, setReveal] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    setError(undefined);
    try {
      resetXetral();
      await xetral().session.signIn(identifier, password, await deviceDescriptor());
      router.replace('/wallet');
    } catch (cause) {
      setError(messageFor(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: colors.bg }}
      // The password field is the lowest thing on the screen and the keyboard
      // covers it on a short handset otherwise.
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
        {/* The mark, then the head, then the card — the web's order. */}
        <View style={{ marginBottom: 30 }}>
          <Logo size={32} />
        </View>

        <View style={{ marginBottom: 26 }}>
          <Text style={[styles.h1, { fontSize: 30, letterSpacing: -0.75 }]}>Welcome back</Text>
          <Text style={{ color: colors.text2, fontFamily: font.sans, fontSize: 15, marginTop: 9 }}>
            Sign in to your Xetral account
          </Text>
        </View>

        {/* `gap: 18`, matching `.auth-card`'s grid. The card has no border and
            no padding on the web either: it is a form, not a panel. */}
        <View style={{ gap: 18 }}>
          <View>
            <Text style={styles.fieldLabel}>Email address</Text>
            <TextInput
              style={styles.input}
              placeholder="you@example.com"
              placeholderTextColor={colors.text3}
              value={identifier}
              onChangeText={setIdentifier}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="email-address"
              textContentType="username"
            />
          </View>

          <View>
            <Text style={styles.fieldLabel}>Password</Text>
            <View style={{ justifyContent: 'center' }}>
              <TextInput
                style={[styles.input, { paddingRight: 52 }]}
                value={password}
                onChangeText={setPassword}
                secureTextEntry={!reveal}
                autoCapitalize="none"
                textContentType="password"
              />
              {/* The same affix the web puts in this field, and with no disc
                  behind it in any state — see the balance toggle. */}
              <Pressable
                onPress={() => setReveal((r) => !r)}
                accessibilityRole="button"
                accessibilityLabel={reveal ? 'Hide password' : 'Show password'}
                android_ripple={null}
                hitSlop={6}
                style={{
                  position: 'absolute',
                  right: 6,
                  width: 40,
                  height: 40,
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Icon name={reveal ? 'eyeOff' : 'eye'} size={19} color={colors.text3} />
              </Pressable>
            </View>
          </View>

          <Pressable
            style={[styles.button, { marginTop: 4, minHeight: 52 }]}
            onPress={submit}
            disabled={busy}
          >
            <Text style={[styles.buttonText, { fontSize: 16 }]}>
              {busy ? 'Signing in…' : 'Sign in'}
            </Text>
          </Pressable>

          {error !== undefined && <Text style={styles.error}>{error}</Text>}

          {/* Inside the card and under the password, because that is the field
              a customer who cannot get in is looking at. */}
          <Link
            href="/forgot"
            style={[styles.link, { marginTop: space.md, textAlign: 'right' }]}
          >
            Forgot your password?
          </Link>
        </View>

        <Text
          style={{
            color: colors.text2,
            fontFamily: font.sans,
            fontSize: 14.5,
            marginTop: 24,
          }}
        >
          New here?{' '}
          <Link href="/signup" style={{ color: colors.link, fontFamily: font.sansSemi }}>
            Create an account
          </Link>
        </Text>

        {/* The reassurance line the web carries under the form. */}
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 7,
            marginTop: 18,
          }}
        >
          <Icon name="lock" size={14} color={colors.text3} />
          <Text style={{ color: colors.text3, fontFamily: font.sans, fontSize: 12.5 }}>
            Your money and your data stay encrypted.
          </Text>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
