import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * THE KEYBOARD MUST NOT COVER THE FIELD BEING TYPED IN.
 *
 * On the web this had two causes and they look identical on screen, so a fix
 * for one reads as a fix for both. This file asserts that both halves are
 * still there, because neither is visible in a diff and neither has any effect
 * a unit test can observe — one is a fixed element's `display`, the other a
 * scroll position on a device with a software keyboard.
 *
 * THE FIXED TAB BAR IS THE HALF PEOPLE MISS. `.tabbar` is positioned against
 * the LAYOUT viewport, which an on-screen keyboard does not change, so it
 * stays where the bottom of the screen used to be — which with the keyboard up
 * is over the middle of the page. No amount of scrolling moves it.
 */

const UI = new URL('.', import.meta.url).pathname;
const APP = join(UI, '..', 'app');

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

describe('the keyboard and the field under it', () => {
  it('is handled in the root layout, so no screen can be without it', () => {
    // The argument the theme bootstrap makes, applied to this: a fix a page
    // has to remember is a fix some page will not have.
    const layout = read(join(APP, 'layout.tsx'));
    expect(layout.includes('<KeyboardAware />'), 'KeyboardAware is not mounted').toBe(true);
  });

  it('stamps the document from the VISUAL viewport, not from a focus event', () => {
    // The visual viewport is the only thing that knows how tall the visible
    // area actually is. A focus event says a field was focused and nothing
    // about whether anything is covering it — a hardware keyboard, a
    // desktop browser and a Bluetooth keyboard all fire one.
    const source = read(join(UI, 'keyboard-aware.tsx'));
    expect(source.includes('visualViewport')).toBe(true);
    expect(source.includes("dataset['keyboard']")).toBe(true);
  });

  it('the fixed tab bar is hidden while the keyboard is up', () => {
    const css = read(join(APP, 'globals.css'));
    expect(
      /:root\[data-keyboard='open'\][^{]*\.tabbar\s*\{[^}]*display:\s*none/.test(css),
      'the tab bar is fixed to the layout viewport, so with the keyboard up it sits over ' +
        'the middle of the page — directly on the field being typed into',
    ).toBe(true);
  });

  it('the focused field is centred, not merely brought into view', () => {
    // `nearest` leaves a field flush against the top of the keyboard with its
    // hint and its error message underneath and out of sight — which is the
    // same complaint again on a form whose next useful line is the refusal
    // under the box.
    const source = read(join(UI, 'keyboard-aware.tsx'));
    expect(source.includes("block: 'center'")).toBe(true);
  });
});
