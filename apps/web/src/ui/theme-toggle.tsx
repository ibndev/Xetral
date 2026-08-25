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
