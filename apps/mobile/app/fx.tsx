import { useState } from 'react';
import { Text, TextInput, View } from 'react-native';
import { formatAmount, TRANSFER_CURRENCIES } from '@xetral/client';
import type { FxQuote, FxTrade } from '@xetral/client';
import { Shell } from '@/shell';
import {
  AmountCard,
  Button,
  Done,
  Empty,
  Field,
  FormError,
  Loading,
  Panel,
  Toast,
} from '@/ui';
import { Select } from '@/select';
import { CurrencyMark } from '@/currency-mark';
import { Icon } from '@/icon';
import { useIdempotencyKey, useLoad, useSubmit, useXetral } from '@/hooks';
import { font, space, useStyles, useTheme } from '@/theme';

/**
 * Converting, and sending across currencies.
 *
 * A REMITTANCE IS ONE ENTRY on the server, not a conversion followed by a
 * transfer — two entries would leave a window in which the money sits in a
 * wallet the sender never meant to hold it in, and a crash in that window
 * strands it there. This screen is the same request either way; naming a
 * recipient is the only difference.
 */
export default function Fx() {
  const client = useXetral();
  const styles = useStyles();
  const colors = useTheme();
  const { busy, error, code, done, run, clear } = useSubmit();
  const attempt = useIdempotencyKey();

  const balances = useLoad(() => client.balances(), [client]);
  const trades = useLoad(() => client.fxTrades(), [client]);
  /*
   * WHAT CAN BE CONVERTED BETWEEN — the same four a customer can send, not
   * whatever currencies they happen to hold. Which PAIRS are quotable is the
   * API's answer, from published spread policies: an unpublished pair is
   * refused rather than quoted from a default. So this is what may be ASKED.
   */
  const codes = TRANSFER_CURRENCIES;
  const held = new Map((balances.data ?? []).map((b) => [b.currency, b.spendable]));
  const option = (c: string) => ({
    value: c,
    label: c,
    ...(held.has(c) ? { hint: formatAmount(held.get(c) ?? '0', c) } : {}),
  });

  const [from, setFrom] = useState('NGN');
  const [to, setTo] = useState('USD');
  const [amount, setAmount] = useState('');
  const [recipient, setRecipient] = useState('');
  const [pin, setPin] = useState('');
  const [quote, setQuote] = useState<FxQuote | undefined>();

  return (
    <Shell
      /*
        OVER the screen, not inside the scroll. Converting moves money, and a
        line of text under a form the keyboard is closing over is the easiest
        thing on the screen to miss. The inline copy stays, so a refusal can
        be re-read after this has gone.
      */
      overlay={
        <>
          <Toast message={done} tone="ok" onDone={clear} />
          <Toast message={error} tone="bad" onDone={clear} />
        </>
      }
    >
      <Text style={styles.h1}>Convert</Text>
      <Text style={styles.lead}>The rate you see is the rate you get.</Text>

      {/* BARE, LIKE SEND. The page ground carries the flow and the wells are
          the two hero amount cards — what leaves and what lands — rather than
          a recessed grey panel wrapping a stack of dropdowns. */}
      <Panel bare>
        {/* WHAT LEAVES. The currency is a pill inside the amount row, the way
            Send puts it, so the number and its denomination are one control. */}
        <AmountCard>
          <Text style={styles.fieldLabel}>You convert</Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
            <Select
              label="Currency you convert"
              variant="pill"
              value={from}
              onChange={(next) => { setFrom(next); setQuote(undefined); }}
              options={codes.map(option)}
              renderMark={(value) => <CurrencyMark currency={value} size={18} />}
            />
            <TextInput
              value={amount}
              onChangeText={(next) => {
                // A quote describes ONE amount. Leaving a stale one on screen
                // while the number under it changes is how somebody confirms a
                // rate they were never shown.
                setAmount(next);
                setQuote(undefined);
              }}
              keyboardType="decimal-pad"
              placeholder="0"
              placeholderTextColor={colors.text3}
              accessibilityLabel="Amount to convert"
              style={{
                flex: 1,
                textAlign: 'right',
                color: colors.text,
                fontFamily: font.displayBold,
                fontSize: 30,
                letterSpacing: -0.6,
                fontVariant: ['tabular-nums'],
              }}
            />
          </View>
          {from === to && (
            <Text style={styles.error}>Pick two different currencies.</Text>
          )}
        </AmountCard>

        {/* WHAT LANDS. The target currency is the pill — tap it to choose —
            and the figure fills from a quote, a dash until one is fetched
            because the rate is the operator's answer, not a default. */}
        <AmountCard>
          <Text style={styles.fieldLabel}>You receive</Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
            <Select
              label="Currency you receive"
              variant="pill"
              value={to}
              onChange={(next) => { setTo(next); setQuote(undefined); }}
              options={codes.map(option)}
              renderMark={(value) => <CurrencyMark currency={value} size={18} />}
            />
            <Text
              style={{
                flex: 1,
                textAlign: 'right',
                color: colors.text,
                fontFamily: font.displayBold,
                fontSize: 30,
                letterSpacing: -0.6,
                fontVariant: ['tabular-nums'],
              }}
            >
              {quote === undefined ? '—' : formatAmount(quote.receives, quote.to)}
            </Text>
          </View>
          {quote !== undefined && (
            <Text style={styles.muted}>
              {/* The spread is its own line, never folded into the rate — and
                  credited on the FILL, not the quote. */}
              1 {quote.from} = {quote.rate} {quote.to} · our fee{' '}
              {formatAmount(quote.spread, quote.from)}
            </Text>
          )}
        </AmountCard>

        {/* ACCENT, NOT QUIET. This is the only control that does anything until
            there is a quote, and `quiet` made it the faintest thing on the
            screen. `accent` is filled and obvious without spending the white
            the primary Convert button owns on dark. */}
        <Button
          label={quote === undefined ? 'Get today’s rate' : 'Refresh rate'}
          accent
          busy={busy && quote === undefined}
          disabled={amount === '' || from === to}
          onPress={() =>
            void run(async () => {
              setQuote(await client.fxQuote(from, to, amount));
              return undefined;
            })
          }
        />

        {quote !== undefined && (
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 7,
              marginTop: 2,
            }}
          >
            <Icon name="zap" size={15} color={colors.text2} />
            <Text style={styles.hint}>
              This rate holds until {new Date(quote.expires_at).toLocaleTimeString()}
            </Text>
          </View>
        )}

        <Field
          label="Send to someone else (optional)"
          placeholder="Their email or phone"
          inputMode="email"
          autoCapitalize="none"
          value={recipient}
          onChangeText={setRecipient}
          hint="Leave empty to convert into your own wallet."
        />

        {/* ONLY WHEN IT IS GOING TO SOMEBODY. Converting your own balance is
            not a payment, and asking for the PIN there teaches people to type
            it for things that are not payments. */}
        {recipient !== '' && (
          <Field
            label="Transaction PIN"
            secureTextEntry
            inputMode="numeric"
            autoComplete="off"
            maxLength={6}
            value={pin}
            onChangeText={setPin}
          />
        )}

        <Button
          label={recipient === '' ? 'Convert' : 'Convert and send'}
          busy={busy}
          disabled={amount === '' || from === to || (recipient !== '' && pin === '')}
          onPress={() =>
            void run(async () => {
              /* Two calls, matching the API's two routes: converting your own
                 balance takes no PIN, sending it to somebody does. See the
                 web's Convert screen and `fx/dto.ts`. */
              const movement = {
                from,
                to,
                amount,
                // What they agreed to. The server refuses rather than filling
                // below it, so a rate that moves between the quote and the
                // tap costs a refusal instead of money.
                ...(quote === undefined ? {} : { minReceived: quote.receives }),
                idempotencyKey: attempt.key,
              };
              const trade =
                recipient === ''
                  ? await client.convert(movement)
                  : await client.remit({ ...movement, recipient, pin });
              attempt.next();
              setPin('');
              setQuote(undefined);
              trades.reload();
              balances.reload();
              return `Converted. You received ${formatAmount(trade.received, trade.to)}.`;
            })
          }
        />
        <FormError error={error} code={code} />
        <Done message={done} />
      </Panel>

      <Panel title="Recent conversions">
        {trades.loading && <Loading />}
        {!trades.loading && (trades.data?.length ?? 0) === 0 && (
          <Empty icon="swap" title="No conversions yet" />
        )}
        {trades.data?.slice(0, 10).map((trade: FxTrade) => (
          <View key={trade.id} style={styles.row}>
            <View style={{ flex: 1 }}>
              <Text style={{ color: colors.text, fontFamily: font.sansSemi }}>
                {trade.from} → {trade.to}
              </Text>
              <Text style={styles.muted}>
                {trade.recipient ?? 'to your wallet'} ·{' '}
                {new Date(trade.created_at).toLocaleDateString()}
              </Text>
            </View>
            <Text style={styles.amount}>{formatAmount(trade.received, trade.to)}</Text>
          </View>
        ))}
      </Panel>
    </Shell>
  );
}
