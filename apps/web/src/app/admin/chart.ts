/*
 * The two pieces of chart arithmetic the operations screens share. Written
 * once, because the Overview and Earnings draw the same curve and state the
 * same change, and two copies of either would drift.
 */

/**
 * Day on day, to one decimal, WITHOUT a float: the ratio is taken in bigint
 * and only the final tenth-of-a-percent is a number, which is a count of
 * tenths rather than an amount of money.
 */
export function change(now: bigint, before: bigint): { text: string; up: boolean } | undefined {
  if (before === 0n) return now === 0n ? undefined : { text: 'new', up: true };
  const tenths = ((now - before) * 1000n) / (before < 0n ? -before : before);
  const up = tenths >= 0n;
  const abs = up ? tenths : -tenths;
  return { text: `${up ? '▲' : '▼'} ${abs / 10n}.${abs % 10n}%`, up };
}

/** A smooth path through the points — Catmull-Rom as cubic Béziers, which is
 *  what the comp's hand-drawn curve is. */
export function smooth(points: readonly (readonly [number, number])[]): string {
  if (points.length === 0) return '';
  const [first] = points;
  let d = `M${first![0].toFixed(1)},${first![1].toFixed(1)}`;
  for (let i = 0; i < points.length - 1; i += 1) {
    const p0 = points[i - 1] ?? points[i]!;
    const p1 = points[i]!;
    const p2 = points[i + 1]!;
    const p3 = points[i + 2] ?? p2;
    /* The control points are held between their two ends' heights, so a
       quiet hour next to a busy one does not dip BELOW zero on the way — a
       curve that shows negative entries is drawing something that did not
       happen. */
    const lo = Math.min(p1[1], p2[1]);
    const hi = Math.max(p1[1], p2[1]);
    const clamp = (y: number) => Math.min(hi, Math.max(lo, y));
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, clamp(p1[1] + (p2[1] - p0[1]) / 6)];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, clamp(p2[1] - (p3[1] - p1[1]) / 6)];
    d += ` C${c1[0]!.toFixed(1)},${c1[1]!.toFixed(1)} ${c2[0]!.toFixed(1)},${c2[1]!.toFixed(1)} ${p2[0].toFixed(1)},${p2[1].toFixed(1)}`;
  }
  return d;
}

