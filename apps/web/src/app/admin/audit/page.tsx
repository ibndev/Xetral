'use client';

import { useAdmin, useLoad } from '@/lib/hooks';

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

  return (
    <div className="panel">
      <h1>Audit</h1>
      <h2>The hundred most recent operator actions</h2>

      {entries.error !== undefined && <p className="error">{entries.error}</p>}
      {entries.loading && <p className="spinner">Loading…</p>}
      {entries.data !== undefined && entries.data.length === 0 && (
        <p className="empty">Nothing recorded yet.</p>
      )}

      {entries.data !== undefined && entries.data.length > 0 && (
        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Who</th>
                <th>Did what</th>
                <th>To</th>
                <th>Why</th>
                <th>From</th>
              </tr>
            </thead>
            <tbody>
              {entries.data.map((entry) => (
                <tr key={entry.id}>
                  <td className="nowrap muted">
                    {new Date(entry.created_at).toLocaleString()}
                  </td>
                  <td>{entry.actor ?? 'system'}</td>
                  <td>
                    <span className="badge">{entry.action}</span>
                  </td>
                  <td className="mono">
                    {entry.subject_type === null
                      ? '—'
                      : `${entry.subject_type} ${String(entry.subject_id).slice(0, 12)}`}
                  </td>
                  <td>{entry.reason ?? <span className="muted">—</span>}</td>
                  <td className="mono muted nowrap">{entry.ip_address ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
