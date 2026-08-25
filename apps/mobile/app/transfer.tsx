import { useMemo, useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import { router } from 'expo-router';
import { exponentFor, formatAmount, isValidAmount } from '@xetral/client';
import { xetral } from '@/session';
import { messageFor } from '@/errors';
import { useStyles } from '@/theme';

export default function Transfer() {
  const styles = useStyles();
  const [recipient, setRecipient] = useState('');
  const [amount, setAmount] = useState('');
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [done, setDone] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  /**
   * One key per attempt at THIS transfer, fixed when the screen mounts.
   *
   * A phone on a patchy connection is where double-sends actually happen: the
   * request succeeds, the response never arrives, the customer taps again.
   * Generating this inside the handler would defeat the entire guard.
   */
  const idempotencyKey = useMemo(
    () => `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    [],
  );

  const currency = 'NGN';
  const amountValid = amount === '' || isValidAmount(amount, exponentFor(currency));

  async function submit() {
    setBusy(true);
    setError(undefined);
    setDone(undefined);
    try {
      const { client } = xetral(() => router.replace('/signin'));
      const result = await client.transfer({
        recipient,
        amount,
        currency,
        pin,
        idempotencyKey,
      });
      setDone(`Sent ${formatAmount(result.amount, result.currency)}.`);
      // Cleared straight away. A PIN authorises one instruction; it is not a
      // password to hold on to.
      setPin('');
    } catch (cause) {
      setError(messageFor(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={styles.screen}>
      <View style={styles.card}>
        <Text style={styles.h1}>Send money</Text>
        <Text style={styles.h2}>To another Xetral account</Text>

        <Text style={styles.label}>Recipient email</Text>
        <TextInput
          style={styles.input}
          value={recipient}
          onChangeText={setRecipient}
          autoCapitalize="none"
          keyboardType="email-address"
        />

        <Text style={styles.label}>Amount (NGN)</Text>
        <TextInput
          style={styles.input}
          value={amount}
          onChangeText={setAmount}
          keyboardType="decimal-pad"
          placeholder="0.00"
        />
        {!amountValid && (
          <Text style={styles.error}>
            Enter an amount with at most {exponentFor(currency)} decimal places.
          </Text>
        )}

        <Text style={styles.label}>Transaction PIN</Text>
        <TextInput
          style={styles.input}
          value={pin}
          onChangeText={setPin}
          secureTextEntry
          keyboardType="number-pad"
          maxLength={6}
        />

        <Pressable
          style={styles.button}
          onPress={submit}
          disabled={busy || !amountValid || amount === ''}
        >
          <Text style={styles.buttonText}>{busy ? 'Sending…' : 'Send'}</Text>
        </Pressable>

        {error !== undefined && <Text style={styles.error}>{error}</Text>}
        {done !== undefined && <Text style={styles.ok}>{done}</Text>}
      </View>
    </View>
  );
}
