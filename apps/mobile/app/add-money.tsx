import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { router } from 'expo-router';
import type { VirtualAccount } from '@xetral/client';
import { xetral } from '@/session';
import { messageFor } from '@/errors';
import { styles } from '@/theme';

export default function AddMoney() {
  const [account, setAccount] = useState<VirtualAccount | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const { client } = xetral(() => router.replace('/signin'));
    void (async () => {
      try {
        setAccount(await client.fundingAccount());
      } catch (cause) {
        setError(messageFor(cause));
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  return (
    <View style={styles.screen}>
      <View style={styles.panel}>
        <Text style={styles.h1}>Add money</Text>
        <Text style={styles.h2}>Transfer from any Nigerian bank</Text>

        {loading && <Text style={styles.muted}>Getting your account number…</Text>}

        {account !== undefined && (
          <>
            <Text style={[styles.amount, { fontVariant: ['tabular-nums'] }]}>
              {account.account_number}
            </Text>
            <Text style={styles.muted}>{account.bank_name}</Text>
            <Text style={[styles.muted, { marginTop: 12 }]}>
              Send to {account.account_name}. This account is yours permanently — save it
              as a beneficiary and money you send lands in your wallet automatically.
            </Text>
          </>
        )}

        {error !== undefined && <Text style={styles.error}>{error}</Text>}
      </View>
    </View>
  );
}
