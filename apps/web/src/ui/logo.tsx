/**
 * The Xetral mark, in ONE place.
 *
 * ─────────────────────────────────────────────────────────────────────────
 *  THIS IS NOT THE TRACED LOGO. The mockup that was handed over renders its
 *  brand mark as the LETTER "X" set in Bricolage Grotesque 800 inside a
 *  rounded square — there is no traced path in it, and the bundle it shipped
 *  in carries only fonts and JavaScript, no SVG or image assets at all.
 *
 *  So the geometry below is a stand-in built to the same brand: the navy and
 *  amber of the mockup, an X cut from two crossing strokes with the counters
 *  left open so it holds together at 20px in a tab bar.
 *
 *  WHEN THE REAL TRACED SVG ARRIVES, replace the contents of <Mark> and
 *  nothing else. Every logo in both apps renders through this file — the
 *  header, the tab bar, the sign-in screen, the favicon — so the swap is one
 *  edit and cannot leave a stale copy behind somewhere.
 * ─────────────────────────────────────────────────────────────────────────
 */

export interface LogoProps {
  /** Height of the mark in px. The wordmark scales from it. */
  readonly size?: number;
  /** Draw "Xetral" beside the mark. */
  readonly wordmark?: boolean;
  /** Override the mark colour; defaults to the brand navy via currentColor. */
  readonly tone?: 'brand' | 'inverse' | 'current';
  readonly className?: string;
}

/**
 * The mark alone.
 *
 * Square viewBox and a padded glyph, deliberately: a mark that fills its box
 * edge to edge cannot be dropped into a circular avatar or a tab bar without
 * being re-cropped, and someone will eventually do that badly.
 */
function Mark({ size, tone }: { size: number; tone: NonNullable<LogoProps['tone']> }) {
  const stroke =
    tone === 'inverse' ? '#FFFFFF' : tone === 'current' ? 'currentColor' : 'var(--brand)';

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      fill="none"
      aria-hidden="true"
      focusable="false"
      style={{ display: 'block', flexShrink: 0 }}
    >
      {/*
        Two strokes, not a letterform. A real X glyph carries the typeface's
        optical corrections and stops reading as a logo the moment it sits
        next to the same typeface set as text.
      */}
      <path
        d="M11 10 L37 38"
        stroke={stroke}
        strokeWidth="7.5"
        strokeLinecap="round"
      />
      <path
        d="M37 10 L11 38"
        stroke={stroke}
        strokeWidth="7.5"
        strokeLinecap="round"
      />
      {/*
        The amber accent, carried over from the brand: it sits on the
        descending stroke only, so the mark has a direction and does not read
        as a symmetrical cross.
      */}
      <path
        d="M26.5 27.5 L37 38"
        stroke="var(--accent)"
        strokeWidth="7.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

/**
 * Mark plus wordmark, locked together.
 *
 * The alignment is the fiddly part and the reason this is a component rather
 * than two tags at each call site. The mark is optically centred on the
 * wordmark's CAP HEIGHT, not on its line box — line boxes include descender
 * space that nothing in "Xetral" uses, so centring on one leaves the mark
 * visibly high. The mark is set to 1.16× the cap height and nudged down by
 * the residual, which is what makes it sit level with the X of the word at
 * every size, on both platforms.
 */
export function Logo({
  size = 28,
  wordmark = true,
  tone = 'brand',
  className,
}: LogoProps) {
  const fontSize = Math.round(size * 0.86);

  return (
    <span
      className={className}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: Math.round(size * 0.3),
        lineHeight: 1,
      }}
    >
      <Mark size={size} tone={tone} />
      {wordmark && (
        <span
          style={{
            fontFamily: 'var(--font-display)',
            fontWeight: 800,
            fontSize,
            // Bricolage is wide; a touch negative brings the wordmark back to
            // the mark without the letters touching.
            letterSpacing: '-0.02em',
            color: tone === 'inverse' ? '#FFFFFF' : tone === 'current' ? 'currentColor' : 'var(--brand)',
            // Cap-height centring: nudge the text baseline rather than the
            // mark, so the mark stays on the pixel grid and never blurs.
            transform: 'translateY(0.045em)',
          }}
        >
          Xetral
        </span>
      )}
    </span>
  );
}
