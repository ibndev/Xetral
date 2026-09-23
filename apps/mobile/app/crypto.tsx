import { useState } from 'react';
import { Text, TextInput, View } from 'react-native';
import { useRouter } from 'expo-router';
import { CRYPTO_PAIRS, cryptoPortfolio, currencyName, formatAmount, formatMinor, formatQuantity } from '@xetral/client';
import type { CryptoAddress, CryptoQuote, Withdrawal } from '@xetral/client';
import { Shell } from '@/shell';
import { Eyebrow } from '@/acct-card';
import { CurrencyMark } from '@/currency-mark';
import {
  AmountCard,
  Button,
  CurrencyPill,
  Done,
  Empty,
  Field,
  FormError,
  Loading,
  Panel,
  VerifyPrompt,
} from '@/ui';
import { Select } from '@/select';
import { Icon } from '@/icon';
import { useIdempotencyKey, useLoad, useSubmit, useXetral } from '@/hooks';
import { font, space, useStyles, useTheme, onGround, cardShadow } from '@/theme';

/**
 * WHAT THE CUSTOMER HOLDS AND WHAT IT IS WORTH — the comp's portfolio card,
 * Buy and Sell, then the holdings list. The web's `Portfolio` is the same
 * component in the other rendering system, and both read `cryptoPortfolio`
 * so they cannot disagree about one coin.
 *
 * The dollar figures are `/v1/wallets/total`'s own lines — what a conversion
 * would pay at the published rate and spread. An asset with no published
 * price is named, never valued at a guess. The comp's "+4.2% today" is not
 * drawn: a daily move needs yesterday's price, which this platform does not
 * keep, so the line says what the figure is instead.
 */
function Portfolio({ home }: { readonly home: string }) {
  const client = useXetral();
  const colors = useTheme();
  const router = useRouter();
  const balances = useLoad(() => client.balances(), [client]);
  const total = useLoad(() => client.dollarTotal(), [client]);
  const p = cryptoPortfolio(total.data, balances.data);
  const num = {
    fontVariant: ['tabular-nums'] as ('tabular-nums')[],
    color: colors.text,
  };

  return (
    <>
      <View
        style={{
          borderRadius: 20,
          padding: 20,
          backgroundColor: colors.cardGrad1,
          borderWidth: 1,
          borderColor: colors.iris,
          marginTop: space.md,
          ...cardShadow(colors),
        }}
      >
        <Text style={{ color: colors.irisText, fontFamily: font.sansMedium, fontSize: 12.5 }}>Portfolio value</Text>
        <Text
          numberOfLines={1}
          adjustsFontSizeToFit
          minimumFontScale={0.6}
          style={{ ...num, fontFamily: font.numBold, fontSize: 32, letterSpacing: -1, marginTop: 6 }}
        >
          {total.data !== undefined ? formatMinor(p.totalMinor, 'USD') : total.error !== undefined ? '—' : '…'}
        </Text>
        <Text style={{ color: colors.text3, fontFamily: font.sansSemi, fontSize: 12.5, marginTop: 8 }}>
          {total.error !== undefined
            ? 'Prices are unavailable right now'
            : p.unpriced.length > 0
              ? `In dollars, at today’s rate · not counted: ${p.unpriced.join(', ')}`
              : 'In dollars, at today’s rate'}
        </Text>
      </View>
      <View style={{ flexDirection: 'row', gap: 10, marginTop: 14 }}>
        <View style={{ flex: 1 }}>
          <Button label="Buy" onPress={() => router.push(`/fx?from=${home}&to=USDT`)} />
        </View>
        <View style={{ flex: 1 }}>
          <Button quiet label="Sell" onPress={() => router.push(`/fx?from=${p.largest ?? 'USDT'}&to=${home}`)} />
        </View>
      </View>

      <Eyebrow>Holdings</Eyebrow>
      {balances.loading && <Loading />}
      {p.rows.map((row, index) => (
        <View
          key={row.asset}
          style={{
            flexDirection: 'row', alignItems: 'center', gap: 13,
            paddingVertical: 12,
            borderTopWidth: index === 0 ? 0 : 1, borderTopColor: colors.line,
          }}
        >
          <View
            style={{
              width: 42, height: 42, borderRadius: 999,
              alignItems: 'center', justifyContent: 'center',
              ...onGround(colors),
            }}
          >
            <CurrencyMark currency={row.asset} size={26} />
          </View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text numberOfLines={1} style={{ color: colors.text, fontFamily: font.sansSemi, fontSize: 15 }}>
              {currencyName(row.asset)}
            </Text>
            <Text
              numberOfLines={1}
              style={{ color: colors.text3, fontFamily: font.sansMedium, fontSize: 12, marginTop: 2 }}
            >
              {formatQuantity(row.held, row.asset)}
            </Text>
          </View>
          <View style={{ alignItems: 'flex-end' }}>
            <Text style={{ ...num, fontFamily: font.sansBold, fontSize: 14 }}>
              {row.valueMinor !== undefined ? formatMinor(row.valueMinor, 'USD') : '—'}
            </Text>
            {row.valueMinor === undefined && (
              <Text style={{ color: colors.text3, fontFamily: font.sansSemi, fontSize: 11.5, marginTop: 2 }}>
                No price yet
              </Text>
            )}
          </View>
        </View>
      ))}
    </>
  );
}

