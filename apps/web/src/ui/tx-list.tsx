'use client';

import { entryKindLabel, formatAmount } from '@xetral/client';
import type { Transaction } from '@xetral/client';
import { Icon } from '@/ui/icon';
import { CurrencyMark } from '@/ui/currency-mark';

/**
 * A TRANSACTION ROW, ONCE, FOR EVERY SCREEN THAT DRAWS ONE.
 *
 * The home screen and the Activity screen each had their own, and they had
 * already drifted into two different products: home drew the comp's row —
 * an avatar with the currency on it, the descriptor under the name, the time
 * under the amount, grouped under TODAY — and Activity drew a settings list
 * inside a bordered card, with the full date where the descriptor goes, no
 * grouping and no currency. Same data, same question, two answers, and the
 * one a customer reaches by pressing "See all" was the worse of them.
 *
 * This is the argument the ledger makes about `purchase-outcome.ts` and the
 * clients make about `receipt.ts`: the copy that drifts is the one nobody is
 * looking at, and here that was the screen a customer opens when the home
 * screen's six rows were not enough.
 */

/**
 * The day a row belongs to, as a customer would say it.
 *
 * "TODAY" and "YESTERDAY" rather than a date, because those are the two days
 * a customer is actually checking against — and everything older gets the
 * date, because "3 days ago" makes a reader do arithmetic to compare it with
 * a bank statement.
 *
 * COMPARED ON THE LOCAL CALENDAR DAY, never on elapsed hours. A payment at
 * 23:50 and one at 00:10 are eleven hours apart in the same week and on two
 * different days, and a threshold in hours puts them under one heading.
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
 * CONSECUTIVE, NOT COLLECTED. Two runs of the same day stay two runs, and
 * that is deliberate rather than a limitation: history is keyset paginated on
 * the POSTING id, which is time order for ordinary traffic and deliberately
 * is not when a sweep posts today a deposit that arrived on Tuesday.
 * Collecting by date would re-sort the page and make it disagree with the
 * cursor that "Load more" pages on, which is how a list grows duplicates and
 * gaps. A heading that appears twice is the honest rendering of the order the
 * ledger returned.
 *
 * Keyed on the day AND its index for that reason: two runs of "Today" would
 * otherwise collide as React keys and the second would not render.
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
 * from the description — see `entryKindLabel`.
 */
export function TxRow({
  entry,
  onOpen,
}: {
  readonly entry: Transaction;
  readonly onOpen: (id: string) => void;
}) {
  const outgoing = entry.amount.trim().startsWith('-');
  const when = new Date(entry.occurred_at);
  return (
    <button type="button" className="tx-row" onClick={() => onOpen(entry.id)}>
      <span className="tx-mark">
        <span className="avatar">
          <Icon name={outgoing ? 'arrowUpRight' : 'download'} size={19} />
        </span>
        {/* The currency rides ON the avatar rather than beside it, so a row is
            three columns and not four — and is read at a glance without a
            label taking a line. */}
        <span className="tx-flag">
          <CurrencyMark currency={entry.currency} size={14} />
        </span>
      </span>
      <span className="tx-main">
        <span className="tx-name">{entry.destination ?? entry.description}</span>
        <span className="tx-sub">
          {entryKindLabel(entry.kind)}
          {/*
            THE PAYOUT'S LIVE STATE, because the description cannot carry it.
            A payout posts two entries and the customer has a wallet leg only
            in the first, so what they read was written at RESERVE time —
            "bank payout reserved", for ever, on money that reached the bank
            days ago. Entries are append-only and rewriting one would be wrong
            anyway: it was true when it was written.
          */}
          {entry.payout_state !== undefined && entry.payout_state !== 'sent' && (
            <>
              {' · '}
              <span className={entry.payout_state === 'returned' ? 'danger' : undefined}>
                {entry.payout_state === 'returned' ? 'returned' : 'on its way'}
              </span>
            </>
          )}
        </span>
      </span>
      <span className="tx-side">
        {/* MONEY LEAVING IS RED AND MONEY ARRIVING IS GREEN. It was red for
            neither, so the only thing separating "you were paid" from "you
            paid" at a glance was a minus sign. */}
        <span className={outgoing ? 'tx-amt out' : 'tx-amt in'}>
          {formatAmount(entry.amount, entry.currency)}
        </span>
        {/* THE TIME, NOT THE DATE, and on the RIGHT under the amount where the
            comp puts it. The day heading above already said which day. */}
        <span className="tx-time">
          {when.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}
        </span>
      </span>
    </button>
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
  return (
    <div>
      {groupByDay(entries).map((group, i) => (
        /*
          EACH DAY IS ONE CONTAINER, which is what makes the hairlines come
          out right. `.tx-row:last-child` drops its bottom border so a group
          does not end in a rule against nothing — and with every row wrapped
          in its own div, every row was a last child and NO row had a
          separator at all.
        */
        <div key={`${group.day}-${i}`}>
          <div className="day-head">{group.day}</div>
          <div>
            {group.entries.map((entry) => (
              <TxRow key={entry.id} entry={entry} onOpen={onOpen} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
