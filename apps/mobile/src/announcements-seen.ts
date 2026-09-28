import { useEffect, useState } from 'react';
import { AppState } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import { hasUnread, newestAt } from '@xetral/client';
import type { Announcement } from '@xetral/client';
import { xetral } from '@/session';

/**
 * WHEN THIS PHONE LAST SHOWED THE FEED — the web's `announcements-seen`, on
 * the handset. A timestamp and nothing else; SecureStore because it is the
 * store this app already has, not because the value is secret. Every access
 * is guarded: a bell that throws is worse than a dot shown once too often.
 */
const KEY = 'xetral.announcements.seen';
const listeners = new Set<() => void>();

async function readSeen(): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(KEY);
  } catch {
    return null;
  }
}

/** Called by the feed once it has drawn: everything up to the newest is read. */
export async function markAnnouncementsSeen(items: readonly Announcement[]): Promise<void> {
  const newest = newestAt(items);
  if (newest === undefined) return;
  try {
    await SecureStore.setItemAsync(KEY, newest);
  } catch {
    // The dot will simply show again next time.
  }
  for (const listener of listeners) listener();
}

/**
 * Whether the bell has something new. Asked when the home header mounts and
 * again whenever the app comes back to the foreground — which is when an
 * announcement published while it was closed should light the bell.
 */
export function useUnreadAnnouncements(enabled: boolean): boolean {
  const [unread, setUnread] = useState(false);

  useEffect(() => {
    if (!enabled) return undefined;
    let live = true;
    const check = async (): Promise<void> => {
      try {
        const [feed, seen] = await Promise.all([xetral().client.announcements(), readSeen()]);
        if (live) setUnread(hasUnread(feed.announcements, seen));
      } catch {
        // An unreadable feed is not a reason to light a dot.
      }
    };
    void check();
    const again = (): void => void check();
    listeners.add(again);
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') void check();
    });
    return () => {
      live = false;
      listeners.delete(again);
      subscription.remove();
    };
  }, [enabled]);

  return unread;
}
