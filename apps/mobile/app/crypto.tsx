import { useState } from 'react';
import { Text, View } from 'react-native';
import { CRYPTO_PAIRS, formatAmount } from '@xetral/client';
import type { CryptoAddress, CryptoQuote, Withdrawal } from '@xetral/client';
import { Shell } from '@/shell';
import { Button, Done, Empty, Field, FormError, Loading, Panel, VerifyPrompt } from '@/ui';
import { Select } from '@/select';
import { useIdempotencyKey, useLoad, useSubmit, useXetral } from '@/hooks';
import { space, useStyles, useTheme } from '@/theme';

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
              <Text style={{ color: colors.text, fontWeight: '600' }}>
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
      <Field
        label="Amount"
        inputMode="decimal"
        value={amount}
        onChangeText={(next) => {
          setAmount(next);
          setQuote(undefined);
        }}
      />

      <Button
        label="Check the fee"
        quiet
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

      {quote !== undefined && (
        <View style={{ marginTop: space.sm, gap: 3 }}>
          <View style={styles.rowBetween}>
            <Text style={styles.muted}>Network fee</Text>
            <Text style={styles.amount}>{formatAmount(quote.fee, quote.asset)}</Text>
          </View>
          <View style={styles.rowBetween}>
            <Text style={styles.muted}>Total debited</Text>
            <Text style={styles.amount}>{formatAmount(quote.total, quote.asset)}</Text>
          </View>
        </View>
      )}

      <Field
        label="Transaction PIN"
        secureTextEntry
        inputMode="numeric"
        autoComplete="off"
        value={pin}
        onChangeText={setPin}
      />

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
