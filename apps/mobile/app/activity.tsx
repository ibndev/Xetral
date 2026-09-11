import { useState } from 'react';
import { Modal, Pressable, ScrollView, Share, Text, View } from 'react-native';
import { activityFiltersFor, formatAmount, receiptText, statusWords } from '@xetral/client';
import type { Transaction } from '@xetral/client';
import { Icon } from '@/icon';
import { Shell } from '@/shell';
import { Button, Empty, FormError, Loading } from '@/ui';
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
        {FILTERS.map((f) => {
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
                  fontFamily: font.sansSemi,
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
            /*
              A ROW IS A BUTTON. Everything a handset row cannot hold — the fee,
              the reference, the destination in full, what has happened since —
              is one deliberate tap away rather than crammed in or left out.

              `android_ripple={null}` for the reason every icon button refuses
              it: a disc lighting up behind a line of text reads as a shape
              rather than as a state.
            */
            <Pressable
              key={t.id}
              accessibilityRole="button"
              android_ripple={null}
              onPress={() => setOpen(t.id)}
              style={styles.row}
            >
              <View style={styles.rowIcon}>
                <Icon
                  name={outgoing ? 'arrowUpRight' : 'download'}
                  size={18}
                  color={colors.text2}
                />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={{ color: colors.text, fontFamily: font.sansSemi }} numberOfLines={1}>
                  {t.destination ?? t.description}
                </Text>
                <Text style={styles.muted}>
                  {new Date(t.occurred_at).toLocaleString(undefined, {
                    day: 'numeric',
                    month: 'short',
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                  {/*
                    THE PAYOUT'S LIVE STATE, because the description cannot
                    carry it: a payout posts two entries and the customer has a
                    wallet leg only in the first, so what they read was written
                    at RESERVE time and said so for ever.
                  */}
                  {t.payout_state !== undefined && t.payout_state !== 'sent'
                    ? ` · ${t.payout_state === 'returned' ? 'returned' : 'on its way'}`
                    : ''}
                </Text>
              </View>
              {/*
                MONEY LEAVING IS RED AND MONEY ARRIVING IS GREEN. It was red for
                neither: an outgoing figure took the default text colour, so the
                only thing separating "you were paid" from "you paid" at a
                glance was a minus sign and a small arrow.
              */}
              <Text
                style={[styles.amount, { color: outgoing ? colors.danger : colors.ok }]}
              >
                {formatAmount(t.amount, t.currency)}
              </Text>
            </Pressable>
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
      {open !== undefined && (
        <TransactionSheet id={open} onClose={() => setOpen(undefined)} />
      )}
    </Shell>
  );
}

/**
 * ONE TRANSACTION, IN FULL, AND A WAY TO SEND IT ON.
 *
 * THE SHARE IS THE POINT rather than a decoration. The question a customer is
 * answering when they open a transaction is almost always somebody else's —
 * "did you send it?" — and before this the only answer available was a
 * screenshot of a list row, which carries no reference and no destination.
 *
 * `Share.share` with the text the web builds from the same function, so a
 * receipt forwarded from a phone and one copied from a laptop say the same
 * thing.
 */
function TransactionSheet({ id, onClose }: { id: string; onClose: () => void }) {
  const client = useXetral();
  const styles = useStyles();
  const colors = useTheme();
  const detail = useLoad(() => client.transaction(id), [client, id]);
  const t = detail.data;

  return (
    <Modal visible animationType="slide" transparent onRequestClose={onClose}>
      <Pressable
        style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' }}
        onPress={onClose}
        android_ripple={null}
      >
        {/* Stops a tap inside the sheet from closing it. */}
        <Pressable
          android_ripple={null}
          onPress={() => undefined}
          style={{
            backgroundColor: colors.surface,
            borderTopLeftRadius: radius.lg,
            borderTopRightRadius: radius.lg,
            padding: space.lg,
            paddingBottom: space.xl,
            maxHeight: '88%',
          }}
        >
          <ScrollView>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
              <Text style={styles.h2}>Transaction</Text>
              <Pressable accessibilityLabel="Close" onPress={onClose} android_ripple={null}>
                <Icon name="close" size={20} color={colors.text2} />
              </Pressable>
            </View>

            {detail.loading && <Loading />}
            <FormError error={detail.error} code={detail.code} />

            {t !== undefined && (
              <>
                <Text style={[styles.amount, { fontSize: 28, marginTop: space.sm }]}>
                  {formatAmount(t.amount, t.currency)}
                </Text>
                <Text style={styles.lead}>{statusWords(t)}</Text>

                <Row label="What" value={t.description} />
                {t.beneficiary !== undefined && <Row label="To" value={t.beneficiary} />}
                {t.bank_name !== undefined && (
                  <Row
                    label="Bank"
                    value={`${t.bank_name}${
                      t.account_number === undefined ? '' : ` ••${t.account_number.slice(-4)}`
                    }`}
                  />
                )}
                {/* The fee as its own line: a transfer that charges one is two
                    postings against the same wallet, and a customer who can see
                    only the total cannot reconcile it against their balance. */}
                {t.fee !== undefined && !/^0([.,]0+)?$/.test(t.fee) && (
                  <Row label="Fee" value={formatAmount(t.fee, t.currency)} />
                )}
                <Row label="Date" value={new Date(t.occurred_at).toLocaleString()} />
                <Row label="Reference" value={t.reference} />
                {t.narration !== undefined && t.narration !== null && t.narration !== '' && (
                  <Row label="Note" value={t.narration} />
                )}

                <Button
                  label="Share receipt"
                  icon="copy"
                  onPress={() => {
                    // A dismissed share sheet rejects, and that is not an error
                    // worth reporting to anybody.
                    void Share.share({ message: receiptText(t) }).catch(() => undefined);
                  }}
                />
              </>
            )}
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  const styles = useStyles();
  return (
    <View style={styles.row}>
      <Text style={[styles.muted, { flex: 1 }]}>{label}</Text>
      <Text style={[styles.muted, { flex: 1, textAlign: 'right' }]} numberOfLines={2}>
        {value}
      </Text>
    </View>
  );
}
