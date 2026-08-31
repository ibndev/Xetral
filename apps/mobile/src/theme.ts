import { createContext, useContext } from 'react';
import { Platform, StyleSheet, useColorScheme } from 'react-native';

/**
 * The design tokens, matched to the web's `globals.css`.
 *
 * The same navy, the same amber, the same radii and the same 48pt tap target.
 * A customer who uses the web app on a laptop and the phone app on the bus
 * should not feel they are using two products, and the only way that holds is
 * if both read their values from one written-down system rather than each
 * inventing its own.
 *
 * Light is the default here as it is there. Dark is a real second palette,
 * not an inversion.
 */

/** Every palette has exactly these keys, so a screen reading `colors.x`
 *  cannot compile against one theme and break under the other. */
export interface Palette {
  readonly brand: string; readonly brand700: string; readonly accent: string;
  readonly link: string; readonly bg: string; readonly surface: string;
  readonly surface2: string; readonly line: string; readonly lineStrong: string;
  readonly text: string; readonly text2: string; readonly text3: string;
  readonly onBrand: string;
  readonly ok: string; readonly okBg: string;
  readonly warn: string; readonly warnBg: string;
  readonly danger: string; readonly dangerBg: string;
  readonly info: string; readonly infoBg: string;
}

export const light: Palette = {
  brand: '#0D1B3E',
  brand700: '#16295A',
  accent: '#F5A623',
  link: '#4B7BF5',

  bg: '#FFFFFF',
  surface: '#FFFFFF',
  surface2: '#F6F7F9',
  line: '#E5E7EB',
  lineStrong: '#D0D4DB',

  text: '#0D1B3E',
  text2: '#4A5878',
  text3: '#8695B4',
  onBrand: '#FFFFFF',

  ok: '#0F9D58',
  okBg: '#E7F6EE',
  warn: '#B7791F',
  warnBg: '#FDF3E2',
  danger: '#D64545',
  dangerBg: '#FDECEC',
  info: '#3866E0',
  infoBg: '#EAF0FE',
};

export const dark: Palette = {
  brand: '#FFFFFF',
  brand700: '#E8EDF7',
  accent: '#F5A623',
  link: '#6E9BFF',

  bg: '#000000',
  surface: '#0C0D10',
  surface2: '#141519',
  line: '#212227',
  lineStrong: '#303237',

  text: '#EEF2FA',
  text2: '#A3B0CC',
  text3: '#6B7A9B',
  onBrand: '#0D1B3E',

  ok: '#4ADE80',
  okBg: '#10291C',
  warn: '#FBBF24',
  warnBg: '#2C2210',
  danger: '#F87171',
  dangerBg: '#2E1516',
  info: '#93B4FF',
  infoBg: '#131E3A',
};

/**
 * What the customer has chosen, or `system` to follow the phone.
 *
 * THREE STATES, NOT TWO, and it matches the web exactly. A toggle that only
 * knows light and dark has to pick one the first time it runs, and whichever
 * it picks is wrong for half the people who never touch it.
 */
export type ThemeChoice = 'light' | 'dark' | 'system';

export function isThemeChoice(value: string): value is ThemeChoice {
  return value === 'light' || value === 'dark' || value === 'system';
}

/**
 * The choice in force, and how to change it.
 *
 * A CONTEXT rather than a module-level variable, and that is the second time
 * this file has had to learn the lesson: `export const colors = light` was
 * here once, described as "swapped by the theme provider", with no provider —
 * and a module `const` cannot be swapped from outside its module anyway, so
 * every screen was pinned to light whatever the phone was set to.
 *
 * Defaults to `system` so a screen rendered outside the provider — which
 * should not happen, and did — follows the device rather than freezing on one
 * palette. `set` is a no-op there, which is visible in a way a wrong colour is
 * not.
 */
export const ThemeChoiceContext = createContext<{
  readonly choice: ThemeChoice;
  readonly set: (next: ThemeChoice) => void;
}>({ choice: 'system', set: () => undefined });

export function useThemeChoice(): {
  readonly choice: ThemeChoice;
  readonly set: (next: ThemeChoice) => void;
} {
  return useContext(ThemeChoiceContext);
}

