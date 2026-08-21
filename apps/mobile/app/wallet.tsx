import { useEffect, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { Link, router } from 'expo-router';
import { formatAmount } from '@xetral/client';
import type { Balance } from '@xetral/client';
import { resetXetral, xetral } from '@/session';
import { messageFor } from '@/errors';
import { colors, styles } from '@/theme';

export default function Wallet() {
  const [balances, setBalances] = useState<readonly Balance[]>([]);
  const [error, setError] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);

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

  async function signOut() {
    await xetral().session.signOut();
    resetXetral();
    router.replace('/signin');
  }

  return (
    <ScrollView style={styles.screen}>
      <View style={styles.nav}>
        <Link href="/transfer" style={styles.link}>
          Send
        </Link>
        <Link href="/add-money" style={styles.link}>
          Add money
        </Link>
      </View>

      <View style={styles.panel}>
        <Text style={styles.h1}>Balances</Text>
        <Text style={styles.h2}>What you can spend right now</Text>

        {loading && <Text style={styles.muted}>Loading…</Text>}
        {!loading && balances.length === 0 && (
          <Text style={styles.muted}>Nothing here yet. Add money to get started.</Text>
        )}

        {balances.map((balance) => (
          <View key={balance.currency} style={[styles.divider, styles.rowBetween]}>
            <View>
              {/* Formatted from the string the API sent. Nothing here goes
                  through a float — a BTC balance has eight decimals and that
                  is exactly where one starts lying. */}
              <Text style={styles.amount}>
                {formatAmount(balance.spendable, balance.currency)}
              </Text>
              {balance.pending !== '0.00' && balance.pending !== '0.000000' && (
                <Text style={styles.muted}>
                  {formatAmount(balance.pending, balance.currency)} pending
                </Text>
              )}
            </View>
            <Text style={styles.muted}>{balance.currency}</Text>
          </View>
        ))}

        {error !== undefined && <Text style={styles.error}>{error}</Text>}
      </View>

      <Pressable onPress={signOut}>
        <Text style={{ color: colors.muted, textAlign: 'center', paddingVertical: 12 }}>
          Sign out
        </Text>
      </Pressable>
    </ScrollView>
  );
}
