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
  readonly surface2: string; readonly surfaceRaised: string;
  readonly line: string; readonly lineStrong: string;
  /**
   * THE OUTLINE ROUND A CONTAINER OR A FIELD — transparent in light, the line
   * in dark. `--edge` on the web, and here for the same reason: a light
   * container is already a shade DARKER than the ground, which is what the eye
   * reads as a recess, so the hairline on top was a second cue for one fact
   * and made every card an outlined box. On black there is no darker fill to
   * recess into, so dark keeps its border.
   *
   * `line` is deliberately unchanged: a divider separates things that would
   * otherwise run together, in either theme.
   */
  readonly edge: string; readonly edgeStrong: string;
  /**
   * A TEXT INPUT'S FILL — one step deeper than the card holding it.
   *
   * When the outline came off, a field and its card were the SAME fill, so
   * nothing marked where you could type: "the input fields are not visible on
   * the white theme". A card is one step down from the page and a field is one
   * step down from the card, which is the ordinary recess cue doing the work
   * the border used to.
   */
  readonly field: string;
  /** The "get a rate" button: filled and obvious in both themes, and NOT the
   *  inverted brand — see `buttonAccent`. Navy on light, navy with a
   *  light-blue rim on dark, matching the web's `.btn.accent`. */
  readonly accentButton: string; readonly accentButtonEdge: string;
  readonly accentButtonText: string;
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

  /*
   * THE GROUND IS PURE WHITE AND EVERY CONTAINER ON IT IS RECESSED INTO IT,
   * exactly as `globals.css` defines it for the web. These are the SAME hex
   * values, not an approximation: the two apps are one product and a customer
   * holding both should not be able to tell which they are looking at from
   * the colour of the page.
   *
   * `surfaceRaised` goes the other way — lighter than the ground — and is for
   * the only things that genuinely sit in front of the page: a dropdown, a
   * sheet. Everything else is flat and darker. See the long note in
   * `globals.css` for why this file has now argued the question twice.
   */
  bg: '#FFFFFF',
  surface: '#F1F3F9',
  surface2: '#E4E8F0',
  surfaceRaised: '#FFFFFF',
  field: '#E4E8F0',
  line: '#E7EAF0',
  lineStrong: '#D5D9E2',
  edge: 'transparent',
  edgeStrong: 'transparent',
  // `--ink`, the same near-black navy the primary button uses on light.
  accentButton: '#0D1B3E',
  accentButtonEdge: 'transparent',
  accentButtonText: '#FFFFFF',

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
  surfaceRaised: '#1B1D23',
  // On black a field lifts rather than recesses, and keeps its border.
  field: '#141519',
  line: '#212227',
  lineStrong: '#303237',
  edge: '#212227',
  edgeStrong: '#303237',
  // `--ink-700` with a `--link` rim: navy that reads as a control on black,
  // with the light blue saying it is pressable without spending the white the
  // primary button owns.
  accentButton: '#16295A',
  accentButtonEdge: '#6E9BFF',
  accentButtonText: '#FFFFFF',

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
/**
 * A FAMILY PER WEIGHT, because React Native does not synthesize one.
 *
 * This was three keys — `display`, `sans`, `mono` — and every style set
 * `fontFamily` alongside a `fontWeight` of 600 or 700. On the web that is
 * exactly right: all three faces are VARIABLE fonts and the browser
 * interpolates any weight in the range from the one file. Android does no
 * such thing. With a custom `fontFamily` it matches a registered face by NAME
 * and ignores `fontWeight` entirely, so a single Regular file meant every
 * label, button, currency code and "Available balance" in the app rendered at
 * 400 while the code said 600.
 *
 * That is what "the mobile text is too thin" was, and it could not be seen
 * from the stylesheet: the numbers there already matched the web's exactly.
 * The weights are now real files, instanced from the SAME variable fonts the
 * web serves, so the two apps render the same shapes at the same weights.
 *
 * NEVER set `fontWeight` beside one of these. Pick the family that is the
 * weight — `fontWeight` alongside a custom family is either ignored (Android)
 * or synthesizes a faux-bold on top of an already-bold face (iOS), and the
 * second is worse than the first because it looks deliberate.
 */
