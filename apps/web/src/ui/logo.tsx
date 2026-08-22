/**
 * The Xetral mark, in ONE place.
 *
 * Two mitred chevrons facing each other — the left half of the X points
 * right, the right half points left, and they meet at a narrow notch on the
 * centre line rather than crossing. That notch is the mark's signature and
 * the first thing lost if anyone redraws this as two crossing strokes.
 *
 * TRACED FROM THE SUPPLIED ARTWORK. If a vertex is off, this file is the only
 * place to correct it: every mark in both apps renders through here — the
 * header, the sidebar, the tab bar, sign-in, sign-up — so there is no second
 * copy to drift.
 */

/** The artwork's own proportions. Slightly wider than tall. */
const VB_W = 259;
const VB_H = 223;

/**
 * The left chevron, pointing right.
 *
 * Clockwise from the top-left: out along the upper arm to the centre notch,
 * back down the lower arm to the bottom-left, then up the inner faces to the
 * shallow V that separates the two arms at the left edge.
 */
const LEFT =
  'M0 0 L46 0 L122 98 C125 102 126 105 126 111.5 C126 118 125 121 122 125 L46 223 L0 223 L80 118 C83 114.5 83 108.5 80 105 Z';

/** The right chevron: the same geometry mirrored about the centre line. */
const RIGHT =
  'M259 0 L213 0 L137 98 C134 102 133 105 133 111.5 C133 118 134 121 137 125 L213 223 L259 223 L179 118 C176 114.5 176 108.5 179 105 Z';

export interface LogoProps {
  /** Height of the mark in px. The wordmark is scaled from it. */
  readonly size?: number;
  /** Draw "etral" after the mark, so the mark IS the X. */
  readonly wordmark?: boolean;
  readonly tone?: 'brand' | 'inverse' | 'current';
  readonly className?: string;
}

function fill(tone: NonNullable<LogoProps['tone']>): string {
  return tone === 'inverse' ? '#FFFFFF' : tone === 'current' ? 'currentColor' : 'var(--brand)';
}

/** The mark alone — for a favicon, an avatar, a splash. */
export function LogoMark({ size = 28, tone = 'brand' }: Omit<LogoProps, 'wordmark'>) {
  return (
    <svg
      width={(size * VB_W) / VB_H}
      height={size}
      viewBox={`0 0 ${VB_W} ${VB_H}`}
      fill={fill(tone)}
      aria-hidden="true"
      focusable="false"
      style={{ display: 'block', flexShrink: 0 }}
    >
      <path d={LEFT} />
      <path d={RIGHT} />
    </svg>
  );
}

/**
 * The lockup: the mark AS the letter X, followed by "etral".
 *
 * IT WAS "[X] Xetral" AND THAT WAS WRONG — the mark and the word both start
 * with an X, so the brand read with the letter twice. The mark is the X now
 * and the word continues from it, which is what the artwork is for.
 *
 * Three things make it read as one word rather than a logo next to a word:
 *
 *  1. The gap is a HAIRLINE, sized from the wordmark's own tracking rather
 *     than picked — a normal icon gap would leave "X etral".
 *  2. The mark is set to the wordmark's CAP height, not its line box. A line
 *     box carries descender space nothing in "etral" uses, so matching one
 *     leaves the mark visibly oversized.
 *  3. The whole thing is labelled "Xetral" for assistive tech, and the "etral"
 *     is hidden from it — otherwise a screen reader announces the brand as
 *     "etral", which is worse than a duplicated letter.
 */
export function Logo({ size = 28, wordmark = true, tone = 'brand', className }: LogoProps) {
  if (!wordmark) return <LogoMark size={size} tone={tone} />;

  // Bricolage's cap height is ~0.72em, so a mark at `size` needs the word set
  // larger for their capitals to match.
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
          color: fill(tone),
          // A hairline, proportional to the type — not an icon gap.
          marginLeft: size * 0.09,
          // The mark's own optical centre sits a shade above the cap line.
          transform: `translateY(${size * 0.012}px)`,
        }}
      >
        etral
      </span>
    </span>
  );
}
