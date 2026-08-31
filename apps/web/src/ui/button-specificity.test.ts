import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * A TYPE SELECTOR MUST NOT BE ABLE TO OUTRANK A COMPONENT CLASS.
 *
 * This test exists because one did, and the result was on every screen. The
 * stylesheet styles bare `button` so that a plain <button> looks like the
 * product's primary button without anyone remembering a class. The hover rule
 * was written `button:hover:not(:disabled)` — and `:not()` contributes the
 * specificity of its argument, so that scores (0,2,1), while `.icon-btn:hover`
 * scores (0,2,0).
 *
 * The generic rule therefore won on every <button class="icon-btn">: the
 * balance eye, the theme toggle and the password reveal each painted
 * `--brand-700` behind the icon, which is near-white in dark mode. Nothing in
 * the markup was wrong, no class name was missing, `class-coverage.test.ts`
 * was green, and the compiler has no opinion about a stylesheet. It was
 * reported as "a white box appears around the icon" — which is exactly what it
 * was, and nowhere near where anybody would have looked.
 *
 * The fix is `:where(:not(:disabled))`, which matches identically and
 * contributes nothing. This test is what stops the shorter spelling coming
 * back: the two read the same in review, and only one of them is correct.
 */

const HERE = new URL('.', import.meta.url).pathname;
const CSS = join(HERE, '..', 'app', 'globals.css');

/** Element names this stylesheet deliberately styles without a class. */
const BARE = ['button', 'input', 'select', 'textarea', 'table'];

/** Selectors, with comments and declaration blocks removed. */
function selectors(): readonly string[] {
  const css = readFileSync(CSS, 'utf8').replace(/\/\*[\s\S]*?\*\//g, ' ');
  return Array.from(css.matchAll(/(^|[};])\s*([^{};@]+)\{/g), (m) => (m[2] ?? '').trim())
    .flatMap((group) => group.split(','))
    .map((one) => one.trim())
    .filter((one) => one !== '');
}

/**
 * Whether a selector's last compound is an element with no class of its own —
 * `button`, `.segmented button`, `button:hover`, but not `.btn` or
 * `button.ghost`.
 */
function endsInABareElement(selector: string): boolean {
  const last = selector.split(/\s+|>|\+|~/).filter((p) => p !== '').pop() ?? '';
  const element = last.match(/^[a-z]+/)?.[0];
  if (element === undefined || !BARE.includes(element)) return false;
  // A class anywhere in that compound means the rule is about a component,
  // not about every element of the type.
  return !last.slice(element.length).replace(/:where\([^)]*\)/g, '').includes('.');
}

describe('button styling specificity', () => {
  it('no bare element rule borrows specificity from :not()', () => {
    const offenders = selectors()
      .filter(endsInABareElement)
      .filter((selector) => /(^|[^:])\bnot\(|:not\(/.test(selector))
      // `:where(:not(…))` is the correct spelling and contributes nothing.
      .filter((selector) => !/:where\(\s*:not\([^)]*\)\s*\)/.test(selector.replace(/\s+/g, ' ')))
      .filter((selector) => {
        // Only the :not()s OUTSIDE a :where() can add specificity.
        const outside = selector.replace(/:where\([^)]*\)/g, '');
        return outside.includes(':not(');
      });

    expect(
      offenders,
      'these rules match a bare element and take specificity from :not(), so they ' +
        'outrank a component class on the same element — wrap the :not() in :where():\n' +
        offenders.join('\n'),
    ).toEqual([]);
  });

  it('the icon button keeps a transparent ground in every state', () => {
    const css = readFileSync(CSS, 'utf8').replace(/\/\*[\s\S]*?\*\//g, ' ');
    // The base rule must still say so — the reported bug looked like the
    // component had asked for a fill, and it never had.
    expect(css).toMatch(/\.icon-btn\s*\{[^}]*background:\s*transparent/);
    // And the fill it does take must be behind a hover query, so a tap on a
    // phone cannot leave it stuck.
    const hover = css.match(/@media \(hover: hover\) \{[^}]*\.icon-btn:hover[^}]*\}/);
    expect(hover, '.icon-btn:hover must sit inside @media (hover: hover)').not.toBeNull();
  });
});
