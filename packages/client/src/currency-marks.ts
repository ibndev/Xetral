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

/** Simple bands, which is what these three flags are. */
export interface FlagMark {
  readonly kind: 'flag';
  readonly direction: 'vertical' | 'horizontal';
  /** Left to right, or top to bottom. */
  readonly bands: readonly string[];
  /** Centred over the bands. Ghana's star, and nothing else here. */
  readonly star?: string;
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
  },
  KES: { kind: 'flag', direction: 'horizontal', bands: ['#000000', '#BB0000', '#006600'] },

  // Symbols, because a dollar is not a country's. The greens and blues are
  // each currency's own, so two dollars never look like the same money.
  USD: { kind: 'symbol', symbol: '$', ink: '#1B7A4B', ground: '#E7F6EE' },
  GBP: { kind: 'symbol', symbol: '£', ink: '#3866E0', ground: '#EAF0FE' },
  EUR: { kind: 'symbol', symbol: '€', ink: '#3866E0', ground: '#EAF0FE' },
  JPY: { kind: 'symbol', symbol: '¥', ink: '#B7791F', ground: '#FDF3E2' },

  // The chains use each token's own brand colour, which is how they are shown
  // everywhere else a customer has seen them.
  USDT: { kind: 'symbol', symbol: '₮', ink: '#0B8A7D', ground: '#E3F5F2' },
  USDC: { kind: 'symbol', symbol: '$', ink: '#2775CA', ground: '#E6F0FB' },
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
  GH: {
    kind: 'flag',
    direction: 'horizontal',
    bands: ['#CE1126', '#FCD116', '#006B3F'],
    star: '#000000',
  },
  KE: { kind: 'flag', direction: 'horizontal', bands: ['#000000', '#BB0000', '#006600'] },
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