/**
 * Crypto: an address to receive on, and an irreversible way to send.
 *
 * THE PAIRS COME FROM `@xetral/client`, which holds the API's own casing. The
 * web's copy of this list used uppercase chain names and was refused by the
 * schema on every request; one list is what stops that happening again in
 * either direction.
 */
const PAIRS = CRYPTO_PAIRS;

export default function Crypto() {
  const client = useXetral();
  const styles = useStyles();
  const colors = useTheme();
  const withdrawals = useLoad(() => client.withdrawals(), [client]);
  const session = useLoad(() => client.currentSession(), [client]);

  const [pair, setPair] = useState(0);
  const chosen = PAIRS[pair] ?? PAIRS[0];

  if (withdrawals.code === 'kyc_required') {
    return (
      <Shell back="/more" title="Crypto">
        <View style={{ marginTop: space.lg }}>
          <VerifyPrompt what="crypto" />
        </View>
      </Shell>
    );
  }

  return (
    /*
      A BACK ARROW AND A TITLE, because this screen is reached from More and
      is not a tab — and the web's is the same. It drew the screen's own `h1`
      under the brand header, so it read as a top-level destination with no
      way back to the list it was opened from.
    */
    <Shell back="/more" title="Crypto">
      <Portfolio home={session.data?.home_currency ?? 'NGN'} />

      <Panel title="Asset and network">
        {/*
          A sheet rather than seven stacked cards. With USDC on three chains
          this list is now seven entries, and seven full-width rows pushed the
          screen a customer actually came for — the address, and the send form
          — below the fold on every phone.
        */}
        <Select
          label="Asset and network"
          value={String(pair)}
          onChange={(value) => setPair(Number(value))}
          options={PAIRS.map((option, index) => ({
            value: String(index),
            label: option.label,
          }))}
        />
      </Panel>

      <Receive key={`${chosen.asset}:${chosen.network}`} pair={chosen} />
      <Send pair={chosen} onSent={withdrawals.reload} />

      <Panel title="Recent withdrawals">
        {withdrawals.loading && <Loading />}
        {!withdrawals.loading && (withdrawals.data?.length ?? 0) === 0 && (
          <Empty icon="bitcoin" title="Nothing sent yet" />
        )}
        {withdrawals.data?.slice(0, 10).map((w: Withdrawal) => (
          <View key={w.id} style={styles.row}>
            <View style={{ flex: 1 }}>
              <Text style={{ color: colors.text, fontFamily: font.sansSemi }}>
                {w.asset} · {w.network}
              </Text>
              <Text style={styles.muted} numberOfLines={1}>
                {w.status}
                {w.failure_reason === null ? '' : ` — ${w.failure_reason}`}
              </Text>
            </View>
            <Text style={styles.amount}>{formatAmount(w.amount, w.asset)}</Text>
          </View>
        ))}
        <FormError error={withdrawals.error} code={withdrawals.code} />
      </Panel>
    </Shell>
  );
}