export const font = {
  /** Display — headings and the balance. */
  display: 'BricolageGrotesque-Regular',
  displaySemi: 'BricolageGrotesque-SemiBold',
  displayBold: 'BricolageGrotesque-ExtraBold',

  /** Body, labels, buttons. */
  sans: 'InstrumentSans-Regular',
  sansMedium: 'InstrumentSans-Medium',
  sansSemi: 'InstrumentSans-SemiBold',
  sansBold: 'InstrumentSans-Bold',

  /** Figures. */
  mono: 'SplineSansMono-Regular',
  monoSemi: 'SplineSansMono-SemiBold',
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
 *
 * NOTHING IN THE SHARED SHEET USES `card` ANY MORE. A container is recessed
 * into the page — darker fill, no shadow — and a shadow under a recess reads
 * as neither. Kept because a sheet or a menu drawn over the screen is still
 * in front of it and still needs `raised`; a container is not.
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
  return StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { padding: space.lg, paddingBottom: space.xxl * 2 },

  /* Flat, matching `.card` on the web to the pixel: the fill is one shade
     below the page and that is the whole of what makes it a card. Android's
     `elevation` was the visible half of this — a real drop shadow under every
     container, which is the raised look the design does not want. */
  card: {
    backgroundColor: colors.surface,
    // Transparent in light — see `edge` on the palette. The fill is what makes
    // this a card; the border only has work to do on black.
    borderColor: colors.edge,
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: space.lg,
    marginBottom: space.md,
  },

  h1: {
    color: colors.text,
    // The 800 face BY NAME. `fontWeight: '800'` beside a custom family is
    // ignored on Android, which is why the greeting rendered thin.
    fontFamily: font.displayBold,
    fontSize: 26,
    letterSpacing: -0.6,
  },
  h2: {
    color: colors.text,
    fontFamily: font.displayBold,
    // 19, matching the web's `h2` rather than sitting a point under it.
    fontSize: 19,
    letterSpacing: -0.3,
  },
  lead: { color: colors.text2, fontFamily: font.sans, fontSize: 15, marginTop: 6, lineHeight: 22 },
  hint: { color: colors.text3, fontFamily: font.sans, fontSize: 13, marginTop: 6, lineHeight: 19 },

  /*
   * `marginTop` here is what separates one field from the next, and it was
   * `space.md` — which, stacked over six fields, is the wall of white space
   * the signup form was reported for. It matches the web's 13px auth-card gap
   * now, so the two forms are the same shape on both platforms rather than
   * merely the same fields.
   */
  label: {
    color: colors.text2,
    fontFamily: font.sansSemi,
    fontSize: 13.5,
    marginBottom: 6,
    marginTop: 13,
  },

  /**
   * A label on an AUTH form, which the web sizes differently from a label in
   * the app: 13 rather than 13.5, and no top margin because `.auth-card` is a
   * grid with an 18px gap doing the spacing. Matching that here is what stops
   * the sign-in screen being a near-miss of the web's.
   */
  fieldLabel: {
    color: colors.text2,
    fontFamily: font.sansSemi,
    fontSize: 13,
    marginBottom: 7,
  },
  input: {
    backgroundColor: colors.field,
    // No visible border at rest in light. A field is recognised by its fill,
    // and a ruled rectangle at rest is an outline rather than an affordance.
    borderColor: colors.edgeStrong,
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
    fontFamily: font.sansSemi,
    fontSize: 15,
  },
  buttonQuiet: { backgroundColor: colors.surface2 },
  buttonQuietText: { color: colors.text },

  /*
   * THE BUTTON THAT HAS TO BE SEEN — the web's `.btn.accent`.
   *
   * "Get a quote" was `quiet`, which is a `surface2` fill: correct for a
   * secondary action beside a primary one, and wrong when it is the ONLY thing
   * on the screen that does anything. It was the least visible control on the
   * Convert screen while being the one that has to be pressed first.
   *
   * In DARK it is navy with a light-blue rim rather than the inverted white
   * brand: a white button on black reads as the primary action of the whole
   * screen, and this one is a step on the way to `Convert`.
   */
  buttonAccent: {
    backgroundColor: colors.accentButton,
    borderColor: colors.accentButtonEdge,
    borderWidth: 1,
  },
  buttonAccentText: { color: colors.accentButtonText },

  /* Tabular figures, so a column of balances lines up and a digit changing
     does not shift the ones beside it. */
  balance: {
    color: colors.text,
    fontFamily: font.displayBold,
    fontSize: 34,
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
  badgeText: { color: colors.text2, fontFamily: font.sansSemi, fontSize: 12 },

  error: { color: colors.danger, fontSize: 13.5, marginTop: 10 },
  ok: { color: colors.ok, fontSize: 13.5, marginTop: 10 },
  muted: { color: colors.text3, fontFamily: font.sans, fontSize: 12.5 },
    link: { color: colors.link, fontFamily: font.sansSemi, fontSize: 14.5 },
  });
}
