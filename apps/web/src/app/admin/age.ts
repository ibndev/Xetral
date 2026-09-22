/**
 * How long ago, in words an operator can act on.
 *
 * WHY THIS IS SHARED RATHER THAN PER SCREEN. `prices/page.tsx` wrote exactly
 * this, with exactly this reasoning above it, and twenty-four other admin
 * screens went on rendering `new Date(x).toLocaleString()` — "9/18/2026,
 * 12:31:06 PM". That is the wrong answer to the question those columns exist
 * to ask. The overview's queue table is the clearest case: the column is
 * headed OLDEST, which is a question about AGE, and a timestamp makes a
 * reviewer do the subtraction in their head against a clock they cannot see.
 * 015's metrics rule says the same thing from the other side — a queue of
 * three that has been three since Tuesday is a queue nobody is working, and
 * depth alone cannot say so.
 *
 * WHOLE UNITS, and coarser as it grows: "3d" is a decision and "72h" is
 * arithmetic. Nothing here is a duration a customer reads, so there is no
 * localisation to get wrong.
 */

/** Seconds, as the API sends them where it sends an age directly. */
export function ageOf(seconds: string | number | undefined | null): string {
  if (seconds === undefined || seconds === null) return '—';
  const value = typeof seconds === 'string' ? Number(seconds) : seconds;
  if (!Number.isFinite(value)) return '—';
  if (value < 60) return 'just now';
  if (value < 3600) return `${Math.max(1, Math.round(value / 60))}m`;
  if (value < 86_400) return `${Math.round(value / 3600)}h`;
  return `${Math.round(value / 86_400)}d`;
}

/**
 * A timestamp, as an age against the reader's own clock.
 *
 * A FUTURE INSTANT IS NOT A NEGATIVE AGE. `due_at` is a deadline, so it is
 * routinely ahead of now, and `Math.round` on a negative would render "-2d"
 * — which reads as two days overdue when it means two days remaining, the
 * exact inversion a reviewer must not make. It answers "in 2d" instead, and
 * whether something IS overdue is read off the view's own boolean rather than
 * derived here: a browser with a wrong date must not be able to make a missed
 * deadline look answered.
 */
export function ageSince(iso: string | undefined | null): string {
  if (iso === undefined || iso === null || iso === '') return '—';
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return '—';
  const seconds = (Date.now() - then) / 1000;
  return seconds < 0 ? `in ${ageOf(-seconds)}` : ageOf(seconds);
}

/**
 * "5m ago", or "just now" on its own — `${ageSince(x)} ago` printed "just
 * now ago" on the authenticator screen, which is how a sentence built from
 * two helpers reads when neither knew about the other.
 */
export function ago(iso: string | undefined | null): string {
  const age = ageSince(iso);
  return age === '—' || age === 'just now' || age.startsWith('in ') ? age : `${age} ago`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "2 Sep 2026", as the comp writes a date. `en-GB` says "Sept". */
export function shortDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}
