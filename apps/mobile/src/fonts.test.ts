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
 * Checked in three directions, because two of them fail silently: a face named
 * with no file, a file registered under a key nothing uses, and a `fontFamily`
 * string anywhere in the app that is not one of the three.
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
  return Array.from((block[1] ?? '').matchAll(/(\w+):\s*require/g), (m) => m[1] as string);
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
    expect(strays, `fontFamily strings that are not one of the three:\n${strays.join('\n')}`)
      .toEqual([]);
  });
});

function walk(dir: string): readonly string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return walk(path);
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}
