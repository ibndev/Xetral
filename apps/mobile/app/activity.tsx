import { useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { ACTIVITY_FILTERS, formatAmount } from '@xetral/client';
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

  /*
   * FIVE FILTERS, ALWAYS THE SAME FIVE.
   *
   * The rail was built from the customer's own balances, so it appeared only
   * when they held more than one currency and showed a different set to every
   * customer — a control that comes and goes is one nobody learns. Worse, it
   * offered whatever happened to be held rather than what can be read.
   *
   * Four of the five are currencies and one is not: gift cards settle in
   * NAIRA, so "Gift" is the naira history narrowed to the two entry kinds a
   * gift card produces. `ACTIVITY_FILTERS` is shared with the web app so both
   * express that the same way.
   */
  const [filterId, setFilterId] = useState('NGN');
  const filter = ACTIVITY_FILTERS.find((f) => f.id === filterId) ?? ACTIVITY_FILTERS[0];
  const currency = filter.currency;
  const kinds = 'kinds' in filter ? filter.kinds : undefined;

  const [pages, setPages] = useState<readonly Transaction[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);

  const first = useLoad(async () => {
    const page = await client.transactions(currency, undefined, kinds);
    setPages(page.entries);
    setCursor(page.nextCursor);
    return page;
  }, [client, currency, kinds]);

  const [paging, setPaging] = useState(false);

  async function loadMore() {
    if (cursor === null || paging) return;
    setPaging(true);
    try {
      const page = await client.transactions(currency, cursor, kinds);
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

      {/*
        ONE HORIZONTAL LINE that scrolls inside itself, rather than a cloud
        that wraps. Five labels do not fit across a narrow handset, and a rail
        that wraps to a second row moves the tabs under the thumb as the
        selection changes width. "Gift", not "Gift Card", for the same reason.
      */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ flexDirection: 'row', gap: 6, paddingRight: space.md }}
        style={{ marginTop: space.md, flexGrow: 0 }}
      >
        {ACTIVITY_FILTERS.map((f) => {
          const on = f.id === filterId;
          return (
            <Pressable
              key={f.id}
              onPress={() => setFilterId(f.id)}
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
                {f.label}
              </Text>
            </Pressable>
          );
        })}
      </ScrollView>

      <View style={[styles.card, { marginTop: space.md }]}>
        {first.loading && <Loading />}
        {!first.loading && pages.length === 0 && (
          <Empty
            icon="file"
            title={`No ${filter.label} transactions yet`}
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
