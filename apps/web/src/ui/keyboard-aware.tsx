'use client';

import { useEffect } from 'react';

/**
 * THE KEYBOARD COVERED THE FIELD SOMEBODY WAS TYPING IN.
 *
 * Reported on both platforms, and on the web it has two causes that look like
 * one on screen.
 *
 * FIRST, THE TAB BAR. `.tabbar` is `position: fixed; bottom: 0`, and a fixed
 * element is positioned against the LAYOUT viewport, which an on-screen
 * keyboard does not change. So the bar stays where the bottom of the screen
 * used to be — which, with the keyboard up, is somewhere in the middle of the
 * page, directly over whatever is being typed into. That is not a scrolling
 * problem and no amount of scrolling fixes it.
 *
 * SECOND, THE BROWSER'S OWN SCROLL-INTO-VIEW IS NOT ENOUGH. It brings the
 * field to the edge of the visible area at best, so a field near the bottom
 * ends up flush against the top of the keyboard with its label, its hint and
 * any error out of sight — and on a form where the next thing to read is the
 * refusal under the box, that is the same complaint again.
 *
 * SO: the visual viewport says how tall the visible area actually is, the
 * document is stamped with `data-keyboard="open"` when that is much shorter
 * than the window, and CSS hides the bar and reclaims its padding. Then the
 * focused field is scrolled to the MIDDLE of what is left, which leaves room
 * for the label above and the message below.
 *
 * MOUNTED ONCE, IN THE ROOT LAYOUT, so it cannot be forgotten on a screen —
 * the argument the mobile app's `Shell` makes for putting its entrance
 * animation there rather than on each page. It renders nothing.
 *
 * `visualViewport` IS NOT UNIVERSAL and its absence is the desktop case,
 * where there is no software keyboard and nothing to do. Every listener is
 * guarded rather than assumed.
 */
export function KeyboardAware() {
  useEffect(() => {
    const root = document.documentElement;

    /**
     * How much shorter the visible area is than the window.
     *
     * A THRESHOLD, not "any difference at all": a browser's own URL bar
     * collapsing and expanding moves this by tens of pixels on every scroll,
     * and treating that as a keyboard would hide the navigation while
     * somebody was reading. A keyboard is a fifth of the screen at the very
     * least.
     */
    function update(): void {
      const viewport = window.visualViewport;
      if (viewport === undefined || viewport === null) return;
      const hidden = window.innerHeight - viewport.height;
      const open = hidden > window.innerHeight * 0.2;
      if (open) root.dataset['keyboard'] = 'open';
      else delete root.dataset['keyboard'];
    }

    /**
     * The focused field, into the middle of what is visible.
     *
     * Deferred, and that is load-bearing: the keyboard animates in over about
     * a quarter of a second, so a scroll computed at the moment of focus is
     * computed against a viewport that is still full height and lands in the
     * wrong place. The delay is longer than the animation on both platforms.
     *
     * `block: 'center'` rather than `'nearest'`, for the reason above: nearest
     * leaves the field flush against the keyboard with its hint and its error
     * message underneath and out of sight.
     */
    function onFocusIn(event: FocusEvent): void {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      if (!target.matches('input, textarea, [contenteditable="true"]')) return;
      // Not a checkbox or a radio: nothing about them is typed, so there is no
      // keyboard, and scrolling the page under somebody's thumb as they tick a
      // box is a jump they did not ask for.
      if (target instanceof HTMLInputElement && ['checkbox', 'radio'].includes(target.type)) return;

      window.setTimeout(() => {
        // Still focused? A customer who tapped away in the meantime must not
        // have the page scrolled out from under them.
        if (document.activeElement !== target) return;
        target.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }, 300);
    }

    document.addEventListener('focusin', onFocusIn);
    window.visualViewport?.addEventListener('resize', update);
    window.visualViewport?.addEventListener('scroll', update);
    update();

    return () => {
      document.removeEventListener('focusin', onFocusIn);
      window.visualViewport?.removeEventListener('resize', update);
      window.visualViewport?.removeEventListener('scroll', update);
      delete root.dataset['keyboard'];
    };
  }, []);

  return null;
}
