import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * ONE ANSWER TO "WHICH ONE AM I ON", ACROSS EVERY NAVIGATION.
 *
 * There were three. The customer sidebar filled the active item with
 * `--brand` — a solid navy pill, which is also the TEXT colour, so it read as
 * a block rather than as a selection and was heavier than the primary action
 * on the page it led to. The tab bar six pixels below it used `--iris`. The
 * operations sidebar used `--link`, which is blue.
 *
 * Nothing was broken and nothing could have reported it: three correct rules,
 * in three places, written at three different times. A customer moving
 * between the phone layout and the laptop one, or an operator moving between
 * the two surfaces, had to learn a different colour for the same idea each
 * time.
 *
 * This test is what stops the fourth navigation picking a fourth colour. It
 * reads the ACCENT out of each active rule rather than the whole declaration,
 * because the shape may legitimately differ — the tab bar tints text and the
 * sidebars tint a pill — and it is the HUE that has to agree.
 */
const HERE = new URL('.', import.meta.url).pathname;
const CSS = join(HERE, '..', 'app', 'globals.css');

/** Every navigation in the product, and the selector that marks its
 *  selection. A new one is added here, which is the moment somebody reads
 *  the comment above. */
const NAVS = [
  { name: 'the customer sidebar', selector: '.sidenav a.active' },
  { name: 'the customer tab bar', selector: '.tabbar a.active' },
  { name: 'the operations sidebar', selector: '.admin-side a.active' },
] as const;

/** Which custom properties count as "the accent". `--iris-tint` and
 *  `--iris-text` are the same hue at different weights, which is the point:
 *  a tinted pill and tinted text are both iris. */
const IRIS = /var\(--iris(-tint|-text|-edge|-glow)?\)/;

describe('the navigations agree about what selected looks like', () => {
  const css = readFileSync(CSS, 'utf8').replace(/\/\*[\s\S]*?\*\//g, ' ');

  for (const nav of NAVS) {
    it(`${nav.name} marks its selection with the product's accent`, () => {
      const at = css.indexOf(nav.selector);
      expect(at, `${nav.selector} has no rule in globals.css`).toBeGreaterThan(-1);
      const body = css.slice(at, css.indexOf('}', at));
      expect(
        IRIS.test(body),
        `${nav.selector} does not use the iris accent — it reads:\n${body.trim()}\n\n` +
          'Three navigations once gave three different answers to "which one am I on". ' +
          'If this selection genuinely should not be iris, change the rule AND this test ' +
          'together, so the decision is in the diff.',
      ).toBe(true);
    });
  }

  it('none of them FILLS with a colour that is also the text colour', () => {
    /*
     * `--brand` is the navy this product sets body text in. Filling a nav
     * item with it produces a solid block of the same ink as the heading
     * beside it — which is what the customer sidebar did, and is why the
     * selection read as a slab rather than as a state.
     */
    for (const nav of NAVS) {
      const at = css.indexOf(nav.selector);
      const body = css.slice(at, css.indexOf('}', at));
      expect(
        /background:\s*var\(--brand\)/.test(body),
        `${nav.selector} fills with var(--brand), which is also the text colour`,
      ).toBe(false);
    }
  });
});
