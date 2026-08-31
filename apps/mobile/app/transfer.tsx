import { useState } from 'react';
import { Text, View } from 'react-native';
import { exponentFor, formatAmount, isValidAmount, TRANSFER_CURRENCIES } from '@xetral/client';
import { Shell } from '@/shell';
import { Button, Done, Field, FormError, Panel } from '@/ui';
import { Select } from '@/select';
import { useIdempotencyKey, useLoad, useSubmit, useXetral } from '@/hooks';
import { useStyles } from '@/theme';

export default function Transfer() {
  const client = useXetral();
  const styles = useStyles();
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
   * WHAT MAY BE SENT, NOT WHAT IS HELD.
   *
   * This list came from the customer's own balances, which reads as sensible
   * and asks the wrong question: a customer holding only naira was offered
   * exactly one option, so the picker looked broken, and anything that
   * happened to appear as a balance became a transfer option nothing had
   * decided to offer. `TRANSFER_CURRENCIES` is the decision, shared with the
   * web app and checked against the API's own enum by the build.
   *
   * Balances are still loaded, to show what is behind each choice.
   */
  const balances = useLoad(() => client.balances(), [client]);
  const held = new Map((balances.data ?? []).map((b) => [b.currency, b.spendable]));

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

        <Select
          label="Currency"
          value={currency}
          onChange={setCurrency}
          options={TRANSFER_CURRENCIES.map((code) => ({
            value: code,
            label: code,
            // What is actually behind the choice, so picking a currency they
            // hold none of is answered here rather than by `insufficient_funds`
            // after an amount and a PIN.
            ...(held.has(code) ? { hint: formatAmount(held.get(code) ?? '0', code) } : {}),
          }))}
        />

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
