import { useEffect, useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { convertPreset, exponentFor, formatAmount, groupTyped, hiddenCurrencies, isValidAmount, messageFor, TRANSFER_CURRENCIES } from '@xetral/client';
import type { FxQuote, FxTrade } from '@xetral/client';
import { Shell } from '@/shell';
import {
  Button,
  Done,
  Empty,
  FormError,
  Loading,
  Panel,
  Toast,
} from '@/ui';
import { Select } from '@/select';
import { CurrencyMark } from '@/currency-mark';
import { Icon } from '@/icon';
import { useIdempotencyKey, useLoad, useSubmit, useXetral } from '@/hooks';
import { useServiceStates } from '@/services';
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
  // Not a currency a HIDDEN service took (093).
  const { states: services } = useServiceStates();
  const codes = TRANSFER_CURRENCIES.filter((c) => !hiddenCurrencies(services).has(c));
  const held = new Map((balances.data ?? []).map((b) => [b.currency, b.spendable]));
  const option = (c: string) => ({
    value: c,
    label: c,
    ...(held.has(c) ? { hint: formatAmount(held.get(c) ?? '0', c) } : {}),
  });

  /*
   * THE COMP'S PANEL, HEAD, FIGURE AND RATE ROW — the same figures the web's
   * `.cv-*` rules carry, written once here rather than inline at four call
   * sites. Two copies of a panel in one file is how the To panel ends up a
   * pixel off the From panel.
   */
  const panel = {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.edge,
    borderRadius: 18,
    paddingVertical: 16,
    paddingHorizontal: 18,
  } as const;
  const head = {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  } as const;
  const label = { color: colors.text3, fontFamily: font.sansMedium, fontSize: 12 } as const;
  const figure = {
    marginTop: 8,
    padding: 0,
    fontFamily: font.numBold,
    fontSize: 30,
    letterSpacing: -1,
    fontVariant: ['tabular-nums'] as ('tabular-nums')[],
  } as const;
  const balanceLine = {
    marginTop: 2,
    color: colors.text3,
    fontFamily: font.sansMedium,
    fontSize: 12,
  } as const;
  const rateRow = {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: 12,
    paddingVertical: 16,
    paddingHorizontal: 4,
  } as const;
  const rateLabel = { color: colors.text3, fontFamily: font.sansMedium, fontSize: 13 } as const;
  const rateValue = {
    color: colors.text2,
    fontFamily: font.sansMedium,
    fontSize: 13,
    fontVariant: ['tabular-nums'] as ('tabular-nums')[],
  } as const;

  // Buy and Sell on the crypto screen open this on a pair.
  const params = useLocalSearchParams<{ from?: string; to?: string }>();
  const [from, setFrom] = useState(() => convertPreset(params.from, params.to, hiddenCurrencies(services)).from);
  const [to, setTo] = useState(() => convertPreset(params.from, params.to, hiddenCurrencies(services)).to);
  /* The answer about what is hidden can arrive AFTER the pair was read off
     the link. A side that turns out to be hidden goes back to the default
     pair rather than sitting on a currency the pickers no longer offer. */
  const hiddenKey = [...hiddenCurrencies(services)].join(',');
  useEffect(() => {
    const hidden = hiddenCurrencies(services);
    if (hidden.has(from) || hidden.has(to)) {
      const pair = convertPreset(from, to, hidden);
      setFrom(pair.from);
      setTo(pair.to);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-run only when what is hidden changes
  }, [hiddenKey]);
  const [amount, setAmount] = useState('');
  const [fetched, setFetched] = useState<{ readonly key: string; readonly quote: FxQuote } | undefined>();
  const [quoteError, setQuoteError] = useState<string | undefined>();
  /*
   * THE FIGURE FOLLOWS THE TYPING, as on the web: the quote is a read priced
   * from the published rates, fetched a moment after the typing stops, and
   * drawn only while the pair and the amount are the ones it was asked about.
   */
  const wanted = `${from}>${to}:${amount}`;
  const quote = fetched !== undefined && fetched.key === wanted ? fetched.quote : undefined;
  const setQuote = (next: FxQuote | undefined): void => {
    setFetched(next === undefined ? undefined : { key: wanted, quote: next });
  };
  useEffect(() => {
    setQuoteError(undefined);
    if (from === to || amount === '' || !isValidAmount(amount, exponentFor(from))) return undefined;
    let live = true;
    const key = `${from}>${to}:${amount}`;
    const timer = setTimeout(() => {
      client.fxQuote(from, to, amount).then(
        (next) => live && setFetched({ key, quote: next }),
        (cause: unknown) => live && setQuoteError(messageFor(cause)),
      );
    }, 450);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [client, from, to, amount]);

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

      {/*
        TWO PANELS AND THE SWAP BETWEEN THEM, which is the comp's whole screen
        — and the currency was being asked TWICE before it: a pill in the
        receive row AND a "Convert to" picker under both cards. Two controls
        for one answer, the fault the home screen's currency selector already
        replaced a badge and a rail to fix. The web's Convert is the same
        shape, to the same figures.
      */}
      <View style={{ position: 'relative', gap: 10, marginTop: space.md }}>
        <View style={panel}>
          <View style={head}>
            <Text style={label}>From</Text>
            <Select
              label="Currency you convert"
              variant="bare"
              value={from}
              onChange={(next) => { setFrom(next); setQuote(undefined); }}
              options={codes.map(option)}
              renderMark={(value) => <CurrencyMark currency={value} size={20} />}
            />
          </View>
          {/* GROUPED AS IT IS TYPED — `groupTyped` from `@xetral/client`,
              which is the one place that arithmetic lives and never produces
              a number. `50000` at 30px is read by counting zeros. The stored
              value stays UNGROUPED, so what reaches the API is a decimal
              string and not a display string. */}
          <TextInput
            value={groupTyped(amount)}
            onChangeText={(next) => {
              const digits = next.replace(/[^0-9.]/g, '');
              // At most one decimal point: a second is a typo, and
              // `parseFloat` is not available to decide that for us.
              const [whole = '', ...rest] = digits.split('.');
              // A quote describes ONE amount. Leaving a stale one on screen
              // while the number under it changes is how somebody confirms a
              // rate they were never shown.
              setAmount(rest.length === 0 ? whole : `${whole}.${rest.join('')}`);
              setQuote(undefined);
            }}
            keyboardType="decimal-pad"
            placeholder="0"
            placeholderTextColor={colors.text3}
            accessibilityLabel="Amount to convert"
            // No line or box around the figure: it is the amount, not a field.
            underlineColorAndroid="transparent"
            style={[figure, { color: colors.text, borderWidth: 0, padding: 0 }]}
          />
          {/* THE BALANCE UNDER THE FIGURE, which is what the comp draws and
              what answers the only other question somebody has here. It is
              the SPENDABLE figure: pending money cannot be converted and
              offering it would produce a refusal. */}
          <Text style={balanceLine}>
            {held.has(from) ? `Balance ${formatAmount(held.get(from) ?? '0', from)}` : ' '}
          </Text>
        </View>

        {/*
          THE ONE DECISION ON THIS SCREEN IS WHICH WAY ROUND, so it is a
          button rather than two pickers. It swaps the pair and drops the
          quote — a rate for NGN→USD is not a rate for USD→NGN, and 008's rule
          is that a rate is a RATIO which does not simply invert through a
          spread.
        */}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Swap — convert ${to} to ${from} instead`}
          android_ripple={null}
          onPress={() => { setFrom(to); setTo(from); setQuote(undefined); }}
          style={{
            position: 'absolute',
            top: '50%',
            alignSelf: 'center',
            marginTop: -20,
            zIndex: 2,
            width: 40, height: 40,
            alignItems: 'center', justifyContent: 'center',
            borderRadius: 12,
            borderWidth: 3, borderColor: colors.bg,
            backgroundColor: colors.iris,
          }}
        >
          <Icon name="swapVertical" size={20} color={colors.onIris} />
        </Pressable>

        <View style={panel}>
          <View style={head}>
            <Text style={label}>To</Text>
            <Select
              label="Currency you receive"
              variant="bare"
              value={to}
              onChange={(next) => { setTo(next); setQuote(undefined); }}
              options={codes.map(option)}
              renderMark={(value) => <CurrencyMark currency={value} size={20} />}
            />
          </View>
          {/* A quote fills the figure; until one is fetched it is a dash,
              because the rate is the operator's answer and not a default —
              and a dash at 800/30 in the text colour reads as a divider, so
              it is drawn in `text3`. */}
          <Text
            style={[figure, { color: quote === undefined ? colors.text3 : colors.text2 }]}
          >
            {quote === undefined ? '0' : formatAmount(quote.receives, quote.to)}
          </Text>
          <Text style={balanceLine}>
            {held.has(to) ? `Balance ${formatAmount(held.get(to) ?? '0', to)}` : ' '}
          </Text>
        </View>
      </View>

      {from === to && <Text style={styles.error}>Pick two different currencies.</Text>}

      {/* THE RATE IS ITS OWN LINE AND THE FEE IS BESIDE IT, never folded into
          the figure. A customer comparing us against a bureau de change
          compares what they receive, and hiding our margin inside the rate
          makes that comparison quietly dishonest. */}
      <View style={rateRow}>
        <Text style={rateLabel}>Rate</Text>
        <Text style={rateValue}>
          {quote !== undefined
            ? `1 ${quote.from} = ${quote.rate} ${quote.to}`
            : quoteError !== undefined
              ? quoteError
              : amount === ''
                ? 'Enter an amount to see today’s rate'
                : /* Nothing is asked for an amount that does not parse. */
                  !isValidAmount(amount, exponentFor(from))
                  ? exponentFor(from) === 0
                    ? `${from} has no decimal places`
                    : `Enter an amount in ${from}, with at most ${exponentFor(from)} decimal places`
                  : 'Getting today’s rate…'}
        </Text>
      </View>
      {quote !== undefined && (
        <View style={[rateRow, { paddingTop: 0 }]}>
          <Text style={rateLabel}>Our fee</Text>
          <Text style={rateValue}>{formatAmount(quote.spread, quote.from)}</Text>
        </View>
      )}

      {/*
        ONE BUTTON THAT QUOTES AND THEN CONVERTS.

        It was two — "Get today's rate" and a Convert under it — so the
        customer pressed one control, read a figure, and pressed another, with
        a rate expiring between them. The comp has one, and a quote is a read.

        AND NO RECIPIENT FIELD. Sending a conversion to somebody IS a payment,
        and that is the Send screen: since Phase 19 it derives the rail from
        the recipient and the currency, so a converting transfer already
        routes to the same one journal entry this endpoint posts. An optional
        recipient here was a second, quieter way into it — with its own PIN
        field, on a screen headed Convert.
      */}
      <Button
        label={busy ? 'Converting…' : quote === undefined ? 'Get today’s rate' : 'Convert now'}
        busy={busy}
        disabled={amount === '' || from === to}
        onPress={() =>
          void run(async () => {
            if (quote === undefined) {
              setQuote(await client.fxQuote(from, to, amount));
              return undefined;
            }
            const trade = await client.convert({
              from,
              to,
              amount,
              // What they agreed to. The server refuses rather than filling
              // below it, so a rate that moves between the quote and the tap
              // costs a refusal instead of money.
              minReceived: quote.receives,
              idempotencyKey: attempt.key,
            });
            attempt.next();
            setQuote(undefined);
            setAmount('');
            trades.reload();
            balances.reload();
            return `Converted. You received ${formatAmount(trade.received, trade.to)}.`;
          })
        }
      />

      {quote !== undefined && (
        <View
          style={{
            flexDirection: 'row', alignItems: 'center',
            justifyContent: 'center', gap: 7, marginTop: 2,
          }}
        >
          <Icon name="zap" size={15} color={colors.text2} />
          <Text style={styles.hint}>
            This rate holds until {new Date(quote.expires_at).toLocaleTimeString()}
          </Text>
        </View>
      )}

      <FormError error={error} code={code} />
      <Done message={done} />

      <Panel title="Recent conversions">
        {trades.loading && <Loading />}
        <FormError error={trades.error} code={trades.code} />
        {/* A failed read is not "no conversions". */}
        {!trades.loading && trades.error === undefined && (trades.data?.length ?? 0) === 0 && (
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
