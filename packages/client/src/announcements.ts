import type { Announcement } from './client.js';

/**
 * WHETHER THE BELL HAS SOMETHING NEW.
 *
 * The dot used to be drawn always, as decoration — so it said "something to
 * read" whether or not there was, and a customer learnt to ignore it. It is
 * now a claim: an announcement newer than the last one this device showed.
 *
 * "Seen" is stored per device, not on the server. Nothing about a customer's
 * reading needs to cross the wire, and a dot that reappears on a second
 * device is the right answer for a message they have not read there.
 *
 * Compared as instants, never as strings, and a malformed stored value reads
 * as never seen — the dot showing once too often is the safe direction.
 */
export function hasUnread(items: readonly Announcement[], seenAt: string | null | undefined): boolean {
  const newest = newestAt(items);
  if (newest === undefined) return false;
  const seen = seenAt === null || seenAt === undefined ? Number.NaN : Date.parse(seenAt);
  return Number.isNaN(seen) || Date.parse(newest) > seen;
}

/** The newest announcement's time, which becomes "seen" once the feed is opened. */
export function newestAt(items: readonly Announcement[]): string | undefined {
  let best: string | undefined;
  for (const item of items) {
    if (Number.isNaN(Date.parse(item.at))) continue;
    if (best === undefined || Date.parse(item.at) > Date.parse(best)) best = item.at;
  }
  return best;
}
