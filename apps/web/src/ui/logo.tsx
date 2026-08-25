/**
 * The Xetral mark, in ONE place.
 *
 * THE PATH DATA BELOW IS THE SUPPLIED GEOMETRIC TRACE, VERBATIM. Two closed
 * polygons, straight segments only — copied from `xetrallogogeometry.html`
 * rather than redrawn. Earlier versions of this file were traced by eye from a
 * raster and were wrong twice over: the first welded the halves into a solid
 * X, the second separated them into "> <". Do not "clean up" or re-round these
 * coordinates; the notched waist on the left chevron and the gap down the
 * middle are the mark, not artefacts.
 *
 * Every mark in both apps renders through here — header, sidebar, tab bar,
 * sign-in, sign-up — so there is no second copy to drift. The mobile file
 * carries the same two strings and must change with it.
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

/**
 * The brushed-metal ramp, as offset/colour pairs.
 *
 * ONE definition, two consumers. The mark is SVG and takes `<stop>` elements;
 * the wordmark is live text and takes a CSS `linear-gradient` behind
 * `background-clip: text`. Writing the ramp out twice is how the letters end
 * up a slightly different metal from the mark they sit against — visible
 * exactly at the seam where the eye is already looking.
 */
const METAL: readonly (readonly [number, string])[] = [
  [0.0, '#FBFCFD'],
  [0.2, '#C6CDD6'],
  [0.42, '#7F8B9A'],
  [0.5, '#FFFFFF'],
  [0.58, '#A9B3BF'],
  [0.78, '#5F6A78'],
  [1.0, '#C2CAD3'],
];

/** The same ramp as a CSS gradient, top to bottom. */
export const METAL_CSS = `linear-gradient(180deg, ${METAL.map(
  ([offset, colour]) => `${colour} ${(offset * 100).toFixed(0)}%`,
).join(', ')})`;

/**
 * The gradient's id. STABLE and global, because it is defined exactly once —
 * by `<LogoGradient />` in the root layout — and referenced by every mark on
 * the page.
 *
 * The alternative, a `useId()` per instance, would make `Logo` a hook-calling
 * component and so unusable from a server component; repeating the `<defs>`
 * in every mark would put the same id in the document a dozen times. One
 * definition and one reference is the only arrangement that is neither.
 */
const METAL_ID = 'xetral-metal';

/**
 * The gradient definition. Rendered ONCE, in the root layout.
 *
 * `gradientUnits="userSpaceOnUse"` rather than the default bounding-box units:
 * the mark is two separate paths whose boxes are not the same height (the left
 * chevron spans 0–474, the right 71–459), so bounding-box units would run a
 * separate ramp down each half and the two would not line up across the gap.
 * Pinned to the viewBox instead, both halves are cut from one sheet of metal.
 */
export function LogoGradient() {
  return (
    <svg
      width="0"
      height="0"
      aria-hidden="true"
      focusable="false"
      style={{ position: 'absolute', width: 0, height: 0, overflow: 'hidden' }}
    >
      <defs>
        <linearGradient
          id={METAL_ID}
          gradientUnits="userSpaceOnUse"
          x1="0"
          y1="0"
          x2="0"
          y2={VB_H}
        >
          {METAL.map(([offset, colour]) => (
            <stop key={offset} offset={offset} stopColor={colour} />
          ))}
        </linearGradient>
      </defs>
    </svg>
  );
}

export interface LogoProps {
  /** Height of the mark in px. The wordmark is scaled from it. */
  readonly size?: number;
  /** Draw "etral" after the mark, so the mark IS the X. */
  readonly wordmark?: boolean;
  /**
   * `auto` — black on the light theme, brushed metal on the dark one.
   * `metal` — always brushed metal, for a surface that is black in BOTH
   *   themes, where `auto` would draw a black mark on black half the time.
   * `inverse` — solid white, for a mark sitting on a coloured surface where
   *   the page theme is not what decides legibility.
   * `current` — inherit `color`, for a mark inside a button or a link.
   */
  readonly tone?: 'auto' | 'metal' | 'inverse' | 'current';
  readonly className?: string;
}

/**
 * The mark alone — for an avatar, a splash, a tile.
 *
 * The theme decision is made in CSS, not here. A component that read the
 * theme in JavaScript would render the light mark on the server and swap it
 * after hydration, which is a flash of the wrong logo on every cold load; and
 * with the theme resolved from `prefers-color-scheme` the server does not know
 * the answer to begin with.
 */
export function LogoMark({ size = 28, tone = 'auto' }: Omit<LogoProps, 'wordmark'>) {
  return (
    <svg
      className={`logo-mark logo-${tone}`}
      width={(size * VB_W) / VB_H}
      height={size}
      viewBox={`0 0 ${VB_W} ${VB_H}`}
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
 *  1. The gap is NEGATIVE. The mark's right edge is a wedge — the chevron's
 *     arms reach full width only at the very top and bottom — so even a zero
 *     gap leaves a hole at the vertical middle and the brand reads "X etral".
 *     The 'e' is tucked into that notch.
 *  2. The mark is set to the wordmark's CAP height, so the word is drawn at
 *     size/0.72 — Bricolage's cap height. Matching the line box instead makes
 *     the mark look oversized, because a line box carries descender space
 *     that nothing in "etral" uses.
 *  3. The whole thing is labelled "Xetral" for assistive tech and the visible
 *     "etral" is hidden from it. A screen reader announcing the brand as
 *     "etral" would be a worse bug than the duplicate letter was.
 */
export function Logo({ size = 28, wordmark = true, tone = 'auto', className }: LogoProps) {
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
        className={`logo-word logo-${tone}`}
        style={{
          fontSize,
          marginLeft: size * -0.05,
          // The ramp travels with the element rather than living in the
          // stylesheet, so the stops have exactly one home (see METAL).
          ['--metal-css' as string]: METAL_CSS,
        }}
      >
        etral
      </span>
    </span>
  );
}