/**
 * THE RULE, AS A PURE FUNCTION: the customer's choice wins, `system` falls
 * back to the device, and anything unreadable is light.
 *
 * Separated from the hook so it can be TESTED WITHOUT A RENDERER. The hooks
 * below are two lines of plumbing over this; the decision is here, where a
 * test can put every combination through it.
 */
export function schemeFor(
  choice: ThemeChoice,
  device: 'light' | 'dark' | null | undefined,
): 'light' | 'dark' {
  const resolved = choice === 'system' ? device : choice;
  return resolved === 'dark' ? 'dark' : 'light';
}

export function paletteFor(scheme: 'light' | 'dark'): Palette {
  return scheme === 'dark' ? dark : light;
}

/**
 * The palette in force.
 *
 * It used to read `useColorScheme()` alone, so the phone had a dark palette
 * and NO WAY TO ASK FOR IT — the web has carried a sun/moon toggle since it
 * was built, and the two apps disagreed about whether that control existed.
 */
export function useTheme(): Palette {
  return paletteFor(useResolvedScheme());
}

/** What the toggle should offer next, and which icon says so. */
export function useResolvedScheme(): 'light' | 'dark' {
  return schemeFor(useContext(ThemeChoiceContext).choice, useColorScheme());
}

/**
 * The mark's ink, which is NOT `brand`.
 *
 * Black on white, metal on black. The web fills the dark mark with a true
 * brushed-metal gradient; here it is the ramp's dominant tone as a flat
 * colour, because a gradient across live text on React Native needs either a
 * masked view or SVG-rendered text, and neither is in this app's dependency
 * list. Adding one blind — the phone app has never been run on hardware from
 * this repo — would be shipping an untested dependency into the first thing a
 * customer sees. Flat silver on both halves has no seam; a gradient mark
 * beside a flat-silver word would have an obvious one.
 */
export const logoInk = { light: '#000000', dark: '#D5DBE2' } as const;

export const radius = { sm: 10, md: 14, lg: 18, xl: 24, pill: 999 } as const;
export const space = { xs: 6, sm: 10, md: 14, lg: 18, xl: 24, xxl: 32 } as const;

/**
 * The typefaces from the design.
 *
 * These are the KEYS `_layout.tsx` registers the files under, which is what
 * `fontFamily` matches — not the family name inside the file. Bricolage's is
 * "Bricolage Grotesque 96pt ExtraBold"; nothing here would guess that.
 *
 * This comment used to say they were loaded and they were not: `expo-font` was
 * not a dependency, no font file existed in this app, and nothing called
 * `useFonts`. An unregistered family silently falls back to the system face on
 * both platforms, so the app rendered in Roboto and said otherwise.
 *
 * NONE OF THE THREE CONTAINS ₦ (U+20A6) — measured, not assumed, and the same
 * fact `globals.css` records for the web. Every naira figure therefore renders
 * its symbol in whatever the platform substitutes. That is a mitigation rather
 * than a fix in both apps; the fix is a subset with the glyph in it.
 */
export const font = {
  display: 'BricolageGrotesque',
  sans: 'InstrumentSans',
  mono: 'SplineSansMono',
} as const;

/**
 * Elevation, expressed for both platforms. iOS takes a shadow, Android takes
 * an elevation number, and giving only one leaves the other flat.
 *
 * A function of the palette because the shadow colour is not: navy at 6%
 * over a white card reads as depth, and the same navy over a near-black one
 * reads as a smudge. On black the shadow is black — which is invisible, and
 * correctly so, because a card on a true-black page is separated by its
 * lightness rather than by a glow.
 */
export function shadowsFor(palette: Palette) {
  const tint = palette.bg === '#000000' ? '#000000' : '#0D1B3E';
  return {
    card: Platform.select({
      ios: {
        shadowColor: tint,
        shadowOpacity: 0.06,
        shadowRadius: 8,
        shadowOffset: { width: 0, height: 2 },
      },
      android: { elevation: 2 },
      default: {},
    }),
    raised: Platform.select({
      ios: {
        shadowColor: tint,
        shadowOpacity: 0.1,
        shadowRadius: 20,
        shadowOffset: { width: 0, height: 8 },
      },
      android: { elevation: 6 },
      default: {},
    }),
  } as const;
}

