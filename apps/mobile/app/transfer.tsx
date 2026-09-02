import { useState } from 'react';
import { Text, View } from 'react-native';
import { router } from 'expo-router';
import { exponentFor, formatAmount, isValidAmount, sendableFor } from '@xetral/client';
import { Shell } from '@/shell';
import { Button, Done, Field, FormError, Loading, Panel } from '@/ui';
import { Select } from '@/select';
import { Icon } from '@/icon';
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

  /*
   * THE PIN IS ASKED ABOUT BEFORE THE FORM, and WHO is asked before that.
   *
   * Both were discovered at the end: a customer with no transaction PIN filled
   * in a recipient, an amount and a PIN box before being told the PIN box was
   * never going to work; and "recipient email" was the only way to name
   * somebody, which is the identifier people are least willing to share.
   */
  const session = useLoad(() => client.currentSession(), [client]);

  /*
   * THEIR OWN LOCAL CURRENCY, not every country's. See the web's Send screen
   * for the argument: `TRANSFER_CURRENCIES` is what the API accepts, and
   * showing a Nigerian the cedi and shilling options gives them two choices
   * that answer `insufficient_funds` with nothing on screen saying which.
   */
  const offered = sendableFor(session.data?.home_currency, [...held.keys()]);
  /*
   * ONLY WHEN WE KNOW. `has_pin` is `boolean | null` and null means the server
   * could not tell — which must NOT route somebody into creating a PIN they
   * already have. That is exactly what happened when a failed query answered
   * `false`: a customer who had set one was sent back to set it again.
   *
   * Unknown falls through to the ordinary form, where the server's own
   * `pin_not_set` refusal decides — and that refusal already carries a link to
   * the right screen, so the worst case is one extra step rather than a loop.
   */
  const needsPin = session.data?.has_pin === false;
  /*
   * ONE FIELD, THEN A CONFIRM. Matching the web, and for the same two
   * reasons: the chooser's two answers led to the same input because the API
   * resolves a handle, an email, a phone number and a payment link from one
   * string; and a PIN answers "yes, this one", which cannot be asked before
   * the customer has seen what "this one" is.
   */
  const [stage, setStage] = useState<'details' | 'confirm'>('details');

  if (session.loading) {
    return (
      <Shell back="/wallet" title="Send money">
        <Loading />
      </Shell>
    );
  }

  if (needsPin) {
    return (
      <Shell back="/wallet" title="Send money">
        <Panel title="First, a transaction PIN" subtitle="It authorises every payment you make">
          <Text style={styles.lead}>
            A separate PIN approves money leaving your account. You set it once.
          </Text>
          <Button label="Set my transaction PIN" onPress={() => router.push('/settings')} />
        </Panel>
      </Shell>
    );
  }

  /*
   * THE CONFIRM STEP, inline rather than a component with eleven props.
   *
   * It reads the same state the details form writes, so there is nothing to
   * pass and nothing that can be passed out of date.
   */
  if (stage === 'confirm') {
    return (
      <Shell back="/wallet" title="Confirm">
        <Panel title="Confirm" subtitle="Check this before you approve it">
          {/* Echoed exactly as typed rather than resolved to a name:
              resolving would be a lookup that says which handles and
              addresses exist, and this screen is reachable by anybody. */}
          <View style={styles.row}>
            <Text style={styles.muted}>To</Text>
            <Text style={styles.amount}>{recipient}</Text>
          </View>
          <View style={styles.row}>
            <Text style={styles.muted}>Amount</Text>
            <Text style={styles.amount}>{formatAmount(amount || '0', currency)}</Text>
          </View>

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
            label={`Send ${formatAmount(amount || '0', currency)}`}
            busy={busy}
            disabled={pin === ''}
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
                // replay this transfer and report success for money that
                // never moved.
                attempt.next();
                // Cleared straight away. A PIN authorises one instruction; it
                // is not a password to hold on to.
                setPin('');
                // Back to an empty form: leaving the review on screen invites
                // a second tap on money that has already moved.
                setStage('details');
                setAmount('');
                setRecipient('');
                return `Sent ${formatAmount(result.amount, result.currency)}${
                  result.fee === '0.00' ? '' : ` (fee ${formatAmount(result.fee, result.currency)})`
                }.`;
              })
            }
          />
          <Button
            label="Edit"
            quiet
            onPress={() => {
              setPin('');
              setStage('details');
            }}
          />

          <FormError error={error} code={code} />
          <Done message={done} />
        </Panel>
      </Shell>
    );
  }

  return (
    <Shell back="/wallet" title="Send money">
      <Panel
        title="Send money"
        subtitle="To anyone on Xetral"
      >
        <Field
          label="Who are you paying?"
          // `url` on the link path so the keyboard offers a slash rather than
          // an @ — but the API resolves all four shapes from this one field
          // either way, so neither keyboard can produce something it refuses.
          inputMode="text"
          placeholder="@handle, email, phone or payment link"
          autoCapitalize="none"
          autoCorrect={false}
          value={recipient}
          onChangeText={setRecipient}
        />

        <Select
          label="Currency"
          value={currency}
          onChange={setCurrency}
          options={offered.map((code) => ({
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

        {/* NO TRANSACTION PIN HERE. It is asked on the confirm step below,
            once the customer can see what they are approving. */}
        <Button
          label="Review"
          disabled={recipient === '' || amount === '' || !amountValid}
          onPress={() => setStage('confirm')}
        />

        <FormError error={error} code={code} />
        <Done message={done} />
      </Panel>
    </Shell>
  );
}
