'use client';

import { Shell } from '@/ui/shell';
import { Icon } from '@/ui/icon';
import { useEffect } from 'react';
import { useLoad, useXetral } from '@/lib/hooks';
import { markAnnouncementsSeen } from '@/lib/announcements-seen';

/**
 * WHAT THE BELL OPENS: the announcements the platform has published.
 *
 * It opened the account screen, so a customer tapping the one control that
 * says "something to read" found their own settings — and an announcement
 * pushed to handsets was readable nowhere else, so anybody on the web, or who
 * had declined product news, never saw "the app is down tonight" at all.
 *
 * The same rows `/admin/broadcasts` writes and the worker pushes, read on
 * request. Opening it is what "read" means: the bell's red dot is cleared up
 * to the newest announcement drawn here. Still no count — a badge reading a
 * number nothing counted is the fault the bell's comment records.
 */
export default function Notifications() {
  const client = useXetral();
  const feed = useLoad(() => client.announcements(), [client]);
  const items = feed.data?.announcements ?? [];
  useEffect(() => {
    if (feed.data !== undefined) markAnnouncementsSeen(feed.data.announcements);
  }, [feed.data]);

  return (
    <Shell back="/wallet" title="Notifications">
      {feed.loading && <p className="spinner">Loading…</p>}
      {feed.error !== undefined && (
        <p className="error"><Icon name="alert" size={16} /> {feed.error}</p>
      )}

      {!feed.loading && feed.error === undefined && items.length === 0 && (
        <div className="empty">
          <span className="empty-icon"><Icon name="bell" size={24} /></span>
          <span>No announcements yet</span>
        </div>
      )}

      {items.length > 0 && (
        <ul className="announce-list card">
          {items.map((item) => (
            <li className="announce" key={item.uuid}>
              <span className="announce-icon" aria-hidden="true"><Icon name="bell" size={18} /></span>
              <span className="announce-main">
                <span className="announce-head">
                  <span className="announce-title">{item.title}</span>
                  <time className="announce-time" dateTime={item.at}>{whenOf(item.at)}</time>
                </span>
                <span className="announce-body">{item.body}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </Shell>
  );
}

/** "14:05" today, "3 Sep" this year, "3 Sep 2025" before — the activity list's rhythm. */
function whenOf(iso: string): string {
  const at = new Date(iso);
  const now = new Date();
  if (at.toDateString() === now.toDateString()) {
    return at.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  }
  return at.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    ...(at.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
  });
}
