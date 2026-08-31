import Svg, { Path } from 'react-native-svg';
import { FILLED_ICONS, ICON_PATHS, ICON_STROKE, ICON_VIEWBOX } from '@xetral/client';
import type { IconName } from '@xetral/client';
import { useTheme } from '@/theme';

/**
 * The icon set, drawn for the phone.
 *
 * THE GEOMETRY IS THE WEB'S, from `@xetral/client`. The phone app had no icons
 * at all — every screen was text, including the tab bar it did not have — and
 * the obvious way to fix that is to draw a second set here. That is how the
 * two apps end up with a different wallet glyph, which is exactly the drift
 * the refusal messages had.
 *
 * `currentColor` does not exist in react-native-svg, so the colour is a prop
 * with the secondary text colour as its default. Every call site that wants
 * something else says so.
 */
export interface IconProps {
  readonly name: IconName;
  readonly size?: number;
  readonly color?: string;
}

export function Icon({ name, size = 20, color }: IconProps) {
  const colors = useTheme();
  const tint = color ?? colors.text2;
  const filled = FILLED_ICONS.has(name);
  return (
    <Svg
      width={size}
      height={size}
      viewBox={`0 0 ${ICON_VIEWBOX} ${ICON_VIEWBOX}`}
      fill="none"
    >
      <Path
        d={ICON_PATHS[name]}
        fill={filled ? tint : 'none'}
        stroke={filled ? 'none' : tint}
        strokeWidth={ICON_STROKE}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

export type { IconName };
