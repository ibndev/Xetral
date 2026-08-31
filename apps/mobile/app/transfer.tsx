import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { exponentFor, formatAmount, isValidAmount } from '@xetral/client';
import { Shell } from '@/shell';
import { Button, Done, Field, FormError, Panel } from '@/ui';
import { useIdempotencyKey, useLoad, useSubmit, useXetral } from '@/hooks';
import { radius, useStyles, useTheme } from '@/theme';

export default function Transfer() {
  const client = useXetral();
  const styles = useStyles();
  const colors = useTheme();
  const { busy, error, code, done, run } = useSubmit();

  /**
   * One key per attempt at THIS transfer, fixed when the screen mounts.
   *
   * A phone on a patchy connection is where double-sends actually happen: the
   * request succeeds, the response never arrives, the customer taps again.
   * Generating this inside the handler would defeat the entire guard.
   */
  const attempt = useIdempotencyKey();

  const [recipient, setRecipient] = useState('');
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState('NGN');
  const [pin, setPin] = useState('');

  /*
   * THE CURRENCIES COME FROM THE API. This screen had `const currency =
   * 'NGN'`, so a customer holding dollars or USDT could see the balance on the
   * home screen and had no way to send it from the phone at all.
   */
  const balances = useLoad(() => client.balances(), [client]);
  const options = balances.data?.map((b) => b.currency) ?? ['NGN'];

  const amountValid = amount === '' || isValidAmount(amount, exponentFor(currency));

  return (
    <Shell back="/wallet" title="Send money">
      <Panel title="Send money" subtitle="To another Xetral account">
        <Field
          label="Recipient email"
          inputMode="email"
          autoCapitalize="none"
          autoCorrect={false}
          value={recipient}
          onChangeText={setRecipient}
        />

        <Text style={styles.label}>Currency</Text>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
          {options.map((option) => {
            const on = option === currency;
            return (
              <Pressable
                key={option}
                onPress={() => setCurrency(option)}
                accessibilityRole="radio"
                accessibilityState={{ selected: on }}
                style={{
                  paddingHorizontal: 14,
                  paddingVertical: 9,
                  borderRadius: radius.pill,
                  backgroundColor: on ? colors.brand : colors.surface2,
                }}
              >
                <Text
                  style={{
                    fontSize: 13,
                    fontWeight: '600',
                    color: on ? colors.onBrand : colors.text2,
                  }}
                >
                  {option}
                </Text>
              </Pressable>
            );
          })}
        </View>

        <Field
          label="Amount"
          inputMode="decimal"
          placeholder="0.00"
          value={amount}
          onChangeText={setAmount}
        />
        {!amountValid && (
          // Caught by the form rather than by a 400 from a money-moving
          // endpoint — and the check counts decimals PER CURRENCY, so USDT
          // gets six and naira gets two.
          <Text style={styles.error}>
            Enter an amount with at most {exponentFor(currency)} decimal places.
          </Text>
        )}

        <Field
          label="Transaction PIN"
          secureTextEntry
          inputMode="numeric"
          autoComplete="off"
          maxLength={6}
          value={pin}
          onChangeText={setPin}
        />

        <Button
          label="Send"
          busy={busy}
          disabled={recipient === '' || amount === '' || pin === '' || !amountValid}
          onPress={() =>
            void run(async () => {
              const result = await client.transfer({
                recipient,
                amount,
                currency,
                pin,
                idempotencyKey: attempt.key,
              });
              // The attempt is over, so the next Send is a new transfer and
              // needs a new key — reusing this one would have the server
              // replay this transfer and report success for money that never
              // moved.
              attempt.next();
              // Cleared straight away. A PIN authorises one instruction; it is
              // not a password to hold on to.
              setPin('');
              return `Sent ${formatAmount(result.amount, result.currency)}${
                result.fee === '0.00' ? '' : ` (fee ${formatAmount(result.fee, result.currency)})`
              }.`;
            })
          }
        />

        <FormError error={error} code={code} />
        <Done message={done} />
      </Panel>
    </Shell>
  );
}
