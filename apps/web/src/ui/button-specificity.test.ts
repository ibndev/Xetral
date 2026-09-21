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

  it('EVERY .xselect-trigger state RESTATES its own background, unguarded', () => {
    /*
     * THE SAME COLLISION, ONE COMPONENT OVER, AND IT REACHED A CUSTOMER.
     *
     * `.xselect-trigger` is a <button>, so `button:hover:where(:not(:disabled))`
     * paints it `--brand-700` — which is #FFFFFF in the dark theme. The
     * neutralising rule existed but sat inside `@media (hover: hover)`, so on
     * a touch device reporting `hover: none` it did not exist at all while the
     * generic rule still applied through the sticky `:hover` a tap leaves
     * behind. Tapping the network picker on Add Money turned it into a SOLID
     * WHITE PILL with its label barely legible on top.
     *
     * A guard on the FIX and none on the FAULT is worse than no guard: it
     * removes the correction on exactly the devices that need it. So at least
     * one unguarded state rule must restate the field background.
     */
    const css = readFileSync(CSS, 'utf8').replace(/\/\*[\s\S]*?\*\//g, ' ');

    // Everything inside a hover query is exactly what cannot be relied on.
    const unguarded = css.replace(/@media \(hover: hover\) \{[\s\S]*?\n\}/g, ' ');

    const states = Array.from(
      unguarded.matchAll(/\.xselect-trigger(:[a-z-]+(?:\([^)]*\))?)+[^{]*\{([^}]*)\}/g),
      (m) => ({ selector: m[0].slice(0, m[0].indexOf('{')).trim(), body: m[2] ?? '' }),
    );
    const restates = states.filter((r) => /background:\s*var\(--field\)/.test(r.body));

    expect(
      restates.length,
      'no unguarded .xselect-trigger state rule sets `background: var(--field)`, so ' +
        '`button:hover` paints the picker --brand-700 (white in dark) on a touch device',
    ).toBeGreaterThan(0);
  });
  it('a <button> used as a CARD neutralises every layout property the bare rule sets', () => {
    /*
     * THE THIRD TIME THE BARE `button` RULE HAS REACHED SOMETHING THAT IS NOT
     * A BUTTON, AND THE FIRST TIME SPECIFICITY WAS NOT THE MECHANISM.
     *
     * `.icon-btn` and `.xselect-trigger` above are both about a generic rule
     * OUTRANKING a component class. This one is the opposite and is easier to
     * miss: `.ccy-card` outranks `.btn, button` comfortably, and lost anyway —
     * because it never mentioned `display`, and a class cannot win a property
     * it does not declare. The bare rule sets `display: inline-flex`,
     * `align-items: center`, `justify-content: center`, `gap: 8px`,
     * `min-height: 48px` and `white-space: nowrap`, so a three-row currency
     * card rendered as one centred flex row with its neighbours overlapping.
     *
     * Nothing failed. The compiler has no opinion about a stylesheet, the
     * markup was correct, and the class was applied. It was visible only in a
     * rendered screenshot — which is why the rule is now written down instead
     * of relearned on the next card-shaped button.
     */
    const css = readFileSync(CSS, 'utf8').replace(/\/\*[\s\S]*?\*\//g, ' ');

    /** What `.btn, button` sets that changes how a card's CHILDREN lay out. */
    const LEAKS = [
      'display',
      'align-items',
      'justify-content',
      'gap',
      'min-height',
      'white-space',
    ] as const;

    /**
     * Component classes rendered on a <button> that are NOT button-shaped.
     *
     * Listed by hand deliberately: the test cannot tell from the stylesheet
     * which classes end up on a <button>, and a guess in either direction is
     * worse than a decision. A new card-shaped button is added here, which is
     * the moment somebody reads this comment.
     *
     * `.chip` is the one that proved the rule is not only about cards: a
     * filter chip omitted `min-height`, so the rail of a screen's filters was
     * 48px tall where the comp draws 33px — taller than two rows of the list
     * it filters, and correct-looking in every other respect.
     */
    const CARDS = ['.ccy-card', '.chip', '.tx-row', '.card-act', '.sf-key'] as const;

    for (const cls of CARDS) {
      const at = css.search(new RegExp(`\\${cls}\\s*\\{`));
      expect(at, `${cls} has no base rule in globals.css`).toBeGreaterThan(-1);
      const body = css.slice(at, css.indexOf('}', at));
      const missing = LEAKS.filter((prop) => !new RegExp(`(^|;|\\{)\\s*${prop}\\s*:`).test(body));
      expect(
        missing,
        `${cls} is a <button>, so \`.btn, button\` sets these and ${cls} never ` +
          'restates them — the bare rule wins on every one:\n' + missing.join('\n'),
      ).toEqual([]);
    }
  });
});
