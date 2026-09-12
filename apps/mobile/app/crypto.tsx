import { useState } from 'react';
import { Text, TextInput, View } from 'react-native';
import { CRYPTO_PAIRS, formatAmount } from '@xetral/client';
import type { CryptoAddress, CryptoQuote, Withdrawal } from '@xetral/client';
import { Shell } from '@/shell';
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
import { font, space, useStyles, useTheme } from '@/theme';

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

  const [pair, setPair] = useState(0);
  const chosen = PAIRS[pair] ?? PAIRS[0];

  if (withdrawals.code === 'kyc_required') {
    return (
      <Shell>
        <Text style={styles.h1}>Crypto</Text>
        <View style={{ marginTop: space.lg }}>
          <VerifyPrompt what="crypto" />
        </View>
      </Shell>
    );
  }

  return (
    <Shell>
      <Text style={styles.h1}>Crypto</Text>
      <Text style={styles.lead}>Receive and send stablecoins and Bitcoin.</Text>

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
