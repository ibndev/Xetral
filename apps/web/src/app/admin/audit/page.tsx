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
 */
export default function Audit() {
  const admin = useAdmin();
  const entries = useLoad(() => admin.audit({ limit: 100 }), [admin]);
  const [query, setQuery] = useState('');

  const needle = query.trim().toLowerCase();
  const shown = (entries.data ?? []).filter(
    (entry) =>
      needle === '' ||
      [entry.actor ?? 'system', entry.action, targetOf(entry), entry.reason ?? '']
        .join(' ')
        .toLowerCase()
        .includes(needle),
  );

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
            placeholder="Search the latest 100 by actor, action or target"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search the latest 100 audit entries"
          />
        </label>
      </div>

      <AdminError error={entries.error} code={entries.code} role="admin" />
      {entries.loading && <p className="spinner">Loading…</p>}
      {entries.data !== undefined && entries.data.length === 0 && (
        <p className="empty">Nothing recorded yet.</p>
      )}
      {entries.data !== undefined && entries.data.length > 0 && shown.length === 0 && (
        <p className="empty">Nothing in the latest 100 matches that.</p>
      )}

      {shown.length > 0 && (
        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th>Time</th>
                <th>Actor</th>
                <th>Action</th>
                <th>Target</th>
                <th>IP</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((entry) => (
                <tr key={entry.id}>
                  <td className="mono quiet nowrap" title={new Date(entry.created_at).toLocaleString()}>
                    {timeOf(entry.created_at)}
                  </td>
                  <td className="actor" title={entry.actor ?? 'system'}>
                    {actorOf(entry.actor)}
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
    </div>
  );
}

/** "03:31:04" today, "Yesterday", then a date — the comp's column. */
function timeOf(iso: string): string {
  const then = new Date(iso);
  const now = new Date();
  const day = (d: Date): string => d.toDateString();
  if (day(then) === day(now)) return then.toLocaleTimeString('en-GB', { hour12: false });
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (day(then) === day(yesterday)) return 'Yesterday';
  return shortDate(iso);
}

/** "tunde@" — who, at a glance; the whole address is one hover away. */
function actorOf(actor: string | null): string {
  if (actor === null) return 'system';
  const at = actor.indexOf('@');
  return at > 0 ? actor.slice(0, at + 1) : actor;
}

function targetOf(entry: AdminAuditEntry): string {
  if (entry.subject_type === null) return '—';
  return `${entry.subject_type.replace(/_/g, ' ')} ${String(entry.subject_id ?? '').slice(0, 12)}`.trim();
}
