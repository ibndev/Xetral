import { useState } from 'react';
import { Pressable, ScrollView, Text } from 'react-native';
import { activityFiltersFor } from '@xetral/client';
import type { Transaction } from '@xetral/client';
import { Shell } from '@/shell';
import { Empty, FormError, Loading } from '@/ui';
import { TxList } from '@/tx-list';
import { TransactionSheet } from '@/transaction-sheet';
import { useLoad, useXetral } from '@/hooks';
import { font, radius, space, useStyles, useTheme } from '@/theme';

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
   * gift card produces. `activityFiltersFor` is shared with the web app so both
   * express that the same way.
   */
  /*
   * THE RAIL IS THE CUSTOMER'S OWN, matching the web. It was the five-entry
   * constant rendered literally, so somebody in Accra had no cedi tab at all
   * — the currency their balance is in.
   */
  const session = useLoad(() => client.currentSession(), [client]);
  const balances = useLoad(() => client.balances(), [client]);
  const held = (balances.data ?? []).map((b) => b.currency);
  const FILTERS = activityFiltersFor(session.data?.home_currency ?? 'NGN', held);

  const [filterId, setFilterId] = useState<string | undefined>();
  const filter = FILTERS.find((f) => f.id === filterId) ?? FILTERS[0];
  const currency = filter.currency;
  const kinds = 'kinds' in filter ? filter.kinds : undefined;

  const [pages, setPages] = useState<readonly Transaction[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  // Which row is open, by id rather than by index: the list grows as pages
  // load, so an index would point at a different transaction after a Load more.
  const [open, setOpen] = useState<string | undefined>(undefined);

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
        THE COMP'S CHIP RAIL — one horizontal line that scrolls inside itself
        rather than a cloud that wraps: a rail that wraps moves the tabs under
        the thumb as the selection changes width. "Gift", not "Gift Card", for
        the same reason.

        IRIS, NOT `brand`. The comp fills the active chip with the accent, and
        `brand` is #FFFFFF in dark — so the selected filter was a white lozenge
        on a black screen, the only pure-white object on it and louder than the
        figures it was filtering. The web's chip had exactly the same fault.
      */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ flexDirection: 'row', gap: 8, paddingRight: space.md }}
        style={{ marginTop: space.md, flexGrow: 0 }}
      >
        {FILTERS.map((f) => {
          const on = f.id === filter.id;
          return (
            <Pressable
              key={f.id}
              onPress={() => setFilterId(f.id)}
              accessibilityRole="tab"
              accessibilityState={{ selected: on }}
              android_ripple={null}
              style={{
                paddingHorizontal: 14,
                paddingVertical: 8,
                borderRadius: radius.pill,
                backgroundColor: on ? colors.iris : colors.surface2,
              }}
            >
              <Text
                style={{
                  fontSize: 12.5,
                  fontFamily: font.sansSemi,
                  color: on ? colors.onIris : colors.text2,
                }}
              >
                {f.label}
              </Text>
            </Pressable>
          );
        })}
      </ScrollView>

      {first.loading && <Loading />}
      {!first.loading && pages.length === 0 && (
        <Empty
          icon="file"
          title={`No ${filter.label} transactions yet`}
          hint="Money you send or receive shows up here."
        />
      )}

      {/*
        NOT IN A CARD. The comp's activity is rows on the screen under day
        headings, and the panel round them was what made this read as a
        settings list rather than as the home screen's own list continued.
      */}
      <TxList entries={pages} onOpen={setOpen} />

      {cursor !== null && (
        <Pressable
          onPress={() => void loadMore()}
          accessibilityRole="button"
          android_ripple={null}
          style={{ paddingVertical: space.md, alignItems: 'center' }}
        >
          <Text style={styles.link}>{paging ? 'Loading…' : 'Load more'}</Text>
        </Pressable>
      )}

      <FormError error={first.error} code={first.code} />

      {open !== undefined && (
        <TransactionSheet id={open} onClose={() => setOpen(undefined)} />
      )}
    </Shell>
  );
}
