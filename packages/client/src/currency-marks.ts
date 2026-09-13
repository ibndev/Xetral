/**
 * The little round thing beside a currency code.
 *
 * ONE DEFINITION, TWO RENDERERS. The data lives here and each app draws it —
 * the web with inline SVG, the phone with `react-native-svg` — because the
 * alternative is two lists of colours that drift, and a naira mark that is
 * green on one platform and grey on the other is the kind of difference
 * nobody reports and everybody notices.
 *
 * NOT EMOJI FLAGS, and that is the whole reason this file exists rather than
 * a map of `🇳🇬`. Windows has never shipped flag glyphs, so `🇳🇬` renders
 * there as the letters "NG" in a box — on the currency selector, on the one
 * screen every customer opens. Emoji also cannot be sized or aligned against
 * a text baseline reliably across platforms.
 *
 * FLAGS ONLY WHERE A FLAG IS THE RECOGNISABLE THING. Naira, cedi and shilling
 * are each the money of one country and the flag reads instantly. A dollar is
 * not: the symbol is what people recognise, and a US flag beside USD would be
 * actively wrong next to USDT and USDC, which are dollars belonging to no
 * country at all. So a mark is a flag or a symbol, and which one is a
 * statement about the currency rather than a shortcut.
 */

/** Bands, and the two devices that make two of these flags themselves. */
export interface FlagMark {
  readonly kind: 'flag';
  readonly direction: 'vertical' | 'horizontal';
  /** Left to right, or top to bottom. */
  readonly bands: readonly string[];
  /**
   * HOW WIDE EACH BAND IS, relative to the others. Absent means equal.
   *
   * KENYA IS WHY THIS EXISTS. Its flag is black, WHITE, red, WHITE, green —
   * the two white stripes are thin fimbriations, not equal bands — and drawn
   * as three equal ones it is a generic black/red/green tricolour that is not
   * Kenya's flag at all. Equal fifths would be just as wrong in the other
   * direction, so the widths are data.
   */
  readonly weights?: readonly number[];
  /**
   * Centred over the bands. Ghana's star.
   *
   * `radius` is a FRACTION OF THE DISC, because Ghana's star is a large,
   * prominent device — drawn at a fifth of the width it reads as a speck and
   * the flag becomes an anonymous tricolour.
   */
  readonly star?: string;
  readonly starRadius?: number;
  /**
   * Kenya's Maasai shield, as much of it as survives eighteen pixels.
   *
   * A shield and two crossed spears cannot be drawn at that size and would be
   * mud if attempted. What DOES survive — and what makes the flag read as
   * Kenya rather than as three stripes — is a red-and-white lozenge standing
   * upright in the centre. Naming it as a shape rather than shipping a path
   * keeps both renderers honest about what they are drawing.
   */
  readonly shield?: { readonly body: string; readonly edge: string };
  /**
   * A union in the top-left corner — the United States' canton.
   *
   * Given as FRACTIONS of the disc rather than pixels, because the same mark
   * is drawn at 18px in a chip and 38px in a picker and the proportions have
   * to hold at both. The stars are deliberately absent: fifty of them at
   * eighteen pixels is noise, and what identifies the flag at this size is
   * the stripes plus the block of blue.
   */
  readonly canton?: { readonly ground: string; readonly width: number; readonly height: number };
}

/** A symbol on a tinted disc, for money that is not one country's. */
export interface SymbolMark {
  readonly kind: 'symbol';
  readonly symbol: string;
  readonly ink: string;
  readonly ground: string;
}

export type CurrencyMark = FlagMark | SymbolMark;

