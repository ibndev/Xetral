import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * EVERY FACE THE STYLESHEET NAMES IS A FILE THAT IS LOADED.
 *
 * It was not, for the whole life of this app. `theme.ts` set
 * `fontFamily: 'BricolageGrotesque'` on every heading and `'SplineSansMono'`
 * on every amount, and its own comment said they were "loaded by `_layout.tsx`
 * through `expo-font`". `expo-font` was not a dependency, no font file existed
 * under `apps/mobile`, and nothing called `useFonts`.
 *
 * Nothing could fail. An unregistered family name is not an error on either
 * platform — the text renders in the system face — so the app looked slightly
 * plain and entirely working, while the code and its comment both claimed
 * otherwise. That is the exact shape `class-coverage.test.ts` exists to catch
 * on the web: a name asked for and never defined.
 *
 * Checked in four directions, because three of them fail silently: a face
 * named with no file, a file registered under a key nothing uses, a
 * `fontFamily` string anywhere in the app that is not one of them, and — the
 * one that cost a round — a `fontWeight` set beside a custom family.
 *
 * THAT LAST ONE IS WHY THERE IS A FACE PER WEIGHT. React Native does not
 * synthesize weight: on Android a custom `fontFamily` is matched by NAME and
 * `fontWeight` is ignored entirely. So one Regular file meant every label,
 * button and currency code in the app rendered at 400 while the stylesheet
 * said 600 — reported as "the mobile text is too thin", and invisible to
 * every test here because the NUMBERS matched the web's exactly.
 */

const HERE = new URL('.', import.meta.url).pathname;
const FONT_DIR = join(HERE, '..', 'assets', 'fonts');
const LAYOUT = join(HERE, '..', 'app', '_layout.tsx');
const THEME = join(HERE, 'theme.ts');

/**
 * The three faces, read from `theme.ts` AS TEXT rather than imported.
 *
 * Importing it pulls in `react-native`, whose source is Flow-typed and which
 * vite cannot parse — the other tests here mock the module to get around that,
 * and mocking it to read a plain object literal would be more machinery than
 * the thing being checked.
 */
function named(): readonly string[] {
  const block = readFileSync(THEME, 'utf8').match(/export const font = \{([\s\S]*?)\}/);
  if (block === null) throw new Error('no `font` object in theme.ts');
  return Array.from((block[1] ?? '').matchAll(/'([^']+)'/g), (m) => m[1] as string);
}

/** The keys `useFonts` registers, which is what `fontFamily` matches — NOT the
 *  family name inside the file. */
function registered(): readonly string[] {
  const source = readFileSync(LAYOUT, 'utf8');
  const block = source.match(/useFonts\(\{([\s\S]*?)\}\)/);
  if (block === null) throw new Error('nothing calls useFonts in _layout.tsx');
  // Quoted, because a face key with a hyphen — `'InstrumentSans-Bold'` — is
  // not a bare identifier and an unquoted-only pattern silently matches none
  // of them, which reads as "nothing is registered".
  return Array.from(
    (block[1] ?? '').matchAll(/'?([\w-]+)'?:\s*require/g),
    (m) => m[1] as string,
  );
}

describe('the brand typefaces', () => {
  const keys = registered();

  it('every face the theme names is registered', () => {
    const missing = named().filter((face) => !keys.includes(face));
    expect(missing, `named in theme.ts and never loaded:\n${missing.join('\n')}`).toEqual([]);
  });

  it('every registered face ships a file that exists', () => {
    const absent = keys.filter((key) => !existsSync(join(FONT_DIR, `${key}.ttf`)));
    expect(absent, `registered with no .ttf:\n${absent.join('\n')}`).toEqual([]);
  });

  it('the files are TTF, not the web app\'s woff2', () => {
    // React Native cannot read woff2. The files here are converted from the
    // web's, and a copy made by hand would be a bundle that builds and an app
    // whose text falls back to Roboto with no error anywhere.
    for (const key of keys) {
      const head = readFileSync(join(FONT_DIR, `${key}.ttf`)).subarray(0, 4);
      expect(head.toString('latin1'), `${key}.ttf is not a TrueType file`).not.toBe('wOF2');
    }
  });

  it('no screen names a face the theme does not', () => {
    // A one-off `fontFamily: 'Something'` in a screen is the way a fourth face
    // gets asked for and never loaded.
    const app = join(HERE, '..', 'app');
    const files = [
      ...walk(app),
      ...walk(HERE).filter((f) => !f.endsWith('.test.ts')),
    ];
    const allowed = new Set(named());
    const strays: string[] = [];
    for (const file of files) {
      for (const m of readFileSync(file, 'utf8').matchAll(/fontFamily:\s*'([^']+)'/g)) {
        if (!allowed.has(m[1] as string)) strays.push(`${file.slice(HERE.length)}: ${m[1]}`);
      }
    }
    expect(strays, `fontFamily strings the theme does not name:\n${strays.join('\n')}`)
      .toEqual([]);
  });

  it('NO STYLE SETS fontWeight OR fontStyle BESIDE A CUSTOM FAMILY', () => {
    /*
     * The bug this whole arrangement exists for. `fontFamily` plus
     * `fontWeight` reads as obviously correct — it is what the web does — and
     * on Android the weight is dropped, so the text renders at whatever
     * weight the single registered file happens to be. On iOS it is worse in
     * a different way: a faux-bold is synthesized ON TOP of an already-bold
     * face, which looks deliberate.
     *
     * The weights are real files now. Picking one is naming it.
     */
    const files = [...walk(join(HERE, '..', 'app')), ...walk(HERE)]
      .filter((f) => !f.endsWith('.test.ts'));
    const offenders: string[] = [];

    for (const file of files) {
      // COMMENTS STRIPPED FIRST. This rule is worth explaining at its call
      // sites, and an explanation that names both properties is otherwise
      // read as a violation of itself — which it did, on the very comment
      // saying not to do the thing.
      const source = readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/(^|[^:])\/\/[^\n]*/g, '$1');

      // A style object literal that mentions both, in either order, with
      // nothing but other properties between them.
      for (const m of source.matchAll(/\{[^{}]*\}/g)) {
        const block = m[0];
        if (!/fontFamily:/.test(block)) continue;
        // `fontStyle` is the SAME BUG in a second property, and it cost a
        // round of its own: the card face set `fontStyle: 'italic'` beside
        // `font.displayBold`, no italic Bricolage file is registered, and
        // Android fell back to the system face at regular weight. Reported as
        // "the VISA on the card is too light" — a WEIGHT symptom from a SLANT
        // property, which is why nobody looked here. A slant that must survive
        // belongs in `transform: [{ skewX }]`, which the view layer draws and
        // font matching never sees.
        const property = /fontWeight:/.test(block)
          ? 'fontWeight'
          : /fontStyle:/.test(block)
            ? 'fontStyle'
            : undefined;
        if (property !== undefined) {
          offenders.push(
            `${file.slice(HERE.length)} (${property}): ${block.replace(/\s+/g, ' ').slice(0, 90)}`,
          );
        }
      }
    }

    expect(
      offenders,
      'these set a weight or a slant beside a custom family, which Android ' +
        'resolves by looking for a face that is not registered and falling ' +
        'back — use the face that IS the weight (font.sansSemi, ' +
        `font.displayBold, …), and skewX for a slant:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });
});

function walk(dir: string): readonly string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return walk(path);
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}
