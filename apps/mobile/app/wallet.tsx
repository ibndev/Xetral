import { useEffect, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { Link, router } from 'expo-router';
import { formatAmount } from '@xetral/client';
import type { Balance } from '@xetral/client';
import { resetXetral, xetral } from '@/session';
import { messageFor } from '@/errors';
import { useStyles, useTheme } from '@/theme';
import { BALANCE_VISIBILITY, readPreference, writePreference } from '@/preferences';

/** A fixed mask. As many dots as the amount has digits would be a picture of
 *  the number, and the digit count is most of what a glance reads. */
const MASK = '\u2022 \u2022 \u2022 \u2022 \u2022 \u2022';

export default function Wallet() {
  const styles = useStyles();
  const colors = useTheme();
  const [balances, setBalances] = useState<readonly Balance[]>([]);
  const [error, setError] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);

  /*
   * HIDDEN UNTIL THE STORED PREFERENCE SAYS OTHERWISE, and remembered across
   * launches.
   *
   * The same control the web app carries, for the same reason and with the
   * same default: somebody checks their phone in a danfo with a stranger's
   * shoulder at theirs. Starting hidden means an unread preference — a cold
   * start, a device that refuses storage — errs towards showing nothing, and
   * a moment of dots for somebody who wanted the figure costs nothing while
   * the reverse costs the whole point of the control.
   */
  const [hidden, setHidden] = useState(true);

  useEffect(() => {
    const { client } = xetral(() => router.replace('/signin'));
    void (async () => {
      try {
        setBalances(await client.balances());
      } catch (cause) {
        setError(messageFor(cause));
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  useEffect(() => {
    void (async () => {
      if ((await readPreference(BALANCE_VISIBILITY)) === 'shown') setHidden(false);
    })();
  }, []);

  function toggleVisibility() {
    const next = !hidden;
    setHidden(next);
    void writePreference(BALANCE_VISIBILITY, next ? 'hidden' : 'shown');
  }

  async function signOut() {
    await xetral().session.signOut();
    resetXetral();
    router.replace('/signin');
  }

  return (
    <ScrollView style={styles.screen}>
      <View style={styles.rowBetween}>
        <Link href="/transfer" style={styles.link}>
          Send
        </Link>
        <Link href="/add-money" style={styles.link}>
          Add money
        </Link>
      </View>

      <View style={styles.card}>
        <Text style={styles.h1}>Balances</Text>
        <Text style={styles.h2}>What you can spend right now</Text>

        <Pressable
          onPress={toggleVisibility}
          accessibilityRole="button"
          accessibilityLabel={hidden ? 'Show balances' : 'Hide balances'}
          // No background, in any state. On the web the same control was
          // painting a near-white disc behind itself because a bare `button`
          // rule outranked its class; here there is no cascade to lose to, and
          // the hit area is padding rather than a filled box.
          style={{ alignSelf: 'flex-start', paddingVertical: 10, paddingRight: 12 }}
        >
          <Text style={styles.link}>{hidden ? 'Show balances' : 'Hide balances'}</Text>
        </Pressable>

        {loading && <Text style={styles.muted}>Loading…</Text>}
        {!loading && balances.length === 0 && (
          <Text style={styles.muted}>Nothing here yet. Add money to get started.</Text>
        )}

        {balances.map((balance) => (
          <View key={balance.currency} style={[styles.row, styles.rowBetween]}>
            <View>
              {/* Formatted from the string the API sent. Nothing here goes
                  through a float — a BTC balance has eight decimals and that
                  is exactly where one starts lying. */}
              <Text style={styles.amount}>
                {hidden ? MASK : formatAmount(balance.spendable, balance.currency)}
              </Text>
              {/* A regex rather than two literals: the API sends major units,
                  so zero is "0.00" for naira, "0.000000" for USDT and
                  "0.00000000" for BTC. The two-literal check missed BTC. */}
              {!/^-?0(\.0+)?$/.test(balance.pending) && (
                <Text style={styles.muted}>
                  {hidden ? MASK : formatAmount(balance.pending, balance.currency)} pending
                </Text>
              )}
            </View>
            <Text style={styles.muted}>{balance.currency}</Text>
          </View>
        ))}

        {error !== undefined && <Text style={styles.error}>{error}</Text>}
      </View>

      <Pressable onPress={signOut}>
        <Text style={{ color: colors.text3, textAlign: 'center', paddingVertical: 12 }}>
          Sign out
        </Text>
      </Pressable>
    </ScrollView>
  );
}
