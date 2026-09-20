import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * NO FLOW CARRIES A PALETTE OF ITS OWN.
 *
 * The Send flow did, for a whole design generation. `--sf-*` held sixteen
 * hardcoded hex values described in a comment as "the uploaded mockups' exact
 * values" — from the mockups BEFORE the commissioned design, whose accent was
 * BLUE. So the one flow this product exists for was drawn in a hue that
 * appears nowhere else in it: the New recipient tile, the currency chips, the
 * Continue button and the Change link were all #3B6FE8 on a screen whose Send
 * button, two steps earlier, is iris.
 *
 * NOTHING COULD HAVE REPORTED IT. The tokens were correctly defined, the
 * rules correctly referenced them, and the DARK block already pointed every
 * one at a product token — so on the theme most of this was built in, the
 * flow looked right. It was visible only in light, in a rendered screenshot,
 * beside a screen that used the real accent.
 *
 * So a namespaced token must NAME a product token rather than hold a value.
 * That keeps the namespace useful — `--sf-accent` still says "this is the
 * send flow's reading of the system", which is what would make a deliberate
 * divergence visible — while making an accidental one impossible.
 */
const CSS = readFileSync(
  join(new URL('.', import.meta.url).pathname, '..', 'app', 'globals.css'),
  'utf8',
);

/**
 * Prefixes that belong to ONE surface rather than to the product.
 *
 * The product's own tokens — `--iris`, `--text`, `--surface` — are where
 * literals are SUPPOSED to live, so they are not listed. A new namespace is
 * added here, which is the moment somebody reads the comment above.
 */
const NAMESPACES = ['--sf-'] as const;

describe('one palette', () => {
  for (const prefix of NAMESPACES) {
    it(`every ${prefix}* token names a product token rather than a value`, () => {
      const stripped = CSS.replace(/\/\*[\s\S]*?\*\//g, ' ');
      const literals = Array.from(
        stripped.matchAll(new RegExp(`(${prefix}[a-z0-9-]+)\\s*:\\s*([^;]+);`, 'g')),
      )
        .map((m) => ({ name: m[1] as string, value: (m[2] ?? '').trim() }))
        // `transparent`, `none` and `inherit` are keywords rather than
        // colours — they cannot drift from the system because they are not
        // in it.
        .filter((d) => !/^(transparent|none|inherit|currentColor)$/i.test(d.value))
        .filter((d) => !d.value.includes('var(--'));

      expect(
        literals.map((d) => `${d.name}: ${d.value}`),
        `these hold a value instead of naming a product token, so they drift ` +
          `from the rest of the product silently:\n` +
          literals.map((d) => `${d.name}: ${d.value}`).join('\n'),
      ).toEqual([]);
    });
  }

  it('finds the tokens at all', () => {
    // Without this the assertion above passes on a typo'd prefix, which is
    // the shape of a guard that cannot fail.
    for (const prefix of NAMESPACES) {
      expect(CSS.split(prefix).length - 1, `${prefix} appears nowhere`).toBeGreaterThan(10);
    }
  });
});
