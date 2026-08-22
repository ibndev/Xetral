import { Text, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { colors, font } from './theme';

/**
 * The Xetral mark — the SAME geometry as `apps/web/src/ui/logo.tsx`.
 *
 * Two mitred chevrons facing each other, meeting at a narrow notch on the
 * centre line rather than crossing. If either file's path data changes, both
 * change: a mark that differs between the phone and the web is two brands.
 */
const VB_W = 259;
const VB_H = 223;

const LEFT =
  'M0 0 L46 0 L122 98 ' +
  'C125 102 126 105 126 111.5 ' +
  'C126 118 125 121 122 125 ' +
  'L46 223 L0 223 ' +
  'L80 118 C83 114.5 83 108.5 80 105 Z';

const RIGHT =
  'M259 0 L213 0 L137 98 ' +
  'C134 102 133 105 133 111.5 ' +
  'C133 118 134 121 137 125 ' +
  'L213 223 L259 223 ' +
  'L179 118 C176 114.5 176 108.5 179 105 Z';

export function LogoMark({
  size = 28,
  tone = 'brand',
}: {
  readonly size?: number;
  readonly tone?: 'brand' | 'inverse';
}) {
  const fill = tone === 'inverse' ? '#FFFFFF' : colors.brand;
  return (
    <Svg width={(size * VB_W) / VB_H} height={size} viewBox={`0 0 ${VB_W} ${VB_H}`}>
      <Path d={LEFT} fill={fill} />
      <Path d={RIGHT} fill={fill} />
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
  tone = 'brand',
}: {
  readonly size?: number;
  readonly wordmark?: boolean;
  readonly tone?: 'brand' | 'inverse';
}) {
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
          fontFamily: font.display,
          fontWeight: '800',
          // Bricolage's cap height is ~0.72em, so the word is set larger for
          // its capitals to match the mark's height.
          fontSize: Math.round(size / 0.72),
          letterSpacing: -0.6,
          color: tone === 'inverse' ? '#FFFFFF' : colors.brand,
          marginLeft: size * 0.09,
        }}
      >
        etral
      </Text>
    </View>
  );
}
