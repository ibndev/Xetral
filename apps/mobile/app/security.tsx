import { useEffect, useState } from 'react';
import { Pressable, Switch, Text, TextInput, View } from 'react-native';
import { router } from 'expo-router';
import { xetral } from '@/session';
import { messageFor } from '@/errors';
import { biometricName, biometricSupport, enrol, forget, isEnrolled } from '@/biometrics';
import type { BiometricSupport } from '@/biometrics';
import { colors, styles } from '@/theme';

/**
 * Turning biometric unlock on and off.
 *
 * Enrolling asks for the PIN and CONFIRMS it with the server before storing
 * it. That round trip is the point: a wrong PIN stored here is not discovered
 * until a real transfer, and that transfer spends one of five attempts before
 * locking the customer out of their own money.
 */
export default function Security() {
  const [support, setSupport] = useState<BiometricSupport | undefined>();
  const [enrolled, setEnrolled] = useState(false);
  const [pin, setPin] = useState('');
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void (async () => {
      setSupport(await biometricSupport());
      setEnrolled(await isEnrolled());
    })();
  }, []);

  async function turnOn() {
    setBusy(true);
    setError(undefined);
    try {
      const { client } = xetral(() => router.replace('/signin'));
      // Confirmed with the server FIRST, then stored.
      await client.verifyPin(pin);
      await enrol(pin);
      setEnrolled(true);
      setAsking(false);
      setPin('');
    } catch (cause) {
      setError(messageFor(cause));
    } finally {
      setBusy(false);
    }
  }

  async function turnOff() {
    await forget();
    setEnrolled(false);
  }

  const label =
    support?.available === true ? biometricName(support.kind) : 'Biometric unlock';

  return (
    <View style={styles.screen}>
      <View style={styles.panel}>
        <Text style={styles.h1}>Security</Text>
        <Text style={styles.h2}>How you approve payments</Text>

        {support?.available === false && (
          <Text style={styles.muted}>
            {support.reason === 'no_hardware'
              ? 'This device has no biometric sensor. You will type your PIN for each payment.'
              : 'No face or fingerprint is set up on this device yet. Add one in your phone settings to use it here.'}
          </Text>
        )}

        {support?.available === true && (
          <>
            <View style={[styles.rowBetween, { alignItems: 'center', paddingVertical: 12 }]}>
              <Text style={{ color: colors.text, fontSize: 15 }}>Unlock PIN with {label}</Text>
              <Switch
                value={enrolled}
                onValueChange={(next) => {
                  if (next) setAsking(true);
                  else void turnOff();
                }}
              />
            </View>

            {/* The sentence that matters. A customer should understand that
                their PIN still guards their money and the scan only saves
                them typing it. */}
            <Text style={styles.muted}>
              {label} unlocks your transaction PIN on this device. It does not replace
              it — every payment is still approved with your PIN, and you can type it
              at any time instead.
            </Text>

            {asking && (
              <>
                <Text style={styles.label}>Confirm your transaction PIN</Text>
                <TextInput
                  style={styles.input}
                  value={pin}
                  onChangeText={setPin}
                  secureTextEntry
                  keyboardType="number-pad"
                  maxLength={6}
                />
                <Pressable style={styles.button} onPress={turnOn} disabled={busy}>
                  <Text style={styles.buttonText}>
                    {busy ? 'Checking…' : `Turn on ${label}`}
                  </Text>
                </Pressable>
              </>
            )}
          </>
        )}

        {error !== undefined && <Text style={styles.error}>{error}</Text>}
      </View>
    </View>
  );
}