export const CURRENCY_MARKS: Readonly<Record<string, CurrencyMark>> = {
  // Green, white, green. The one every customer of this platform reads first.
  NGN: { kind: 'flag', direction: 'vertical', bands: ['#008751', '#FFFFFF', '#008751'] },
  // Red, gold, green with a black star. Simplified to bands plus the star,
  // which is what survives being drawn at eighteen pixels.
  GHS: {
    kind: 'flag',
    direction: 'horizontal',
    bands: ['#CE1126', '#FCD116', '#006B3F'],
    star: '#000000',
    // Ghana's black star is the flag. At a fifth of the disc it was a speck
    // sitting in a red/gold/green tricolour, which is a description of
    // several flags and a picture of none.
    starRadius: 0.3,
  },
  // Black, WHITE, red, WHITE, green, with the shield standing in the middle.
  // Drawn as three equal bands this was not Kenya's flag — it was a generic
  // tricolour, which is what was reported.
  KES: {
    kind: 'flag',
    direction: 'horizontal',
    bands: ['#000000', '#FFFFFF', '#BB0000', '#FFFFFF', '#006600'],
    weights: [6, 1, 6, 1, 6],
    shield: { body: '#BB0000', edge: '#FFFFFF' },
  },

  // Symbols, because a dollar is not a country's. The greens and blues are
  // each currency's own, so two dollars never look like the same money.
  /*
   * THE UNITED STATES' FLAG, not a green dollar sign on a pale disc.
   *
   * A dollar belongs to no country in this product's own framing — which is
   * why USDT and USDC are brand discs — but USD itself is the United States',
   * and a customer picking it looks for that flag. Thirteen stripes and the
   * canton; no stars, because fifty of them at this size are a smudge.
   */
  USD: {
    kind: 'flag',
    direction: 'horizontal',
    bands: [
      '#B22234', '#FFFFFF', '#B22234', '#FFFFFF', '#B22234', '#FFFFFF', '#B22234',
      '#FFFFFF', '#B22234', '#FFFFFF', '#B22234', '#FFFFFF', '#B22234',
    ],
    canton: { ground: '#3C3B6E', width: 0.46, height: 7 / 13 },
  },
  GBP: { kind: 'symbol', symbol: '£', ink: '#3866E0', ground: '#EAF0FE' },
  EUR: { kind: 'symbol', symbol: '€', ink: '#3866E0', ground: '#EAF0FE' },
  JPY: { kind: 'symbol', symbol: '¥', ink: '#B7791F', ground: '#FDF3E2' },

  // The chains use each token's own brand colour, which is how they are shown
  // everywhere else a customer has seen them.
  /*
   * THE TOKENS' OWN LOGOS: a SOLID brand disc with a white glyph, which is how
   * Tether and Circle draw them and how every customer has seen them. The pale
   * tint they had instead read as a disabled chip beside a real flag.
   */
  USDT: { kind: 'symbol', symbol: '₮', ink: '#FFFFFF', ground: '#26A17B' },
  USDC: { kind: 'symbol', symbol: '$', ink: '#FFFFFF', ground: '#2775CA' },
  BTC: { kind: 'symbol', symbol: '₿', ink: '#C77405', ground: '#FDF3E2' },
};

/**
 * A mark for any code, including one this file has never heard of.
 *
 * Falls back to the first character on a neutral disc rather than to nothing:
 * a currency added to the registry and forgotten here should look plain, not
 * broken, and certainly should not render a hole where every other row has a
 * mark.
 */
export function markFor(currency: string): CurrencyMark {
  return (
    CURRENCY_MARKS[currency] ?? {
      kind: 'symbol',
      symbol: currency.slice(0, 1),
      ink: '#4A5878',
      ground: '#F6F7F9',
    }
  );
}

/**
 * A flag per COUNTRY, for the signup form's country picker.
 *
 * SEPARATE FROM `CURRENCY_MARKS` even though the first three are the same
 * drawings, because the two are keyed on different things and only coincide
 * while every open country happens to have its own currency. The United
 * Kingdom and the United States name GBP and USD, whose marks are a POUND
 * SIGN and a DOLLAR SIGN — correct beside a balance, and wrong beside a
 * country, where what somebody is looking for is a flag.
 *
 * The union flag and the stars and stripes are not bands and are not drawn:
 * they fall through to the code badge below, which is what `markFor` already
 * does for a currency it does not know. A recognisable two-letter badge beats
 * a bad drawing of a flag people know well.
 */
export const COUNTRY_MARKS: Readonly<Record<string, CurrencyMark>> = {
  NG: { kind: 'flag', direction: 'vertical', bands: ['#008751', '#FFFFFF', '#008751'] },
  /* THE SAME FLAGS AS THE CURRENCIES ABOVE, and they have to stay that way:
     a customer sees the country mark on the dial-code picker and the currency
     mark on the balance card, and two drawings of one flag is the kind of
     difference nobody reports and everybody notices. */
  GH: {
    kind: 'flag',
    direction: 'horizontal',
    bands: ['#CE1126', '#FCD116', '#006B3F'],
    star: '#000000',
    starRadius: 0.3,
  },
  KE: {
    kind: 'flag',
    direction: 'horizontal',
    bands: ['#000000', '#FFFFFF', '#BB0000', '#FFFFFF', '#006600'],
    weights: [6, 1, 6, 1, 6],
    shield: { body: '#BB0000', edge: '#FFFFFF' },
  },
};

/** The mark for a country, or its code on a neutral disc. */
export function countryMarkFor(code: string): CurrencyMark {
  return (
    COUNTRY_MARKS[code] ?? {
      kind: 'symbol',
      symbol: code.slice(0, 2),
      ink: '#4A5878',
      ground: '#F6F7F9',
    }
  );
}
