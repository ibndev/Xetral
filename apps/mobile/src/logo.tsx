import { Text, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { font, logoInk, useResolvedScheme } from './theme';

/**
 * The Xetral mark — the SAME geometry as `apps/web/src/ui/logo.tsx`.
 *
 * THE PATH DATA IS THE SUPPLIED GEOMETRIC TRACE, VERBATIM — the same two
 * strings as `apps/web/src/ui/logo.tsx`. Straight segments only; do not
 * re-round the coordinates. A mark that differs between the phone and the web
 * is two brands, so if either file's geometry changes, both change.
 */
const VB_W = 539;
const VB_H = 474;

const LEFT_CHEVRON =
  'M0 1l158 197l2 1l29 38v8l-5 8l-95 115l-69 86l-2 1l-14 19l5 -1h131l4 -1l7 -3' +
  'l8 -7l105 -132v-7l-2 -4l-2 -1l-6 -9l-33 -40l-5 -10l-2 -9v-9l3 -12l7 -12l49 -59' +
  'l5 -7v-5l-15 -21l-69 -86l-22 -27l-8 -7l-13 -5h-143l-1 1l-5 -1z';

const RIGHT_CHEVRON =
  'M539 459l-162 -199l-14 -19l1 -10l5 -7l130 -153h-110l-6 2l-4 2l-13 14l-124 142' +
  'l-4 8v13l2 5l150 185l11 12l12 5z';

/**
 * Black on light, metal on dark — see `logoInk`. `inverse` is for a mark on a
 * coloured surface, where the theme is not what decides legibility.
 *
 * The scheme comes from `useResolvedScheme`, NOT from `useColorScheme`. It
 * read the device directly, which was right while the device was the only
 * thing deciding — and became a bug the moment the app gained a theme toggle:
 * switching to dark repainted every surface and left the mark black on black.
 */
function inkFor(tone: 'auto' | 'inverse', scheme: 'light' | 'dark'): string {
  if (tone === 'inverse') return '#FFFFFF';
  return scheme === 'dark' ? logoInk.dark : logoInk.light;
}

export function LogoMark({
  size = 28,
  tone = 'auto',
}: {
  readonly size?: number;
  readonly tone?: 'auto' | 'inverse';
}) {
  const fill = inkFor(tone, useResolvedScheme());
  return (
    <Svg width={(size * VB_W) / VB_H} height={size} viewBox={`0 0 ${VB_W} ${VB_H}`}>
      <Path d={RIGHT_CHEVRON} fill={fill} />
      <Path d={LEFT_CHEVRON} fill={fill} />
    </Svg>
  );
}

/**
 * The lockup: the mark AS the letter X, then "etral".
 *
 * It used to draw the mark beside the full word "Xetral", so the brand read
 * with the letter twice. The mark is the X.
 *
 * `accessibilityLabel` carries the real word — a screen reader announcing
 * "etral" would be a worse bug than the duplicate was.
 */
export function Logo({
  size = 28,
  wordmark = true,
  tone = 'auto',
}: {
  readonly size?: number;
  readonly wordmark?: boolean;
  readonly tone?: 'auto' | 'inverse';
}) {
  const ink = inkFor(tone, useResolvedScheme());
  if (!wordmark) return <LogoMark size={size} tone={tone} />;

  return (
    <View
      accessible
      accessibilityRole="image"
      accessibilityLabel="Xetral"
      style={{ flexDirection: 'row', alignItems: 'center' }}
    >
      <LogoMark size={size} tone={tone} />
      <Text
        style={{
          // The 800 face by name. A weight beside a custom family is dropped
          // on Android and synthesizes a faux-bold on iOS.
          fontFamily: font.displayBold,
          // The face's cap height is ~0.72em, so the word is set larger for
          // its capitals to match the mark's height.
          fontSize: Math.round(size / 0.72),
          letterSpacing: -0.6,
          color: ink,
          // Negative: the mark's right edge is a WEDGE, not a flat side — the
          // chevron's arms reach the full width only at the very top and
          // bottom, so a zero gap still reads as "X etral". The 'e' is tucked
          // into that notch. Measured across 28/40/64px against the real
          // font file; -0.08 begins to collide at display sizes.
          marginLeft: size * -0.05,
        }}
      >
        etral
      </Text>
    </View>
  );
}
