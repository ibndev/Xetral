import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Every custom property this stylesheet reads must be one it defines.
 *
 * `class-coverage.test.ts` catches a class name with no rule. This catches the
 * other half of the same failure, and it was live: `--text-muted` was read by
 * three rules and defined by none. An undefined custom property is not an
 * error anywhere — the declaration is dropped and the element INHERITS the
 * value from its parent — so `.panel > h2`, the quiet subtitle under every
 * operations heading, rendered at full heading contrast and read as a second
 * title on sixteen screens.
 *
 * It also checks BOTH THEMES. A token defined only in `:root` and read by a
 * rule that only applies in dark is the same bug with a narrower audience, and
 * the narrower audience is the one nobody screenshots.
 */

const HERE = new URL('.', import.meta.url).pathname;
const CSS = join(HERE, '..', 'app', 'globals.css');

/** Properties given a value inside a particular selector block. */
function definedIn(css: string, selector: string): ReadonlySet<string> {
  const start = css.indexOf(`${selector} {`);
  if (start === -1) return new Set();
  const block = css.slice(start, css.indexOf('\n}', start));
  return new Set(Array.from(block.matchAll(/(--[a-z0-9-]+)\s*:/g), (m) => m[1] as string));
}

describe('css custom properties', () => {
  const css = readFileSync(CSS, 'utf8').replace(/\/\*[\s\S]*?\*\//g, ' ');
  const light = definedIn(css, ':root');
  const dark = definedIn(css, "[data-theme='dark']");

  it('every var() read resolves to a definition', () => {
    const read = new Set(Array.from(css.matchAll(/var\((--[a-z0-9-]+)/g), (m) => m[1] as string));
    /*
     * Next injects the font variables through the root element's class, so
     * they are defined by the framework rather than by this stylesheet.
     *
     * READ FROM `layout.tsx`, not listed here. This was a hardcoded
     * `/^--font-(bricolage|instrument|spline)$/`, which is a second copy of a
     * fact that lives somewhere else — so replacing the typefaces turned this
     * test red for a variable that was perfectly well defined, and ADDING one
     * would have widened the hole silently. The names come from the
     * `variable:` fields of the `localFont` calls that create them.
     */
    const framework = new Set(
      Array.from(
        readFileSync(join(HERE, '..', 'app', 'layout.tsx'), 'utf8').matchAll(
          /variable:\s*'(--[a-z0-9-]+)'/g,
        ),
        (m) => m[1] as string,
      ),
    );
    expect(framework.size, 'no font variables found in layout.tsx').toBeGreaterThan(0);
    // And one is set inline, per element, by a component: the logo's metal
    // ramp is generated in TypeScript so the SVG gradient and the CSS one
    // cannot drift. Read from the SOURCE rather than listed here, so deleting
    // that line turns this test red instead of quietly widening the hole.
    const setInComponents = new Set(
      Array.from(
        readFileSync(join(HERE, 'logo.tsx'), 'utf8').matchAll(/'(--[a-z0-9-]+)' as string/g),
        (m) => m[1] as string,
      ),
    );
    const missing = [...read]
      .filter((name) => !light.has(name) && !dark.has(name))
      .filter((name) => !framework.has(name) && !setInComponents.has(name))
      .sort();

    expect(
      missing,
      `custom properties read by a rule and defined nowhere:\n${missing.join('\n')}`,
    ).toEqual([]);
  });

  it('the dark theme redefines nothing it has not first defined in :root', () => {
    // A token that exists ONLY under [data-theme='dark'] is undefined for
    // every viewer on the default light theme — the same failure, upside down.
    const darkOnly = [...dark].filter((name) => !light.has(name)).sort();
    expect(
      darkOnly,
      `defined only in the dark block, so undefined in light:\n${darkOnly.join('\n')}`,
    ).toEqual([]);
  });
});
