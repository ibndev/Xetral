/**
 * THE ICON SET, AS GEOMETRY.
 *
 * Paths on a 24×24 grid with a 1.75 stroke, round caps and joins — one hand
 * for all of them, which is what makes a set look drawn rather than collected.
 *
 * This is DATA, not markup, and it lives here because two apps have to draw
 * the same set with different primitives: `<svg>` on the web, `react-native-svg`
 * on the phone. Duplicating the table is how the tab bar ends up with a
 * different wallet icon on Android — the same failure the refusal messages
 * had, one file over.
 *
 * NO EMOJI, on either platform. They render as a different picture on every
 * OS, so the eSIM tile a designer approved on a Mac is a different glyph on
 * the Android phone most Nigerian customers hold, and they carry a colour and
 * a shine that cannot be restyled to sit quietly beside a typeface.
 */

export type IconName =
  | 'home' | 'card' | 'activity' | 'grid' | 'menu' | 'bell' | 'search'
  | 'send' | 'plus' | 'minus' | 'swap' | 'download'
  | 'wallet' | 'bitcoin' | 'sim' | 'receipt' | 'gift' | 'globe'
  | 'shield' | 'lock' | 'user' | 'settings' | 'logout'
  | 'chevronRight' | 'chevronDown' | 'chevronLeft' | 'arrowRight' | 'arrowUpRight'
  | 'check' | 'close' | 'eye' | 'eyeOff' | 'copy' | 'info' | 'alert'
  | 'sun' | 'moon' | 'clock' | 'trend' | 'bank' | 'users' | 'file';

