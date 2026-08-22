import { Text, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { colors, font } from './theme';

/**
 * The Xetral mark — the same geometry as `apps/web/src/ui/logo.tsx`.
 *
 * THIS IS NOT THE TRACED LOGO; see that file for why. When the real SVG
 * arrives, both files change together and nothing else does.
 *
 * The alignment matters as much as the shape. The mark is optically centred
 * on the wordmark's CAP height, not on its line box — a line box includes
 * descender space that nothing in "Xetral" uses, so centring on one leaves
 * the mark visibly high. React Native gives no baseline control, so the two
 * are laid out as centred flex children and the text is nudged instead.
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
  const stroke = tone === 'inverse' ? '#FFFFFF' : colors.brand;

  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: Math.round(size * 0.3) }}>
      <Svg width={size} height={size} viewBox="0 0 48 48" fill="none">
        <Path d="M11 10 L37 38" stroke={stroke} strokeWidth={7.5} strokeLinecap="round" />
        <Path d="M37 10 L11 38" stroke={stroke} strokeWidth={7.5} strokeLinecap="round" />
        <Path d="M26.5 27.5 L37 38" stroke={colors.accent} strokeWidth={7.5} strokeLinecap="round" />
      </Svg>
      {wordmark && (
        <Text
          style={{
            fontFamily: font.display,
            fontWeight: '800',
            fontSize: Math.round(size * 0.86),
            letterSpacing: -0.5,
            color: tone === 'inverse' ? '#FFFFFF' : colors.brand,
            // Optical, not arithmetic: pulls the wordmark down onto the mark's
            // centre line the way cap-height centring does on the web.
            marginTop: size * 0.045,
          }}
        >
          Xetral
        </Text>
      )}
    </View>
  );
}
