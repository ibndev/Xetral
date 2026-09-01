import { Text, View } from 'react-native';
import { font } from '@/theme';
import Svg, { Circle, ClipPath, Defs, G, Path, Rect } from 'react-native-svg';
import { markFor } from '@xetral/client';

/**
 * The round mark beside a currency code, drawn from the SAME data the web
 * draws from.
 *
 * Not an emoji flag: Android renders them, Windows does not, and a mark that
 * exists on the phone and is two letters in a box on a laptop is exactly the
 * kind of difference this codebase keeps one list to prevent.
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
      <View
        style={{
          width: size,
          height: size,
          borderRadius: size,
          backgroundColor: mark.ground,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Text style={{ color: mark.ink, fontSize: size * 0.62, fontFamily: font.sansBold }}>
          {mark.symbol}
        </Text>
      </View>
    );
  }

  const band = mark.direction === 'vertical' ? size / mark.bands.length : size;
  const tall = mark.direction === 'vertical' ? size : size / mark.bands.length;
  const id = `ccy-${currency}`;

  return (
    <Svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      <Defs>
        <ClipPath id={id}>
          <Circle cx={r} cy={r} r={r} />
        </ClipPath>
      </Defs>
      <G clipPath={`url(#${id})`}>
        {mark.bands.map((colour, i) => (
          <Rect
            key={colour + String(i)}
            x={mark.direction === 'vertical' ? i * band : 0}
            y={mark.direction === 'vertical' ? 0 : i * tall}
            width={band}
            height={tall}
            fill={colour}
          />
        ))}
        {mark.star !== undefined && <Path d={starPath(r, r, size * 0.2)} fill={mark.star} />}
      </G>
      {/* Keeps a white band off a white card. */}
      <Circle cx={r} cy={r} r={r - 0.5} fill="none" stroke="rgba(0,0,0,0.14)" strokeWidth={1} />
    </Svg>
  );
}

/** Five points, outer radius `outer`, inner at 40%. Identical to the web's. */
function starPath(cx: number, cy: number, outer: number): string {
  const points: string[] = [];
  for (let i = 0; i < 10; i++) {
    const radius = i % 2 === 0 ? outer : outer * 0.4;
    const angle = (Math.PI / 5) * i - Math.PI / 2;
    points.push(`${cx + radius * Math.cos(angle)},${cy + radius * Math.sin(angle)}`);
  }
  return `M${points.join('L')}Z`;
}
