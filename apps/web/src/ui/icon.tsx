import { FILLED_ICONS, ICON_PATHS, ICON_STROKE } from '@xetral/client';
import type { IconName } from '@xetral/client';

/**
 * The icon set, drawn for the browser.
 *
 * The GEOMETRY lives in `@xetral/client` — see `icons.ts` there for why. This
 * file is only the renderer: one `<svg>`, `currentColor`, so an icon in a
 * button, a tab bar and a table row is the same path at three colours. The
 * phone has its own renderer over the same table, which is what stops the two
 * apps drifting into different sets.
 */

export type { IconName };

export interface IconProps {
  readonly name: IconName;
  readonly size?: number;
  readonly className?: string;
  /** Screen readers skip icons by default — they repeat the label beside
   *  them. Give a label ONLY when the icon is the whole control. */
  readonly label?: string;
}

export function Icon({ name, size = 20, className, label }: IconProps) {
  const filled = FILLED_ICONS.has(name);
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? 'currentColor' : 'none'}
      stroke={filled ? 'none' : 'currentColor'}
      strokeWidth={ICON_STROKE}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={label === undefined ? true : undefined}
      role={label === undefined ? undefined : 'img'}
      aria-label={label}
      focusable="false"
      style={{ display: 'block', flexShrink: 0 }}
    >
      <path d={ICON_PATHS[name]} />
    </svg>
  );
}
