'use client';

import { useState } from 'react';
import type { AdminAuditEntry } from '@xetral/client';
import { useAdmin, useLoad } from '@/lib/hooks';
import { Icon } from '@/ui/icon';
import { AdminError } from '../access';
import { AdminTitle } from '@/app/admin/nav';
import { shortDate } from '../age';

/**
 * What operators have done.
 *
 * Append-only, enforced by a trigger that refuses UPDATE and DELETE. A log a
 * privileged user can edit tells you what the last person with access wanted
 * you to believe, which is worse than no log at all — because a log that
 * cannot be edited is read as evidence, and one that can is read the same way.
 *
 * Destructive actions carry a required reason, by CHECK. There is no path that
 * freezes an account or moves suspense money without a sentence attached.
 *
 * THERE IS NO DELETE, and that is the log working rather than a missing
 * button. Only `admin` can open this page; if `admin` could also clear it,
 * the one role able to do the most damage would be the one role able to
 * remove the record of having done it.
 *
 * WHO IS A NAME AND AN ADDRESS, both in full. The column used to show "tunde@"
 * with the rest on hover, which reads well until two operators share a first
 * name — and "which Tunde?" is the question an audit exists to answer.
 */
export default function Audit() {
  const admin = useAdmin();
  const entries = useLoad(() => admin.audit({ limit: PAGE }), [admin]);
  const [older, setOlder] = useState<readonly AdminAuditEntry[]>([]);
  const [more, setMore] = useState<'idle' | 'loading' | 'end' | 'failed'>('idle');
  const [query, setQuery] = useState('');

  const loaded = [...(entries.data ?? []), ...older];
  const needle = query.trim().toLowerCase();
  const shown = loaded.filter(
    (entry) =>
      needle === '' ||
      [entry.actor_name ?? '', entry.actor ?? 'system', entry.action, targetOf(entry), entry.reason ?? '']
        .join(' ')
        .toLowerCase()
        .includes(needle),
  );

  const loadOlder = async (): Promise<void> => {
    const last = loaded[loaded.length - 1];
    if (last === undefined) return;
    setMore('loading');
    try {
      const page = await admin.audit({ limit: PAGE, before: last.id });
      setOlder((current) => [...current, ...page]);
      setMore(page.length < PAGE ? 'end' : 'idle');
    } catch {
      setMore('failed');
    }
  };
  const hasMore =
    entries.data !== undefined && entries.data.length === PAGE && more !== 'end';

  return (
    <div className="panel tbl-panel audit">
      <AdminTitle>Audit</AdminTitle>
      {/*
        THE SEARCH IS OVER THE ROWS ON SCREEN, and the placeholder says so. A
        box that read as a search of the whole log would let an operator
        conclude an action was never taken because it fell outside the hundred
        loaded — the one wrong conclusion an audit screen must not invite.
      */}
      <div className="search-row">
        <label className="search-field">
          <Icon name="search" size={17} />
          <input
            type="search"
            placeholder={`Search the ${loaded.length} loaded by name, email, action or target`}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search the loaded audit entries"
          />
        </label>
      </div>

      <AdminError error={entries.error} code={entries.code} role="admin" />
      {entries.loading && <p className="spinner">Loading…</p>}
      {entries.data !== undefined && entries.data.length === 0 && (
        <p className="empty">Nothing recorded yet.</p>
      )}
      {entries.data !== undefined && entries.data.length > 0 && shown.length === 0 && (
        <p className="empty">
          Nothing loaded matches that.{hasMore ? ' Load older entries to search further back.' : ''}
        </p>
      )}

      {shown.length > 0 && (
        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Staff member</th>
                <th>Action</th>
                <th>Target</th>
                <th>IP</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((entry) => (
                <tr key={entry.id}>
                  <td className="mono quiet nowrap">
                    {dateOf(entry.created_at)}
                    <div className="cell-sub">{timeOf(entry.created_at)}</div>
                  </td>
                  <td className="actor">
                    <span className="actor-name">{entry.actor_name ?? entry.actor ?? 'System'}</span>
                    {entry.actor !== null && entry.actor_name !== null && (
                      <div className="cell-sub">{entry.actor}</div>
                    )}
                  </td>
                  <td>
                    <span className="mono">{entry.action}</span>
                    {/* The reason is the part a regulator reads, so it stays —
                        under the action rather than as a sixth column. */}
                    {entry.reason !== null && <div className="cell-sub">{entry.reason}</div>}
                  </td>
                  <td className="soft">{targetOf(entry)}</td>
                  <td className="mono quiet nowrap">{entry.ip_address ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {(hasMore || more === 'failed') && (
        <div className="audit-more">
          <button type="button" className="quiet" onClick={() => void loadOlder()} disabled={more === 'loading'}>
            {more === 'loading' ? 'Loading…' : 'Load older entries'}
          </button>
          {more === 'failed' && <span className="quiet">Could not load more. Try again.</span>}
        </div>
      )}
    </div>
  );
}

const PAGE = 100;

/**
 * "Today", "Yesterday", then the date — with the year once it is not this
 * one, because a log read in January is otherwise ambiguous about December.
 */
function dateOf(iso: string): string {
  const then = new Date(iso);
  const now = new Date();
  const day = (d: Date): string => d.toDateString();
  if (day(then) === day(now)) return 'Today';
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (day(then) === day(yesterday)) return 'Yesterday';
  return then.getFullYear() === now.getFullYear()
    ? shortDate(iso)
    : then.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

/** "03:31:04", always — the date is the line above it. */
function timeOf(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-GB', { hour12: false });
}

function targetOf(entry: AdminAuditEntry): string {
  if (entry.subject_type === null) return '—';
  return `${entry.subject_type.replace(/_/g, ' ')} ${String(entry.subject_id ?? '').slice(0, 12)}`.trim();
}
