'use client';

import { useAdmin, useLoad } from '@/lib/hooks';

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

  return (
    <>
      <div className="panel">
        <h1>Consent</h1>
        <p className="lead">
          Every customer&rsquo;s agreement is recorded against a version, so it
          can be shown later. This is who has not agreed to the version
          currently published.
        </p>
        {report.error !== undefined && <p className="error">{report.error}</p>}
        {report.loading && <p className="spinner">Loading…</p>}
        {report.data !== undefined && report.data.outstanding.length === 0 && (
          <p className="empty">
            Nobody outstanding. This fills up when a notice is republished.
          </p>
        )}
      </div>

      {report.data !== undefined && report.data.summary.length > 0 && (
        <div className="panel">
          <h2>By document</h2>
          <table>
            <thead>
              <tr>
                <th>Document</th>
                <th>Version</th>
                <th>Customers</th>
              </tr>
            </thead>
            <tbody>
              {report.data.summary.map((row) => (
                <tr key={`${row.kind}:${row.version}`}>
                  <td>{row.kind === 'terms' ? 'Terms of service' : 'Privacy notice'}</td>
                  <td>{row.version}</td>
                  <td>{row.customers}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {report.data !== undefined && report.data.outstanding.length > 0 && (
        <div className="panel">
          <h2>Outstanding</h2>
          <p className="lead">
            The first hundred. Asking them is a product decision — a banner, a
            prompt at sign-in — not something this screen does on their behalf.
          </p>
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
                  <td>{row.kind === 'terms' ? 'Terms' : 'Privacy'}</td>
                  <td>{row.version}</td>
                  <td>{new Date(row.published_at).toLocaleDateString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