function Receive({ pair }: { readonly pair: (typeof PAIRS)[number] }) {
  const client = useXetral();
  const styles = useStyles();
  const { busy, error, code, run } = useSubmit();
  const [address, setAddress] = useState<CryptoAddress | undefined>();

  return (
    <Panel title="Receive">
      {address === undefined ? (
        <Button
          label="Show my address"
          busy={busy}
          onPress={() =>
            void run(async () => {
              setAddress(await client.cryptoAddress(pair.asset, pair.network));
              return undefined;
            })
          }
        />
      ) : (
        <>
          <Text style={[styles.amount, { fontSize: 13 }]} selectable>
            {address.address}
          </Text>
          {address.memo !== null && (
            <Text style={styles.hint}>
              Memo {address.memo} — sending without it loses the money on that chain.
            </Text>
          )}
          <Text style={styles.hint}>
            Send only {pair.asset} on {pair.network} here. A deposit becomes spendable
            after enough confirmations.
          </Text>
        </>
      )}
      <FormError error={error} code={code} />
    </Panel>
  );
}

function Send({
  pair,
  onSent,
}: {
  readonly pair: (typeof PAIRS)[number];
  readonly onSent: () => void;
}) {
  const client = useXetral();
  const styles = useStyles();
  const colors = useTheme();
  const { busy, error, code, done, run } = useSubmit();
  const attempt = useIdempotencyKey();
  const [destination, setDestination] = useState('');
  const [amount, setAmount] = useState('');
  const [pin, setPin] = useState('');
  const [quote, setQuote] = useState<CryptoQuote | undefined>();

  return (
    <Panel title="Send">
      <Field
        label="Destination address"
        autoCapitalize="none"
        autoCorrect={false}
        value={destination}
        onChangeText={setDestination}
        hint="Check every character. We catch a typo; we cannot recall a payment sent to somebody else's valid address."
      />
      {/* THE AMOUNT IS THE HERO, like Send. The asset sits in the well as a
          pill and the fee is a line under it, rather than a flat input above a
          two-row breakdown. */}
      <AmountCard>
        <Text style={styles.fieldLabel}>You send</Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
          <CurrencyPill>
            <Text style={{ color: colors.text, fontFamily: font.sansSemi, fontSize: 14 }}>
              {pair.asset}
            </Text>
          </CurrencyPill>
          <TextInput
            value={amount}
            onChangeText={(next) => {
              setAmount(next);
              setQuote(undefined);
            }}
            keyboardType="decimal-pad"
            placeholder="0"
            placeholderTextColor={colors.text3}
            accessibilityLabel="Amount to send"
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
        {quote !== undefined && (
          <Text style={styles.muted}>
            Network fee {formatAmount(quote.fee, quote.asset)} · total{' '}
            {formatAmount(quote.total, quote.asset)}
          </Text>
        )}
      </AmountCard>

      <Button
        label={quote === undefined ? 'Check the fee' : 'Refresh fee'}
        accent
        busy={busy && quote === undefined}
        disabled={amount === ''}
        onPress={() =>
          void run(async () => {
            setQuote(
              await client.cryptoQuote({
                asset: pair.asset,
                network: pair.network,
                amount,
              }),
            );
            return undefined;
          })
        }
      />

      <Field
        label="Transaction PIN"
        secureTextEntry
        inputMode="numeric"
        autoComplete="off"
        value={pin}
        onChangeText={setPin}
      />

      <View
        style={{ flexDirection: 'row', alignItems: 'center', gap: 7, marginTop: 2 }}
      >
        <Icon name="alert" size={15} color={colors.text2} />
        <Text style={styles.hint}>On-chain transfers cannot be recalled.</Text>
      </View>

      <Button
        label="Send"
        busy={busy}
        disabled={destination === '' || amount === '' || pin === ''}
        onPress={() =>
          void run(async () => {
            await client.withdrawCrypto({
              asset: pair.asset,
              network: pair.network,
              destination,
              amount,
              // THE FEE CEILING IS PART OF CONSENT. Network fees move between
              // the quote and the request, and without this a customer can be
              // charged materially more than the number they approved.
              ...(quote === undefined ? {} : { maxFee: quote.fee }),
              pin,
              idempotencyKey: attempt.key,
            });
            attempt.next();
            setPin('');
            setQuote(undefined);
            onSent();
            return 'Sent. It is on the chain now and cannot be recalled.';
          })
        }
      />
      <FormError error={error} code={code} />
      <Done message={done} />
    </Panel>
  );
}
