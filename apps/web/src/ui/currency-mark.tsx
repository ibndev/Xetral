import { useId } from 'react';
import { countryMarkFor, markFor } from '@xetral/client';
import type { CurrencyMark as Mark } from '@xetral/client';

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
  return <Drawn mark={markFor(currency)} size={size} />;
}

/**
 * The same mark, for a COUNTRY rather than a currency.
 *
 * A separate entry point because the two are keyed differently and only
 * coincide while every open country has its own currency — the United Kingdom
 * names GBP, whose mark is a pound sign, which is the wrong thing to draw
 * beside "United Kingdom" in a list somebody is scanning for a flag.
 */
export function CountryMark({
  country,
  size = 20,
}: {
  readonly country: string;
  readonly size?: number;
}) {
  return <Drawn mark={countryMarkFor(country)} size={size} />;
}

function Drawn({ mark, size }: { readonly mark: Mark; readonly size: number }) {
  // `useId` rather than the code: the clip path is referenced by id, and two
  // marks for the same thing on one page — a trigger and its selected row —
  // would otherwise share one, which is a duplicate id and an ambiguous
  // reference. React guarantees this is unique per instance.
  const id = useId();
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

  /*
   * A circle clipped over bands. `clipPath` rather than a border-radius on the
   * rects, because rounded rects side by side leave notches where they meet
   * and the notches are visible at this size.
   *
   * THE BANDS ARE WEIGHTED, and Kenya is why. Its two white stripes are thin
   * fimbriations between the black, red and green — drawn as equal fifths
   * they are as wrong as leaving them out, which is what the flag used to do
   * and why it read as a generic tricolour rather than as Kenya's.
   */
  const offsets = bandOffsets(mark, size);

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
      <clipPath id={id}>
        <circle cx={r} cy={r} r={r} />
      </clipPath>
      <g clipPath={`url(#${id})`}>
        {mark.bands.map((colour, i) => {
          const at = offsets[i] ?? { start: 0, span: 0 };
          return (
            <rect
              key={colour + String(i)}
              x={mark.direction === 'vertical' ? at.start : 0}
              y={mark.direction === 'vertical' ? 0 : at.start}
              width={mark.direction === 'vertical' ? at.span : size}
              height={mark.direction === 'vertical' ? size : at.span}
              fill={colour}
            />
          );
        })}
        {mark.shield !== undefined && (
          /*
           * KENYA'S MAASAI SHIELD, as much of it as survives eighteen pixels.
           *
           * The real device is a shield over two crossed spears, which at this
           * size is mud. What reads — and what stops the flag being three
           * stripes — is the upright red lozenge with a white edge standing in
           * the centre. Drawn as an ellipse rather than as a traced path,
           * because a path detailed enough to be right would be illegible
           * anyway and a lie about what is on screen.
           */
          <>
            <ellipse
              cx={r}
              cy={r}
              rx={size * 0.17}
              ry={size * 0.34}
              fill={mark.shield.edge}
            />
            <ellipse
              cx={r}
              cy={r}
              rx={size * 0.1}
              ry={size * 0.26}
              fill={mark.shield.body}
            />
          </>
        )}
        {mark.star !== undefined && (
          <path
            // A five-pointed star on the unit circle, scaled to the mark.
            // Ghana's is LARGE — it is the flag's whole identity, and at the
            // old fifth of the disc it was a speck in a tricolour.
            d={starPath(r, r, size * (mark.starRadius ?? 0.2))}
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

/**
 * Where each band starts and how wide it is.
 *
 * `weights` absent means equal, which is what three of these four flags are.
 * Shared by both renderers through the data rather than by two copies of this
 * arithmetic, which is the same reason the colours live in one file.
 */
function bandOffsets(
  mark: { readonly bands: readonly string[]; readonly weights?: readonly number[] },
  size: number,
): readonly { start: number; span: number }[] {
  const weights = mark.weights ?? mark.bands.map(() => 1);
  const total = weights.reduce((sum, w) => sum + w, 0);
  let cursor = 0;
  return mark.bands.map((_, i) => {
    const span = (size * (weights[i] ?? 1)) / total;
    const start = cursor;
    cursor += span;
    return { start, span };
  });
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
