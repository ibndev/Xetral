import { markFor } from '@xetral/client';

/**
 * The round mark beside a currency code, drawn rather than typed.
 *
 * SVG, not an emoji flag: Windows ships no flag glyphs at all, so `🇳🇬`
 * renders there as the letters "NG" in a box — on the currency selector, on
 * the screen every customer opens first. The shapes and colours come from
 * `@xetral/client` so the phone draws exactly the same mark.
 */
export function CurrencyMark({
  currency,
  size = 20,
}: {
  readonly currency: string;
  readonly size?: number;
}) {
  const mark = markFor(currency);
  const r = size / 2;

  if (mark.kind === 'symbol') {
    return (
      <span
        aria-hidden="true"
        className="ccy-mark"
        style={{
          width: size,
          height: size,
          background: mark.ground,
          color: mark.ink,
          // Scaled off the mark rather than fixed, so one component serves the
          // 18px row and the 24px trigger without a second set of rules.
          fontSize: size * 0.62,
        }}
      >
        {mark.symbol}
      </span>
    );
  }

  // A circle clipped over bands. `clipPath` rather than a border-radius on the
  // rects, because three rounded rects side by side leave notches where they
  // meet and the notches are visible at this size.
  const id = `ccy-${currency}`;
  const band = mark.direction === 'vertical' ? size / mark.bands.length : size;
  const tall = mark.direction === 'vertical' ? size : size / mark.bands.length;

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
      <clipPath id={id}>
        <circle cx={r} cy={r} r={r} />
      </clipPath>
      <g clipPath={`url(#${id})`}>
        {mark.bands.map((colour, i) => (
          <rect
            key={colour + String(i)}
            x={mark.direction === 'vertical' ? i * band : 0}
            y={mark.direction === 'vertical' ? 0 : i * tall}
            width={band}
            height={tall}
            fill={colour}
          />
        ))}
        {mark.star !== undefined && (
          <path
            // A five-pointed star on the unit circle, scaled to the mark.
            d={starPath(r, r, size * 0.2)}
            fill={mark.star}
          />
        )}
      </g>
      {/* A hairline inside the edge, so a white band does not dissolve into a
          white card. Drawn last so it sits over the fills. */}
      <circle cx={r} cy={r} r={r - 0.5} fill="none" stroke="rgb(0 0 0 / 14%)" strokeWidth="1" />
    </svg>
  );
}

/** Five points, outer radius `outer`, inner at 40% — the usual proportion. */
function starPath(cx: number, cy: number, outer: number): string {
  const points: string[] = [];
  for (let i = 0; i < 10; i++) {
    const radius = i % 2 === 0 ? outer : outer * 0.4;
    // Starts at -90° so a point faces up rather than a flat edge.
    const angle = (Math.PI / 5) * i - Math.PI / 2;
    points.push(`${cx + radius * Math.cos(angle)},${cy + radius * Math.sin(angle)}`);
  }
  return `M${points.join('L')}Z`;
}
