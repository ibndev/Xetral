import { Pressable, Text, View } from 'react-native';
import { entryKindLabel, entryTitle, formatAmount } from '@xetral/client';
import type { Transaction } from '@xetral/client';
import { Icon } from '@/icon';
import { CurrencyMark } from '@/currency-mark';
import { font, useTheme } from '@/theme';

/**
 * A TRANSACTION ROW, ONCE, FOR EVERY SCREEN THAT DRAWS ONE.
 *
 * The home screen and the Activity screen each had their own, and they had
 * already drifted into two different products — the same split the web app
 * had, fixed there in `ui/tx-list.tsx` and fixed here for the same reason.
 * Home drew the comp's row: an avatar with the currency on it, the descriptor
 * under the name, the time under the amount, grouped under TODAY. Activity
 * drew a settings list inside a card, with the full date where the descriptor
 * goes and no currency at all.
 *
 * The two apps keep two copies of this because they are two rendering
 * systems, not because the design differs: the numbers here are the web's, to
 * the character, and `activity-row.test.ts` is what holds them together.
 */

/**
 * The day a transaction happened, as somebody would say it out loud.
 *
 * COMPARED ON THE LOCAL CALENDAR DAY, never on elapsed hours. A payment at
 * 23:50 and one at 00:10 are eleven hours apart and on two different days,
 * and a threshold in hours puts them under one heading.
 */
export function dayOf(when: Date): string {
  const midnight = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((midnight(new Date()) - midnight(when)) / 86_400_000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return when.toLocaleDateString(undefined, { day: 'numeric', month: 'long' });
}

/**
 * The list, cut into consecutive runs of one day.
 *
 * CONSECUTIVE, NOT COLLECTED. History is keyset paginated on the POSTING id,
 * which is time order for ordinary traffic and deliberately is not when a
 * sweep posts today a deposit that arrived on Tuesday. Collecting by date
 * would re-sort the page and make it disagree with the cursor "Load more"
 * pages on, which is how a list grows duplicates and gaps. A heading that
 * appears twice is the honest rendering of the order the ledger returned.
 */
export function groupByDay(
  entries: readonly Transaction[],
): readonly { readonly day: string; readonly entries: readonly Transaction[] }[] {
  const out: { day: string; entries: Transaction[] }[] = [];
  for (const entry of entries) {
    const day = dayOf(new Date(entry.occurred_at));
    const last = out[out.length - 1];
    if (last !== undefined && last.day === day) last.entries.push(entry);
    else out.push({ day, entries: [entry] });
  }
  return out;
}

/**
 * ONE ROW: who, what it was, and the amount with its time under it.
 *
 * The descriptor comes from the entry's `kind`, which is a closed enum, never
 * from the free-text description.
 *
 * `android_ripple={null}` for the reason every icon button refuses it: a disc
 * lighting up behind a line of text reads as a shape rather than as a state.
 */
export function TxRow({
  entry,
  onOpen,
}: {
  readonly entry: Transaction;
  readonly onOpen: (id: string) => void;
}) {
  const colors = useTheme();
  const outgoing = entry.amount.trim().startsWith('-');
  const when = new Date(entry.occurred_at);
  return (
    <Pressable
      accessibilityRole="button"
      android_ripple={null}
      onPress={() => onOpen(entry.id)}
      style={{
        flexDirection: 'row', alignItems: 'center', gap: 13,
        paddingVertical: 12,
        borderTopWidth: 1, borderTopColor: colors.line,
      }}
    >
      <View>
        <View
          style={{
            width: 44, height: 44, borderRadius: 999,
            alignItems: 'center', justifyContent: 'center',
            backgroundColor: colors.surface2,
          }}
        >
          <Icon name={outgoing ? 'arrowUpRight' : 'download'} size={19} color={colors.text2} />
        </View>
        {/* The currency rides ON the avatar rather than beside it, so a row is
            two columns and not three — read at a glance without a label
            taking a line. */}
        <View style={{ position: 'absolute', bottom: -1, left: -2 }}>
          <CurrencyMark currency={entry.currency} size={14} />
        </View>
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text
          numberOfLines={1}
          style={{ color: colors.text, fontFamily: font.sansSemi, fontSize: 15 }}
        >
          {entry.destination ?? entryTitle(entry.description, entry.kind)}
        </Text>
        <Text
          numberOfLines={1}
          style={{ color: colors.text3, fontFamily: font.sansMedium, fontSize: 12.5, marginTop: 2 }}
        >
          {entryKindLabel(entry.kind)}
          {entry.payout_state !== undefined && entry.payout_state !== 'sent'
            ? ` · ${entry.payout_state === 'returned' ? 'returned' : 'on its way'}`
            : ''}
        </Text>
      </View>
      {/*
        MONEY LEAVING IS RED AND MONEY ARRIVING IS GREEN. It was red for
        neither, so the only thing separating "you were paid" from "you paid"
        at a glance was a minus sign.

        THE EYE HIDES THE BALANCE, NOT THE HISTORY. This line once masked the
        history too, which the web has never done, and it produced a list
        reading "Bank payout failed • • • • • •" with nothing on screen
        connecting the dots to a toggle tapped days earlier.
      */}
      <View style={{ alignItems: 'flex-end' }}>
        <Text
          style={{
            fontFamily: font.numSemi, fontSize: 14.5,
            letterSpacing: -0.3,
            fontVariant: ['tabular-nums'] as ('tabular-nums')[],
            color: outgoing ? colors.danger : colors.ok,
          }}
        >
          {formatAmount(entry.amount, entry.currency)}
        </Text>
        {/* THE TIME, ON THE RIGHT UNDER THE AMOUNT, where the comp puts it.
            The day heading above already said which day. */}
        <Text style={{ color: colors.text3, fontFamily: font.sansMedium, fontSize: 11.5, marginTop: 2 }}>
          {when.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}
        </Text>
      </View>
    </Pressable>
  );
}

/** Every row, under its day. */
export function TxList({
  entries,
  onOpen,
}: {
  readonly entries: readonly Transaction[];
  readonly onOpen: (id: string) => void;
}) {
  const colors = useTheme();
  return (
    <View>
      {groupByDay(entries).map((group, i) => (
        <View key={`${group.day}-${i}`}>
          <Text
            style={{
              color: colors.text3, fontFamily: font.sansBold,
              fontSize: 11, letterSpacing: 1.1,
              textTransform: 'uppercase',
              paddingTop: 8, paddingBottom: 4,
            }}
          >
            {group.day}
          </Text>
          {group.entries.map((entry) => (
            <TxRow key={entry.id} entry={entry} onOpen={onOpen} />
          ))}
        </View>
      ))}
    </View>
  );
}
