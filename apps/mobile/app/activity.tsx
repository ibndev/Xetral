import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { formatAmount } from '@xetral/client';
import type { Transaction } from '@xetral/client';
import { Icon } from '@/icon';
import { Shell } from '@/shell';
import { Empty, FormError, Loading } from '@/ui';
import { useLoad, useXetral } from '@/hooks';
import { radius, space, useStyles, useTheme } from '@/theme';

/**
 * Every transaction, one currency at a time.
 *
 * KEYSET PAGINATED, like the web's, and for the reason the ledger records:
 * `OFFSET` shifts under an active account, producing duplicates and gaps. The
 * cursor is the previous page's last posting id, which cannot move.
 *
 * It shows only the customer's own LEG. A transfer is −₦5,050 to the sender
 * and +₦5,000 to the recipient; neither wants the other's side or the fee.
 */
export default function Activity() {
  const client = useXetral();
  const styles = useStyles();
  const colors = useTheme();

  const balances = useLoad(() => client.balances(), [client]);
  const currencies = balances.data?.map((b) => b.currency) ?? ['NGN'];
  const [currency, setCurrency] = useState('NGN');

  const [pages, setPages] = useState<readonly Transaction[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);

  const first = useLoad(async () => {
    const page = await client.transactions(currency);
    setPages(page.entries);
    setCursor(page.nextCursor);
    return page;
  }, [client, currency]);

  const [paging, setPaging] = useState(false);

  async function loadMore() {
    if (cursor === null || paging) return;
    setPaging(true);
    try {
      const page = await client.transactions(currency, cursor);
      // Appended, never replaced. The cursor is the previous page's last
      // POSTING id, so a new entry arriving mid-scroll cannot shift what has
      // already been read past.
      setPages((was) => [...was, ...page.entries]);
      setCursor(page.nextCursor);
    } finally {
      setPaging(false);
    }
  }

  return (
    <Shell>
      <Text style={styles.h1}>Activity</Text>
      <Text style={styles.lead}>Your side of every entry, newest first.</Text>

      {currencies.length > 1 && (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: space.md }}>
          {currencies.map((code) => {
            const on = code === currency;
            return (
              <Pressable
                key={code}
                onPress={() => setCurrency(code)}
                accessibilityRole="tab"
                accessibilityState={{ selected: on }}
                style={{
                  paddingHorizontal: 14,
                  paddingVertical: 8,
                  borderRadius: radius.pill,
                  backgroundColor: on ? colors.brand : colors.surface2,
                }}
              >
                <Text
                  style={{
                    fontSize: 13,
                    fontWeight: '600',
                    color: on ? colors.onBrand : colors.text2,
                  }}
                >
                  {code}
                </Text>
              </Pressable>
            );
          })}
        </View>
      )}

      <View style={[styles.card, { marginTop: space.md }]}>
        {first.loading && <Loading />}
        {!first.loading && pages.length === 0 && (
          <Empty
            icon="file"
            title={`No ${currency} transactions yet`}
            hint="Money you send or receive shows up here."
          />
        )}

        {pages.map((t) => {
          const outgoing = t.amount.trim().startsWith('-');
          return (
            <View key={t.id} style={styles.row}>
              <View style={styles.rowIcon}>
                <Icon
                  name={outgoing ? 'arrowUpRight' : 'download'}
                  size={18}
                  color={colors.text2}
                />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={{ color: colors.text, fontWeight: '600' }} numberOfLines={1}>
                  {t.description}
                </Text>
                <Text style={styles.muted}>
                  {new Date(t.occurred_at).toLocaleString(undefined, {
                    day: 'numeric',
                    month: 'short',
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </Text>
              </View>
              <Text style={[styles.amount, outgoing ? undefined : { color: colors.ok }]}>
                {formatAmount(t.amount, t.currency)}
              </Text>
            </View>
          );
        })}

        {cursor !== null && (
          <Pressable
            onPress={() => void loadMore()}
            accessibilityRole="button"
            style={{ paddingVertical: space.md, alignItems: 'center' }}
          >
            <Text style={styles.link}>{paging ? 'Loading…' : 'Load more'}</Text>
          </Pressable>
        )}

        <FormError error={first.error} code={first.code} />
      </View>
    </Shell>
  );
}
