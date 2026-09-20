import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * NO NATIVE `<select>` ANYWHERE IN THIS APP.
 *
 * The open list of a `<select>` is drawn by the operating system and takes no
 * CSS at all: Android renders a full-screen dialog in the system font, iOS a
 * wheel at the bottom of the screen. Neither knows this app has a dark theme,
 * so a customer in dark mode opened a currency picker and got a white sheet in
 * a stranger's typeface — reported as looking broken, correctly.
 *
 * Every one is now `ui/select.tsx`. This is what stops the next one coming
 * back, and it will be tempting: a native select is one line and this
 * component is an import and a prop. The cost of the shortcut is invisible on
 * a developer's laptop, where the OS list happens to be light and so is the
 * page, which is exactly why a person reviewing a diff would not catch it.
 */

const APP = join(import.meta.dirname, '..', 'app');

/** Every .tsx under app/, with `withFileTypes` so there is no readdir-then-stat
 *  race — CodeQL flagged that shape in a sibling test and was right. */
function screens(dir: string): readonly string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...screens(path));
    else if (entry.name.endsWith('.tsx')) found.push(path);
  }
  return found;
}

/** Block and line comments removed, so the guard reads CODE. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
}

describe('the dropdowns this app draws', () => {
  it('has replaced every native select', () => {
    /*
     * COMMENTS ARE STRIPPED FIRST, and that is a correction rather than a
     * loosening.
     *
     * This read the raw file, so a comment EXPLAINING why a native dropdown
     * is wrong reported the file as containing one — the guard firing on the
     * prose that documents it. A rule that fires on correct code is worse
     * than no rule, because the fix is an ignore comment and the next real
     * finding gets the same treatment.
     *
     * It is also strictly more accurate: a `<select>` inside a block comment
     * renders nothing, and one outside a comment still matches.
     * `palette-parity.test.ts` already reads its inputs this way.
     */
    const offenders = screens(APP)
      .filter((file) => /<select[\s>]/.test(withoutComments(readFileSync(file, 'utf8'))))
      .map((file) => file.slice(APP.length + 1));

    expect(
      offenders,
      `these render an OS dropdown that ignores the theme; use <Select> from ` +
        `@/ui/select instead:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('and the replacement is actually reachable from screens', () => {
    // A component nothing imports is a component somebody deletes. This also
    // catches the half-done migration: the rule above passing because a
    // screen dropped its picker rather than because it converted one.
    const users = screens(APP).filter((file) =>
      readFileSync(file, 'utf8').includes("from '@/ui/select'"),
    );
    expect(users.length).toBeGreaterThan(5);
  });
});

/**
 * THE OPEN LIST IS A MODAL, AND IT HAS TO STAY ONE.
 *
 * As a panel absolutely positioned against its trigger it could WIDEN THE
 * PAGE — a `min-width` plus a trigger near the right edge extends past the
 * viewport, the layout viewport grows, and a phone browser zooms out to show
 * the lot. Every `position: fixed` control is then laid out against something
 * wider than the screen, which is how the Send flow's way back ended up off
 * it and needed a two-finger zoom to reach.
 *
 * The failure is invisible on a laptop: a 1400px window never reveals a
 * 380px screen's overflow, and the picker looks correct in both themes. So it
 * is asserted rather than remembered — the argument `select-coverage` already
 * makes about a native `<select>` looking fine on the machine it was built on.
 */
describe('the picker is a modal, not a panel', () => {
  const source = readFileSync(
    join(new URL('.', import.meta.url).pathname, 'select.tsx'),
    'utf8',
  );
  const css = readFileSync(
    join(new URL('.', import.meta.url).pathname, '..', 'app', 'globals.css'),
    'utf8',
  );

  it('portals the open list out of the trigger', () => {
    // `.screen-in` carries an animation and an animation creates a containing
    // block, so a `fixed` child of one is laid out against the CONTENT — the
    // same trap the Send flow's Back pill records.
    expect(source).toContain('createPortal');
    expect(source).toContain('document.body');
    expect(source).toContain('xsheet-backdrop');
  });

  it('bounds the sheet by the viewport rather than by its contents', () => {
    expect(/\.xsheet-backdrop\s*\{[^}]*position:\s*fixed/.test(css)).toBe(true);
    // The cap is what makes "can never widen the page" true rather than
    // merely likely: a sheet is at most the screen.
    expect(/\.xsheet\s*\{[^}]*max-width:\s*min\(520px,\s*100vw\)/.test(css)).toBe(true);
  });

  it('neutralises the panel placement inside the sheet, in ONE place', () => {
    // Each picker variant carried its own `left`, `right` and `min-width`; a
    // variant that kept one would be a list floating out of the sheet.
    const block = css.slice(css.indexOf('.xsheet .xselect-list,'));
    expect(block.slice(0, 400)).toContain('position: static');
    expect(block.slice(0, 400)).toContain('min-width: 0');
  });

  it('refuses a page that can scroll sideways', () => {
    expect(/html,\s*body\s*\{[^}]*overflow-x:\s*hidden/.test(css)).toBe(true);
  });
});
