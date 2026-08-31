import { useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import { Link, router } from 'expo-router';
import { deviceDescriptor } from '@/device';
import { resetXetral, xetral } from '@/session';
import { messageFor } from '@/errors';
import { useStyles } from '@/theme';

/**
 * Opening an account, on the phone.
 *
 * REGISTRATION ENDS SIGNED IN, which is why this is the same shape as
 * `signin.tsx` rather than a form that sends somebody to one. The API returns
 * a token pair from `/v1/auth/register`, exactly as it does from login, and
 * `Session.register()` writes both halves to the Keychain. Bouncing a customer
 * to a sign-in form to retype the password they chose thirty seconds ago is
 * the wrong product, and it would also mean the refresh token made a round
 * trip for no reason.
 *
 * NO IDENTITY DOCUMENTS HERE, deliberately. KYC is a separate, reviewed step
 * that a person approves; folding it into registration would make a regulatory
 * decision a side effect of choosing a password, and would put a BVN into the
 * one flow that has to work before anybody trusts the app at all.
 *
 * AND NO MARKETING CHECKBOX, also deliberately. `033_consent.sql` has a CHECK
 * that refuses a marketing consent whose source is `registration` — one "I
 * agree" covering the terms and a mailing list is not consent to the mailing
 * list, whatever the button said. So this form could not usefully grow one.
 */
export default function SignUp() {
  const styles = useStyles();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    setError(undefined);
    try {
      // Cleared first, for the reason sign-in does it: a stale session in
      // memory would have this registration's tokens written over the top of
      // somebody else's, and the singleton would keep serving the old one.
      resetXetral();
      await xetral().session.register({
        // Trimmed, because a keyboard's autocorrect adds a trailing space to
        // an address often enough to matter and the server would take it as
        // part of the address.
        email: email.trim(),
        password,
        device: await deviceDescriptor(),
      });
      // `replace`, not `push`: there is no back to a signup form once the
      // account exists.
      router.replace('/wallet');
    } catch (cause) {
      // The API's own code, translated. A weak password and an address already
      // registered are different things and the customer has to be told which
      // — `messageFor` is where that mapping lives, shared with every other
      // screen so no two disagree.
      setError(messageFor(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={styles.screen}>
      <View style={styles.card}>
        <Text style={styles.h1}>Create your account</Text>
        <Text style={styles.h2}>A Xetral wallet takes a minute</Text>

        <Text style={styles.label}>Email</Text>
        <TextInput
          style={styles.input}
          value={email}
          onChangeText={setEmail}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="email-address"
          // Tells a password manager this is the account being created, so it
          // offers to save the pair rather than autofilling an existing one.
          textContentType="username"
        />

        <Text style={styles.label}>Password</Text>
        <TextInput
          style={styles.input}
          value={password}
          onChangeText={setPassword}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          // `newPassword` rather than `password`: iOS offers a strong one and
          // will not suggest an existing credential for this field.
          textContentType="newPassword"
        />
        <Text style={styles.muted}>
          The server decides what is strong enough and will say if it is not.
        </Text>

        <Pressable
          style={styles.button}
          onPress={submit}
          // Guarded on the fields as well as on `busy`: a double tap on an
          // empty form is a wasted round trip and a confusing error.
          disabled={busy || email.trim() === '' || password === ''}
        >
          <Text style={styles.buttonText}>
            {busy ? 'Creating your account…' : 'Create account'}
          </Text>
        </Pressable>

        {error !== undefined && <Text style={styles.error}>{error}</Text>}

        <Link href="/signin" style={styles.link}>
          Already have an account? Sign in
        </Link>
      </View>
    </View>
  );
}
