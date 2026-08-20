import { useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import { router } from 'expo-router';
import * as SecureStore from 'expo-secure-store';
import { resetXetral, xetral } from '@/session';
import { messageFor } from '@/errors';
import { styles } from '@/theme';

/** A per-install identifier the server binds sessions to. Kept in the Keychain
 *  with everything else so it survives an app update but not a reinstall. */
async function deviceFingerprint(): Promise<string> {
  const key = 'xetral.device';
  const held = await SecureStore.getItemAsync(key);
  if (held !== null) return held;

  const created = `${Date.now()}-${Math.random().toString(36).slice(2)}-mobile`;
  await SecureStore.setItemAsync(key, created);
  return created;
}

export default function SignIn() {
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    setError(undefined);
    try {
      resetXetral();
      await xetral().session.signIn(identifier, password, {
        fingerprint: await deviceFingerprint(),
        platform: 'ios',
      });
      router.replace('/wallet');
    } catch (cause) {
      setError(messageFor(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={styles.screen}>
      <View style={styles.panel}>
        <Text style={styles.h1}>Welcome back</Text>
        <Text style={styles.h2}>Sign in to your wallet</Text>

        <Text style={styles.label}>Email</Text>
        <TextInput
          style={styles.input}
          value={identifier}
          onChangeText={setIdentifier}
          autoCapitalize="none"
          keyboardType="email-address"
          textContentType="username"
        />

        <Text style={styles.label}>Password</Text>
        <TextInput
          style={styles.input}
          value={password}
          onChangeText={setPassword}
          secureTextEntry
          textContentType="password"
        />

        <Pressable style={styles.button} onPress={submit} disabled={busy}>
          <Text style={styles.buttonText}>{busy ? 'Signing in…' : 'Sign in'}</Text>
        </Pressable>

        {error !== undefined && <Text style={styles.error}>{error}</Text>}
      </View>
    </View>
  );
}
