import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * THE TWO APPS MUST BE THE SAME COLOURS, and nothing checked that they were.
 *
 * `theme.ts` says out loud that its hex values are "the SAME hex values, not
 * an approximation" as `globals.css` — and that claim was maintained by hand,
 * in two files, in two languages, edited in separate rounds. Three surface
 * revisions have now gone through both; on each one a mistyped digit in either
 * would have compiled, passed every test, and shipped as a phone that is a
 * shade off the web for a reason nobody could see in a diff.
 *
 * The same shape as `parity.test.ts` beside it, which compares ROUTES: this
 * compares the tokens both apps name. A colour only one platform has is not
 * covered and does not need to be — what breaks the product is the two
 * disagreeing about a colour they both have.
 *
 * BOTH FILES ARE READ AS TEXT. Importing `theme.ts` would pull in
 * `react-native`, whose Flow-typed sources vitest cannot parse — which is why
 * `theme.test.ts` beside this mocks it before a dynamic import. Reading text
 * also keeps the two halves symmetrical: neither side gets to be interpreted
 * by something that could be wrong about what it says.
 */

const HERE = new URL('.', import.meta.url).pathname;
const CSS = join(HERE, '..', '..', 'web', 'src', 'app', 'globals.css');
const THEME = join(HERE, 'theme.ts');

/** Which CSS custom property carries each palette key. */
const TOKENS: Record<string, string> = {
  brand: '--brand',
  brand700: '--brand-700',
  accent: '--accent',
  link: '--link',
  bg: '--bg',
  surface: '--surface',
  surface2: '--surface-2',
  surfaceRaised: '--surface-raised',
  line: '--line',
  lineStrong: '--line-strong',
  field: '--field',
  text: '--text',
  text2: '--text-2',
  text3: '--text-3',
  onBrand: '--on-brand',
  ok: '--ok',
  okBg: '--ok-bg',
  warn: '--warn',
  warnBg: '--warn-bg',
  danger: '--danger',
  dangerBg: '--danger-bg',
  info: '--info',
  infoBg: '--info-bg',
};

function withoutComments(path: string): string {
  return readFileSync(path, 'utf8').replace(/\/\*[\s\S]*?\*\//g, ' ');
}

/** The braces-balanced body of the block that starts at `header`. */
function body(source: string, header: string, what: string): string {
  const start = source.indexOf(header);
  expect(start, `${header} is not in ${what}`).toBeGreaterThanOrEqual(0);
  let depth = 0;
  for (let i = source.indexOf('{', start); i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(source.indexOf('{', start) + 1, i);
    }
  }
  throw new Error(`${header} is not closed in ${what}`);
}

/** `--bg: #FFFFFF;` → `{ '--bg': '#FFFFFF' }` */
function cssTokens(header: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of body(withoutComments(CSS), header, 'globals.css').matchAll(
    /(--[a-z0-9-]+)\s*:\s*(#[0-9A-Fa-f]{3,8})\s*;/g,
  )) {
    out[m[1] ?? ''] = (m[2] ?? '').toUpperCase();
  }
  return out;
}

/** `bg: '#FFFFFF',` → `{ bg: '#FFFFFF' }` */
function paletteHexes(header: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of body(withoutComments(THEME), header, 'theme.ts').matchAll(
    /([A-Za-z][A-Za-z0-9]*)\s*:\s*'(#[0-9A-Fa-f]{3,8})'\s*,/g,
  )) {
    out[m[1] ?? ''] = (m[2] ?? '').toUpperCase();
  }
  return out;
}

function compare(name: string, themeHeader: string, cssHeader: string): void {
  const phone = paletteHexes(themeHeader);
  const web = cssTokens(cssHeader);

  // A palette that parsed to nothing would make every comparison below vacuous
  // and the suite green — the exact way a coverage test stops covering.
  expect(Object.keys(phone).length, `${themeHeader} parsed to no colours`).toBeGreaterThan(15);

  const mismatched: string[] = [];
  for (const [key, token] of Object.entries(TOKENS)) {
    const there = web[token];
    const here = phone[key];
    // A token this CSS block does not redefine is inherited from :root, which
    // the light comparison covers. Only a DISAGREEMENT is a failure.
    if (there === undefined || here === undefined) continue;
    if (there !== here) mismatched.push(`${name}.${key}: phone ${here}, web ${token} ${there}`);
  }

  expect(
    mismatched,
    'the phone and the web disagree about a colour they both name — one of the ' +
      `two files was edited without the other:\n${mismatched.join('\n')}`,
    ).toEqual([]);
}

describe('palette parity with the web', () => {
  it('the light palette matches :root', () => {
    compare('light', 'export const light: Palette = {', ':root {');
  });

  it("the dark palette matches [data-theme='dark']", () => {
    compare('dark', 'export const dark: Palette = {', "[data-theme='dark'] {");
  });

  it('every colour the phone names and the web also names is compared', () => {
    // Otherwise a key added to both files is simply absent from TOKENS and
    // silently uncompared — the gap this file exists to close, reintroduced by
    // an omission rather than by a wrong value.
    const root = cssTokens(':root {');
    const uncovered = Object.keys(paletteHexes('export const light: Palette = {')).filter((key) => {
      if (TOKENS[key] !== undefined) return false;
      const kebab = `--${key.replace(/([A-Z])/g, '-$1').toLowerCase()}`;
      return root[kebab] !== undefined;
    });
    expect(
      uncovered,
      `these colours exist on both platforms and are not in TOKENS:\n${uncovered.join('\n')}`,
    ).toEqual([]);
  });
});
