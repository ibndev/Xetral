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

/**
 * Split a selector list on its TOP-LEVEL commas only.
 *
 * `group.split(',')` was wrong and reported a false positive the first time a
 * selector carried a comma inside brackets: `:where(:not([type='checkbox'],
 * [type='radio']))` came back as the fragment `input:where(:not([type='checkbox']`,
 * which has an unbalanced `:where(` — so the `:where()` filter below could not
 * see it and the rule was reported as taking specificity it does not take. A
 * test that fails on correct CSS gets suppressed, so the parser has to be
 * right about the syntax it is judging.
 */
function splitSelectorList(group: string): readonly string[] {
  const out: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of group) {
    if (ch === '(' || ch === '[') depth += 1;
    else if (ch === ')' || ch === ']') depth -= 1;
    if (ch === ',' && depth === 0) {
      out.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  out.push(current);
  return out;
}

/** Selectors, with comments and declaration blocks removed. */
function selectors(): readonly string[] {
  const css = readFileSync(CSS, 'utf8').replace(/\/\*[\s\S]*?\*\//g, ' ');
  return Array.from(css.matchAll(/(^|[};])\s*([^{};@]+)\{/g), (m) => (m[2] ?? '').trim())
    .flatMap((group) => splitSelectorList(group))
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

  it('EVERY .icon-btn state NEUTRALISES the background rather than omitting it', () => {
    /*
     * OMITTING A PROPERTY IS NOT THE SAME AS NEUTRALISING ONE, and that
     * distinction cost a round here.
     *
     * The first attempt at "no disc behind the icon" deleted `background`
     * from `.icon-btn:hover` and changed only the colour. That does not
     * override a background the rule never mentions — so
     * `button:hover:where(:not(:disabled))` applied instead and painted
     * `--brand-700` on a 44px circle. Measured in a browser as
     * `rgb(22, 41, 90)` behind the moon, with the icon in near-black on top:
     * a worse version of exactly the fault being fixed.
     *
     * It is invisible in review because the diff REMOVES a background. Every
     * state rule must therefore say `transparent` out loud.
     */
    const css = readFileSync(CSS, 'utf8').replace(/\/\*[\s\S]*?\*\//g, ' ');

    const stateRules = Array.from(
      css.matchAll(/\.icon-btn(:[a-z-]+(?:\([^)]*\))?)+\s*\{([^}]*)\}/g),
      (m) => ({ selector: m[0].slice(0, m[0].indexOf('{')).trim(), body: m[2] ?? '' }),
    );
    expect(stateRules.length).toBeGreaterThan(0);

    const bare = stateRules.filter((r) => !/background:\s*transparent/.test(r.body));
    expect(
      bare.map((r) => r.selector),
      'these .icon-btn state rules do not state a background, so the generic ' +
        '`button:hover` fill applies and a solid disc appears behind the icon:\n' +
        bare.map((r) => r.selector).join('\n'),
    ).toEqual([]);
  });
});
