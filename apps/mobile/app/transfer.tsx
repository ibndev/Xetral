import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { router } from 'expo-router';
import { exponentFor, formatAmount, isValidAmount, TRANSFER_CURRENCIES } from '@xetral/client';
import { Shell } from '@/shell';
import { Button, Done, Field, FormError, Loading, Panel } from '@/ui';
import { Select } from '@/select';
import { Icon } from '@/icon';
import { useIdempotencyKey, useLoad, useSubmit, useXetral } from '@/hooks';
import { font, radius, space, useTheme, useStyles } from '@/theme';

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
  const [via, setVia] = useState<'link' | 'wallet' | undefined>();

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

  if (via === undefined) {
    return (
      <Shell back="/wallet" title="Send money">
        <Panel title="Send money" subtitle="Who are you paying?">
          <View style={{ gap: 10, marginTop: space.md }}>
            <Choice
              icon="globe"
              title="A payment link"
              sub="Somebody sent you their Xetral link or @handle"
              onPress={() => setVia('link')}
            />
            <Choice
              icon="wallet"
              title="A Xetral wallet"
              sub="You know their email address or phone number"
              onPress={() => setVia('wallet')}
            />
          </View>
          <Text style={styles.hint}>
            Both go to the same place. Your own link is on your settings screen if
            somebody needs it.
          </Text>
        </Panel>
      </Shell>
    );
  }

  return (
    <Shell back="/wallet" title="Send money">
      <Panel
        title="Send money"
        subtitle={via === 'link' ? 'Using a payment link' : 'To a Xetral wallet'}
      >
        <Field
          label={via === 'link' ? 'Their link or @handle' : 'Their email or phone number'}
          // `url` on the link path so the keyboard offers a slash rather than
          // an @ — but the API resolves all four shapes from this one field
          // either way, so neither keyboard can produce something it refuses.
          inputMode={via === 'link' ? 'url' : 'email'}
          placeholder={via === 'link' ? '@olawale' : 'you@example.com'}
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

/**
 * One of two ways to name a recipient.
 *
 * A row rather than a segmented control, because these are not two views of
 * one form: the answer changes what the next screen asks for, and a segment
 * would imply the fields below stay put.
 */
function Choice({
  icon,
  title,
  sub,
  onPress,
}: {
  readonly icon: 'globe' | 'wallet';
  readonly title: string;
  readonly sub: string;
  readonly onPress: () => void;
}) {
  const colors = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${title}. ${sub}`}
      onPress={onPress}
      android_ripple={null}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 13,
        padding: 15,
        borderRadius: radius.md,
        borderWidth: 1,
        borderColor: colors.lineStrong,
        backgroundColor: colors.surface,
      }}
    >
      <View
        style={{
          width: 42,
          height: 42,
          borderRadius: radius.md,
          backgroundColor: colors.surface2,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Icon name={icon} size={20} color={colors.text2} />
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={{ color: colors.text, fontFamily: font.sansSemi, fontSize: 15 }}>{title}</Text>
        <Text style={{ color: colors.text3, fontFamily: font.sans, fontSize: 13, lineHeight: 18 }}>
          {sub}
        </Text>
      </View>
      <Icon name="chevronRight" size={18} color={colors.text3} />
    </Pressable>
  );
}
