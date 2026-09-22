'use client';

import { useAdmin, useLoad } from '@/lib/hooks';
import { AdminError } from '../access';
import { AdminTitle } from '@/app/admin/nav';
import { shortDate } from '../age';
import { Kpis } from '../queue';

/**
 * Who has not agreed to the words currently in force.
 *
 * EMPTY IS THE RESTING STATE. This page exists for the day a notice is
 * republished, because that is when it stops being empty — and a change nobody
 * was asked about is a change nobody agreed to. Without a screen the only
 * evidence would be an absence, which is the kind of thing nobody thinks to
 * query.
 *
 * The mailing list is deliberately absent: not having opted in is a correct
 * resting state and not an outstanding task. Listing it would turn "declined"
 * into a queue somebody works through.
 */
export default function Consents() {
  const admin = useAdmin();
  const report = useLoad(() => admin.consents(), [admin]);
  const figures = report.data?.figures;

  return (
    <>
      <AdminTitle>Consent</AdminTitle>
      <Kpis
        items={[
          {
            label: 'Marketing opt-in',
            value:
              figures === undefined
                ? undefined
                : figures.marketing_opt_in_percent === null
                  ? '—'
                  : `${figures.marketing_opt_in_percent}%`,
          },
          { label: 'Withdrawn · 30d', count: figures?.withdrawn_30d, tone: 'warn' },
          { label: 'Not on current terms', count: figures?.outstanding, tone: 'warn' },
        ]}
      />

      <div className="panel tbl-panel">
        <AdminError error={report.error} code={report.code} role="compliance" />
        {report.loading && <p className="spinner">Loading…</p>}
        {report.data !== undefined && report.data.recent.length === 0 && (
          <p className="empty">Nobody has recorded a decision yet.</p>
        )}
        {report.data !== undefined && report.data.recent.length > 0 && (
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>Customer</th>
                  <th>Scope</th>
                  <th>State</th>
                  <th>Updated</th>
                </tr>
              </thead>
              <tbody>
                {report.data.recent.map((row) => (
                  <tr key={row.id}>
                    <td>{row.name ?? row.email ?? '—'}</td>
                    <td className="quiet">
                      {SCOPES[row.kind] ?? row.kind}
                      {row.kind !== 'marketing_email' && ` · ${row.version}`}
                    </td>
                    <td>
                      {row.granted ? (
                        <span className="badge ok">Granted</span>
                      ) : (
                        <span className="badge danger">Withdrawn</span>
                      )}
                    </td>
                    <td className="quiet nowrap">{shortDate(row.occurred_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/*
        WHO HAS NOT AGREED TO THE WORDS IN FORCE. This fills when a notice is
        republished, and the screen does not contact them — asking is a
        decision about a message, not a side effect of looking.
      */}
      {report.data !== undefined && report.data.outstanding.length > 0 && (
        <div className="panel tbl-panel">
          <span className="tbl-note">
            Not yet agreed to the version in force — the first hundred.
            {report.data.summary.map((row) => (
              <span key={`${row.kind}:${row.version}`}>
                {' '}
                {row.kind === 'terms' ? 'Terms' : 'Privacy'} {row.version}: {row.customers}.
              </span>
            ))}
          </span>
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>Customer</th>
                  <th>Document</th>
                  <th>Version</th>
                  <th>Published</th>
                </tr>
              </thead>
              <tbody>
                {report.data.outstanding.map((row) => (
                  <tr key={`${row.uuid}:${row.kind}`}>
                    <td>{row.email ?? row.uuid}</td>
                    <td className="quiet">{row.kind === 'terms' ? 'Terms' : 'Privacy'}</td>
                    <td className="quiet">{row.version}</td>
                    <td className="quiet">{shortDate(row.published_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}

const SCOPES: Readonly<Record<string, string>> = {
  marketing_email: 'Marketing',
  terms: 'Terms',
  privacy: 'Privacy notice',
};
