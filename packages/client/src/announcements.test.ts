import { describe, expect, it } from 'vitest';
import { hasUnread, newestAt } from './announcements.js';

const item = (at: string) => ({ uuid: at, title: 't', body: 'b', at });

describe('the bell dot', () => {
  it('SAYS NOTHING with no announcements', () => {
    expect(hasUnread([], null)).toBe(false);
  });

  it('LIGHTS for anything when nothing was ever seen', () => {
    expect(hasUnread([item('2026-09-28T10:00:00.000Z')], null)).toBe(true);
  });

  it('LIGHTS only for something NEWER than what was seen', () => {
    const items = [item('2026-09-28T10:00:00.000Z'), item('2026-09-27T10:00:00.000Z')];
    expect(hasUnread(items, '2026-09-28T10:00:00.000Z')).toBe(false);
    expect(hasUnread(items, '2026-09-27T12:00:00.000Z')).toBe(true);
  });

  it('READS A MALFORMED stored value as never seen', () => {
    expect(hasUnread([item('2026-09-28T10:00:00.000Z')], 'yesterday')).toBe(true);
  });

  it('PICKS THE NEWEST by instant, not by position', () => {
    expect(newestAt([item('2026-09-27T10:00:00.000Z'), item('2026-09-28T09:00:00.000Z')])).toBe(
      '2026-09-28T09:00:00.000Z',
    );
  });
});
