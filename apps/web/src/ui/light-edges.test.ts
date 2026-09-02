import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * NO CONTAINER OR FIELD DRAWS A VISIBLE OUTLINE IN THE LIGHT THEME.
 *
 * WHAT THIS IS ABOUT. In light, a container is already a shade DARKER than the
 * ground, and darker-than-its-surroundings is what the eye reads as a recess —
 * the cue an input has always used. The hairline drawn on top of it was a
 * second cue for the same fact, and two cues read as an OUTLINE: a screen of
 * stacked cards looked like boxes ruled onto a page rather than wells cut into
 * it, and a text field at rest was an empty rectangle waiting for input it had
 * not been given.
 *
 * Dark cannot do that. On black there is no darker fill to recess into, so a
 * container lifts by a few points of lightness and the line is what finishes
 * the edge. Hence `--edge`: transparent in light, `--line` in dark, so ONE set
 * of component rules serves both and neither theme is expressed twice.
 *
 * WHY A TEST. The failure is invisible in review and invisible in dark: a new
 * card written with `border: 1px solid var(--line)` looks exactly right on the
 * theme most people build in, and puts one outlined box among a screen of
 * recessed ones on the other. Nothing in a stylesheet fails.
 *
 * DIVIDERS ARE NOT OUTLINES and are deliberately untouched. A table's rules, a
 * section head's underline, an `hr` — those separate things that would
 * otherwise run together, in either theme, and `--line` is still theirs. This
 * checks the `border:` SHORTHAND, which is what draws a box.
 */

const CSS = readFileSync(
  join(new URL('.', import.meta.url).pathname, '..', 'app', 'globals.css'),
  'utf8',
);

/**
 * The one place a full box border may still name `--line-strong`: a dropdown
 * FLOATS above the page, painted lighter than the ground rather than darker,
 * so it has no recess cue to lean on and its edge is what separates it from
 * what it covers.
 */
const FLOATS = ['.xselect-list'];

/** Rule blocks, as `{ selector, body }`, with comments stripped first. */
function rules(): readonly { selector: string; body: string }[] {
  const source = CSS.replace(/\/\*[\s\S]*?\*\//g, ' ');
  return Array.from(source.matchAll(/([^{}]+)\{([^{}]*)\}/g), (m) => ({
    selector: (m[1] ?? '').trim().replace(/\s+/g, ' '),
    body: m[2] ?? '',
  }));
}

describe('the light theme draws no outlines', () => {
  it('defines --edge, --edge-strong and --edge-hover as TRANSPARENT in light', () => {
    // The bare `:root` block, which is the light palette. This app always
    // stamps `data-theme`, so there is no third media-keyed state to cover.
    const light = CSS.slice(CSS.indexOf(':root'), CSS.indexOf("[data-theme='dark']"));
    for (const token of ['--edge', '--edge-strong', '--edge-hover']) {
      expect(new RegExp(`${token}:\\s*transparent;`).test(light), `${token} in light`).toBe(true);
    }
  });

  it('gives dark a real border, so the edge does not vanish where the fill cannot separate', () => {
    const dark = CSS.slice(CSS.indexOf("[data-theme='dark']"));
    expect(/--edge:\s*var\(--line\);/.test(dark)).toBe(true);
    expect(/--edge-strong:\s*var\(--line-strong\);/.test(dark)).toBe(true);
    // NOT transparent. A dark container that lost its border would be a shade
    // of near-black on black with nothing marking where it ends.
    expect(/--edge(-strong)?:\s*transparent/.test(dark)).toBe(false);
  });

  it('has no rule drawing a full box border from --line', () => {
    const offenders = rules()
      .filter((r) => /border:\s*1px\s+solid\s+var\(--line/.test(r.body))
      .filter((r) => !FLOATS.some((f) => r.selector.includes(f)))
      .map((r) => r.selector);

    expect(
      offenders,
      'these draw an outline that is invisible in dark and wrong in light — ' +
        `use var(--edge) or var(--edge-strong):\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('has no HOVER that brings a field border back', () => {
    /*
     * HOVER IS NOT FOCUS, and this is the half that is easy to miss. A field
     * borderless at rest whose border appears under the pointer is the outline
     * coming back on the one screen somebody is actually reading — and it is a
     * separate rule from the one the previous check covers, so removing the
     * resting border alone does not fix it.
     */
    const offenders = rules()
      .filter((r) => /:hover/.test(r.selector))
      .filter((r) => /border-color:\s*var\(--(line|line-strong|text-3)\)/.test(r.body))
      // A ghost button is an OUTLINED button: the border is its entire visible
      // form, in both themes, and there is no fill underneath to carry it.
      .filter((r) => !/\.ghost/.test(r.selector))
      .map((r) => r.selector);

    expect(
      offenders,
      `these paint a border on hover, which light must not:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });
});
