import { useState } from 'react';
import { Text, View } from 'react-native';
import { formatAmount, TRANSFER_CURRENCIES } from '@xetral/client';
import type { FxQuote, FxTrade } from '@xetral/client';
import { Shell } from '@/shell';
import { Button, Done, Empty, Field, FormError, Loading, Panel } from '@/ui';
import { Select } from '@/select';
import { useIdempotencyKey, useLoad, useSubmit, useXetral } from '@/hooks';
import { radius, space, useStyles, useTheme } from '@/theme';

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
  const { busy, error, code, done, run } = useSubmit();
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
    <Shell>
      <Text style={styles.h1}>Convert</Text>
      <Text style={styles.lead}>The rate you see is the rate you get.</Text>

      <Panel>
        <Select
          label="From"
          value={from}
          onChange={(next) => { setFrom(next); setQuote(undefined); }}
          options={codes.map(option)}
        />

        <Select
          label="To"
          value={to}
          onChange={(next) => { setTo(next); setQuote(undefined); }}
          options={codes.map(option)}
        />

        <Field
          label="Amount"
          inputMode="decimal"
          placeholder="0.00"
          value={amount}
          onChangeText={(next) => {
            setAmount(next);
            // A quote describes ONE amount. Leaving a stale one on screen
            // while the number under it changes is how somebody confirms a
            // rate they were never shown.
            setQuote(undefined);
          }}
        />

        <Button
          label="Get a quote"
          quiet
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
              marginTop: space.md,
              padding: space.md,
              borderRadius: radius.md,
              backgroundColor: colors.surface2,
              gap: 4,
            }}
          >
            <View style={styles.rowBetween}>
              <Text style={styles.muted}>You receive</Text>
              <Text style={styles.amount}>{formatAmount(quote.receives, quote.to)}</Text>
            </View>
            <View style={styles.rowBetween}>
              <Text style={styles.muted}>Spread</Text>
              <Text style={styles.amount}>{formatAmount(quote.spread, quote.from)}</Text>
            </View>
            <Text style={styles.hint}>
              {/* Credited on the FILL, not the quote. A partial fill credited
                  at quote would pay the difference out of the float. */}
              If the market fills less than this, you receive what was filled.
            </Text>
          </View>
        )}

        <Field
          label="Send to (optional)"
          placeholder="somebody@example.com"
          inputMode="email"
          autoCapitalize="none"
          value={recipient}
          onChangeText={setRecipient}
          hint="Leave empty to convert into your own wallet."
        />

        <Field
          label="Transaction PIN"
          secureTextEntry
          inputMode="numeric"
          autoComplete="off"
          value={pin}
          onChangeText={setPin}
        />

        <Button
          label={recipient === '' ? 'Convert' : 'Convert and send'}
          busy={busy}
          disabled={amount === '' || pin === '' || from === to}
          onPress={() =>
            void run(async () => {
              const trade = await client.convert({
                from,
                to,
                amount,
                // What they agreed to. The server refuses rather than filling
                // below it, so a rate that moves between the quote and the
                // tap costs a refusal instead of money.
                ...(quote === undefined ? {} : { minReceived: quote.receives }),
                ...(recipient === '' ? {} : { recipient }),
                pin,
                idempotencyKey: attempt.key,
              });
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
              <Text style={{ color: colors.text, fontWeight: '600' }}>
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
