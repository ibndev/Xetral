'use client';

import { useEffect, useState } from 'react';
import { hasUnread, newestAt } from '@xetral/client';
import type { Announcement } from '@xetral/client';
import { xetral } from '@/lib/session';

/**
 * WHEN THIS BROWSER LAST SHOWED THE FEED — a timestamp, nothing else, and
 * nothing a server needs. Every read and write is guarded: private windows
 * and blocked site data throw on the accessor itself, and a bell that throws
 * is worse than a dot that shows once too often.
 */
const KEY = 'xetral:announcements-seen';
const CHANGED = 'xetral:announcements-seen-changed';

function readSeen(): string | null {
  try {
    return window.localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

/** Called by the feed once it has drawn: everything up to the newest is read. */
export function markAnnouncementsSeen(items: readonly Announcement[]): void {
  const newest = newestAt(items);
  if (newest === undefined) return;
  try {
    window.localStorage.setItem(KEY, newest);
  } catch {
    // Nothing to do: the dot will simply show again next time.
  }
  window.dispatchEvent(new Event(CHANGED));
}

/**
 * Whether the bell has something new. Asked once per page, and quiet on any
 * failure: an unreadable feed is not a reason to light a dot.
 */
export function useUnreadAnnouncements(enabled: boolean): boolean {
  const [items, setItems] = useState<readonly Announcement[]>([]);
  const [seen, setSeen] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) return undefined;
    let live = true;
    setSeen(readSeen());
    xetral()
      .client.announcements()
      .then((feed) => live && setItems(feed.announcements))
      .catch(() => undefined);
    const again = (): void => setSeen(readSeen());
    window.addEventListener(CHANGED, again);
    window.addEventListener('storage', again);
    return () => {
      live = false;
      window.removeEventListener(CHANGED, again);
      window.removeEventListener('storage', again);
    };
  }, [enabled]);

  return hasUnread(items, seen);
}
