'use client';

import { useEffect, useState } from 'react';
import { Icon } from './icon';

const KEY = 'xetral-theme';

/**
 * Light and dark, remembered.
 *
 * The initial value is read by an inline script in the root layout, before
 * first paint — this component only has to stay in step with it, which is why
 * it reads `dataset.theme` on mount rather than deciding for itself. Two
 * places deciding independently is how the toggle ends up showing a sun on a
 * dark page.
 */
export function ThemeToggle() {
  const [theme, setTheme] = useState<'light' | 'dark'>('light');

  useEffect(() => {
    setTheme(document.documentElement.dataset['theme'] === 'dark' ? 'dark' : 'light');
  }, []);

  function toggle() {
    const next = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    document.documentElement.dataset['theme'] = next;
    /*
     * THE BROWSER CHROME MOVES WITH THE PAGE.
     *
     * `theme-color` decides what the phone paints behind the status bar and
     * the gesture bar. It used to be two media-keyed values reading
     * `prefers-color-scheme` — the OS preference — while the page follows
     * `data-theme`, which is this button. So a customer on a light-OS phone
     * who switched to dark got a black page framed by two white bars, which
     * is not a subtle mismatch: it is most of what the screen shows.
     *
     * Set here as well as in the pre-paint bootstrap, because those are the
     * only two places the theme ever changes.
     */
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute('content', next === 'dark' ? '#000000' : '#FFFFFF');
    try {
      localStorage.setItem(KEY, next);
    } catch {
      // A private window refuses storage. The toggle still works for this
      // session; it simply will not be remembered, which is better than
      // throwing on a page that shows a balance.
    }
  }

  return (
    <button
      type="button"
      className="icon-btn"
      onClick={toggle}
      aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
    >
      <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={20} />
    </button>
  );
}
