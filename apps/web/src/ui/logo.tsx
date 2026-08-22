/**
 * The Xetral mark, in ONE place.
 *
 * THE PATH DATA BELOW IS THE SUPPLIED GEOMETRIC TRACE, VERBATIM. Two closed
 * polygons, straight segments only, no curves — copied from
 * `xetrallogogeometry.html` rather than redrawn. Earlier versions of this
 * file were traced by eye from a raster and were wrong twice over: the first
 * welded the halves into a solid X, the second separated them into "> <".
 * Do not "clean up" or re-round these coordinates; the notched waist on the
 * left chevron and the gap down the middle are the mark, not artefacts.
 *
 * Every mark in both apps renders through here — header, sidebar, tab bar,
 * sign-in, sign-up — so there is no second copy to drift. The mobile file
 * carries the same two strings and must change with this one.
 */

const VB_W = 539;
const VB_H = 474;

const RIGHT_CHEVRON =
  'M539 459l-162 -199l-14 -19l1 -10l5 -7l130 -153h-110l-6 2l-4 2l-13 14l-124 142' +
  'l-4 8v13l2 5l150 185l11 12l12 5z';

const LEFT_CHEVRON =
  'M0 1l158 197l2 1l29 38v8l-5 8l-95 115l-69 86l-2 1l-14 19l5 -1h131l4 -1l7 -3' +
  'l8 -7l105 -132v-7l-2 -4l-2 -1l-6 -9l-33 -40l-5 -10l-2 -9v-9l3 -12l7 -12l49 -59' +
  'l5 -7v-5l-15 -21l-69 -86l-22 -27l-8 -7l-13 -5h-143l-1 1l-5 -1z';

export interface LogoProps {
  /** Height of the mark in px. The wordmark is scaled from it. */
  readonly size?: number;
  /** Draw "etral" after the mark, so the mark IS the X. */
  readonly wordmark?: boolean;
  readonly tone?: 'brand' | 'inverse' | 'current';
  readonly className?: string;
}

function colourOf(tone: NonNullable<LogoProps['tone']>): string {
  return tone === 'inverse' ? '#FFFFFF' : tone === 'current' ? 'currentColor' : 'var(--brand)';
}

/** The mark alone — for a favicon, an avatar, a splash. */
export function LogoMark({ size = 28, tone = 'brand' }: Omit<LogoProps, 'wordmark'>) {
  return (
    <svg
      width={(size * VB_W) / VB_H}
      height={size}
      viewBox={`0 0 ${VB_W} ${VB_H}`}
      fill={colourOf(tone)}
      aria-hidden="true"
      focusable="false"
      style={{ display: 'block', flexShrink: 0 }}
    >
      <path d={RIGHT_CHEVRON} />
      <path d={LEFT_CHEVRON} />
    </svg>
  );
}

/**
 * The lockup: the mark AS the letter X, followed by "etral".
 *
 * It used to draw the mark beside the full word, so the brand read with the
 * letter twice — "X Xetral". Three things make this read as one word instead
 * of a logo next to a word, and all three live here because doing them at
 * each call site is how it ends up right on one screen and wrong on five:
 *
 *  1. The gap is a HAIRLINE sized from the wordmark's own tracking. A normal
 *     icon gap would leave "X etral".
 *  2. The mark is set to the wordmark's CAP height, so the word is drawn at
 *     size/0.72 — Bricolage's cap height. Matching the line box instead makes
 *     the mark look oversized, because a line box carries descender space
 *     that nothing in "etral" uses.
 *  3. The whole thing is labelled "Xetral" for assistive tech and the visible
 *     "etral" is hidden from it. A screen reader announcing the brand as
 *     "etral" would be a worse bug than the duplicate letter was.
 */
export function Logo({ size = 28, wordmark = true, tone = 'brand', className }: LogoProps) {
  if (!wordmark) return <LogoMark size={size} tone={tone} />;

  const fontSize = Math.round(size / 0.72);

  return (
    <span
      className={className}
      role="img"
      aria-label="Xetral"
      style={{ display: 'inline-flex', alignItems: 'center', lineHeight: 1 }}
    >
      <LogoMark size={size} tone={tone} />
      <span
        aria-hidden="true"
        style={{
          fontFamily: 'var(--font-display)',
          fontWeight: 800,
          fontSize,
          letterSpacing: '-0.03em',
          color: colourOf(tone),
          // Negative: the mark's right edge is a WEDGE, not a flat side — the
          // chevron's arms reach the full width only at the very top and
          // bottom, so a zero gap still reads as "X etral". The 'e' is tucked
          // into that notch. Measured across 28/40/64px against the real
          // Bricolage file; -0.08 begins to collide at display sizes.
          marginLeft: size * -0.05,
        }}
      >
        etral
      </span>
    </span>
  );
}