/**
 * The shared stylesheet, as a function of the palette.
 *
 * `StyleSheet.create` runs once and freezes whatever colours it was handed,
 * which is exactly why the old static `styles` export could never follow the
 * device: it captured the light palette at module load. There is one sheet
 * per palette instead, built on first use and cached — there are only ever
 * two, so caching them is a Map with two entries rather than a memo that has
 * to be invalidated.
 *
 * Screens call `useStyles()`, never this.
 */
const SHEETS = new Map<Palette, ReturnType<typeof buildSheet>>();

/**
 * The sheet for a palette, built once and cached.
 *
 * Also separated from the hook, for the same reason: `StyleSheet.create`
 * freezes whatever colours it was handed, which is the exact failure this
 * cache exists to prevent, and it is worth a test that does not need React.
 */
export function stylesFor(palette: Palette): ReturnType<typeof buildSheet> {
  let sheet = SHEETS.get(palette);
  if (sheet === undefined) {
    sheet = buildSheet(palette);
    SHEETS.set(palette, sheet);
  }
  return sheet;
}

/** The sheet for the palette in force. */
export function useStyles(): ReturnType<typeof buildSheet> {
  return stylesFor(useTheme());
}

function buildSheet(colors: Palette) {
  const shadow = shadowsFor(colors);
  return StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { padding: space.lg, paddingBottom: space.xxl * 2 },

  card: {
    backgroundColor: colors.surface,
    borderColor: colors.line,
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: space.lg,
    marginBottom: space.md,
    ...(shadow.card as object),
  },

  h1: {
    color: colors.text,
    fontFamily: font.display,
    fontSize: 26,
    fontWeight: '800',
    letterSpacing: -0.6,
  },
  h2: {
    color: colors.text,
    fontFamily: font.display,
    fontSize: 18,
    fontWeight: '800',
    letterSpacing: -0.3,
  },
  lead: { color: colors.text2, fontSize: 15, marginTop: 6 },
  hint: { color: colors.text3, fontSize: 13, marginTop: 6 },

  label: {
    color: colors.text2,
    fontSize: 13.5,
    fontWeight: '600',
    marginBottom: 7,
    marginTop: space.md,
  },
  input: {
    backgroundColor: colors.surface,
    borderColor: colors.lineStrong,
    borderWidth: 1,
    borderRadius: radius.md,
    color: colors.text,
    fontFamily: font.sans,
    paddingHorizontal: 15,
    // 50pt, matching the web. Anything smaller is a field people miss.
    minHeight: 50,
    fontSize: 16,
  },

  button: {
    backgroundColor: colors.brand,
    borderRadius: radius.pill,
    minHeight: 48,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    paddingHorizontal: 20,
    marginTop: space.lg,
  },
  buttonText: {
    color: colors.onBrand,
    fontFamily: font.sans,
    fontWeight: '600',
    fontSize: 15,
  },
  buttonQuiet: { backgroundColor: colors.surface2 },
  buttonQuietText: { color: colors.text },

  /* Tabular figures, so a column of balances lines up and a digit changing
     does not shift the ones beside it. */
  balance: {
    color: colors.text,
    fontFamily: font.display,
    fontSize: 34,
    fontWeight: '800',
    letterSpacing: -1,
    fontVariant: ['tabular-nums'],
  },
  amount: {
    color: colors.text,
    fontFamily: font.mono,
    fontSize: 15,
    fontVariant: ['tabular-nums'],
  },

  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 13,
    paddingVertical: 13,
    borderBottomColor: colors.line,
    borderBottomWidth: 1,
  },
  rowIcon: {
    width: 42,
    height: 42,
    borderRadius: 12,
    backgroundColor: colors.surface2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowBetween: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },

  badge: {
    paddingHorizontal: 10,
    paddingVertical: 3,
    borderRadius: radius.pill,
    backgroundColor: colors.surface2,
  },
  badgeText: { color: colors.text2, fontSize: 12, fontWeight: '600' },

  error: { color: colors.danger, fontSize: 13.5, marginTop: 10 },
  ok: { color: colors.ok, fontSize: 13.5, marginTop: 10 },
  muted: { color: colors.text3, fontSize: 12.5 },
    link: { color: colors.link, fontSize: 14.5, fontWeight: '600' },
  });
}
