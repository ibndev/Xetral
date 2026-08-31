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

describe('the dropdowns this app draws', () => {
  it('has replaced every native select', () => {
    const offenders = screens(APP)
      .filter((file) => /<select[\s>]/.test(readFileSync(file, 'utf8')))
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