export const ICON_PATHS: Readonly<Record<IconName, string>> = {
  home:        'M3 10.5 12 3l9 7.5M5.5 9.5V20h13V9.5M9.5 20v-5.5h5V20',
  card:        'M2.5 7.5h19v11a2 2 0 0 1-2 2h-15a2 2 0 0 1-2-2v-11ZM2.5 10.5h19M6 16.5h3',
  activity:    'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 7v5l3.5 2',
  grid:        'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z',
  menu:        'M3.5 7h17M3.5 12h17M3.5 17h11',
  bell:        'M18 8.5a6 6 0 1 0-12 0c0 6-2 7.5-2 7.5h16s-2-1.5-2-7.5ZM10.3 19.5a2 2 0 0 0 3.4 0',
  search:      'M11 18.5a7.5 7.5 0 1 0 0-15 7.5 7.5 0 0 0 0 15ZM20.5 20.5l-4-4',
  send:        'M21 3 10.5 13.5M21 3l-6.5 18-4-7.5L3 9.5 21 3Z',
  plus:        'M12 5.5v13M5.5 12h13',
  minus:       'M5.5 12h13',
  swap:        'M7 4.5 3.5 8 7 11.5M3.5 8h13M17 12.5l3.5 3.5L17 19.5M20.5 16h-13',
  download:    'M12 3.5v12M7.5 11l4.5 4.5 4.5-4.5M4 20.5h16',
  wallet:      'M3 7.5A2 2 0 0 1 5 5.5h12a2 2 0 0 1 2 2M3 7.5v11a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-9H5a2 2 0 0 1-2-2ZM16.5 14.5h1.5',
  bitcoin:     'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM9.5 7.5h4a2.2 2.2 0 0 1 0 4.5h-4V7.5Zm0 4.5h4.5a2.2 2.2 0 0 1 0 4.5H9.5V12ZM11 5.5v2M11 16.5v2',
  sim:         'M7 2.5h6.5L18 7v14.5H7A1.5 1.5 0 0 1 5.5 20V4A1.5 1.5 0 0 1 7 2.5ZM9 11.5h5.5v6H9z',
  receipt:     'M6 2.5h12v19l-2.5-1.8-2.5 1.8-2.5-1.8L8 21.5 6 19.7V2.5ZM9.5 8h5M9.5 12h5',
  gift:        'M3.5 11.5h17v9a1 1 0 0 1-1 1h-15a1 1 0 0 1-1-1v-9ZM2.5 7.5h19v4h-19zM12 7.5v14M12 7.5S10.5 3 8 3a2.2 2.2 0 0 0 0 4.5M12 7.5S13.5 3 16 3a2.2 2.2 0 0 1 0 4.5',
  globe:       'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM3.5 12h17M12 3a14 14 0 0 1 0 18 14 14 0 0 1 0-18Z',
  shield:      'M12 2.5 20 6v6c0 5-3.4 8.2-8 9.5-4.6-1.3-8-4.5-8-9.5V6l8-3.5ZM9 12l2 2 4-4',
  lock:        'M5.5 10.5h13v10h-13zM8.5 10.5V7a3.5 3.5 0 0 1 7 0v3.5M12 14.5v2.5',
  user:        'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM4.5 20.5a7.5 7.5 0 0 1 15 0',
  settings:    'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM19.5 12a7.5 7.5 0 0 0-.1-1.2l2-1.6-2-3.4-2.4 1a7.5 7.5 0 0 0-2-1.2l-.4-2.6h-4l-.4 2.6a7.5 7.5 0 0 0-2 1.2l-2.4-1-2 3.4 2 1.6a7.5 7.5 0 0 0 0 2.4l-2 1.6 2 3.4 2.4-1a7.5 7.5 0 0 0 2 1.2l.4 2.6h4l.4-2.6a7.5 7.5 0 0 0 2-1.2l2.4 1 2-3.4-2-1.6c.06-.4.1-.8.1-1.2Z',
  logout:      'M15 8V5.5a1.5 1.5 0 0 0-1.5-1.5h-8A1.5 1.5 0 0 0 4 5.5v13A1.5 1.5 0 0 0 5.5 20h8a1.5 1.5 0 0 0 1.5-1.5V16M9.5 12h11M17 8.5l3.5 3.5-3.5 3.5',
  chevronRight:'M9.5 5.5 16 12l-6.5 6.5',
  chevronDown: 'M5.5 9.5 12 16l6.5-6.5',
  chevronLeft: 'M14.5 5.5 8 12l6.5 6.5',
  arrowRight:  'M4 12h16M14 6l6 6-6 6',
  arrowUpRight:'M7 17 17 7M8.5 7H17v8.5',
  check:       'M4.5 12.5 9.5 17.5 19.5 7',
  close:       'M6 6l12 12M18 6 6 18',
  eye:         'M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z',
  eyeOff:      'M4 4l16 16M9.9 5.9A9.6 9.6 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a17 17 0 0 1-3.2 4M6.4 8A17 17 0 0 0 2.5 12S6 18.5 12 18.5a9.4 9.4 0 0 0 3.3-.6M9.9 9.9a3 3 0 0 0 4.2 4.2',
  copy:        'M9 9h10.5v10.5H9zM15 9V4.5H4.5V15H9',
  info:        'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 11v5.5M12 7.5h.01',
  alert:       'M12 3 22 20H2L12 3ZM12 9.5v5M12 17.5h.01',
  sun:         'M12 16.5a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9ZM12 2v2.5M12 19.5V22M4.2 4.2l1.8 1.8M18 18l1.8 1.8M2 12h2.5M19.5 12H22M4.2 19.8 6 18M18 6l1.8-1.8',
  moon:        'M20.5 14.5A8.5 8.5 0 0 1 9.5 3.5a8.5 8.5 0 1 0 11 11Z',
  clock:       'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 7v5l3 2',
  trend:       'M3 17 9.5 10.5l4 4L21 7M21 7h-5.5M21 7v5.5',
  bank:        'M3 9.5 12 4l9 5.5M4.5 9.5v9M9.5 9.5v9M14.5 9.5v9M19.5 9.5v9M3 21h18',
  users:       'M9 11.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7ZM2.5 20.5a6.5 6.5 0 0 1 13 0M16 5.2a3.5 3.5 0 0 1 0 6.6M17.5 14.6a6.5 6.5 0 0 1 4 6',
  file:        'M6 2.5h8L19 7.5v14H6zM14 2.5V8h5M9 13h6M9 17h4',
};

/** Icons that are closed shapes rather than strokes. A renderer must fill
 *  these and stroke the rest; getting it backwards makes a solid square. */
export const FILLED_ICONS: ReadonlySet<IconName> = new Set(['grid']);

export const ICON_VIEWBOX = 24;
export const ICON_STROKE = 1.75;
