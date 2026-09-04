'use client';

import { useAdmin, useLoad } from '@/lib/hooks';
import { AdminError } from '../access';

/**
 * WHETHER ANYTHING IS ACTUALLY BEING SENT.
 *
 * THE FAILURE THIS SCREEN EXISTS FOR is silent by construction and is written
 * down in three places without ever having been visible in one. With
 * `NOTIFICATION_INTERVAL_SECONDS` unset, the outbox fills, the API keeps
 * answering "check your email", and nothing errors — because writing the row
 * succeeded. A password reset that is never sent is a customer locked out of
 * their own money, and the only evidence was a table nobody could reach
 * without a psql prompt on the production database.
 *
 * SECURITY MAIL IS SEPARATED FROM THE REST, because a backlog of receipts is
 * an annoyance and a backlog of resets is an outage. 012 groups the view by
 * class for exactly that reason; this reads it the same way.
 *
 * NO MESSAGE BODY APPEARS HERE, and none can. A rendered reset email carries
 * a live bearer token, so the payload is sealed and is erased on send — the
 * API has no column to return.
 */
export default function Notifications() {
  const admin = useAdmin();
  const data = useLoad(() => admin.notifications(), [admin]);

  const backlog = data.data?.backlog ?? [];
  const abandoned = data.data?.abandoned ?? [];
  const recent = data.data?.recent ?? [];

  const waiting = backlog.reduce((sum, row) => sum + Number(row.waiting), 0);
  const security = backlog.filter((row) => row.class === 'security');

  return (
    <>
      <div className="panel">
        <h1>Notifications</h1>
        <h2>{waiting} waiting to be sent</h2>
        <p className="lead">
          Nothing here sends inline. A message is a row written in the same
          transaction as the event that owed it, and a worker drains it.
        </p>
        <AdminError error={data.error} code={data.code} role="support" />
        {data.loading && <p className="spinner">Loading…</p>}

        {/*
          THE ONE THING WORTH INTERRUPTING SOMEBODY FOR. A queue of receipts is
          an annoyance; a queue of password resets means customers are locked
          out right now and nobody has been told. The most likely cause is not
          a provider outage — it is that no instance has the worker interval
          set, which fails without an error anywhere.
        */}
        {security.length > 0 && (
          <div className="notice warn">
            <p>
              <strong>Security mail is waiting.</strong> Password resets and
              new-device alerts are in this queue. If nothing is draining it,
              check that exactly one instance has{' '}
              <span className="mono">NOTIFICATION_INTERVAL_SECONDS</span> set.
            </p>
          </div>
        )}
      </div>

      <div className="panel">
        <h2>Waiting</h2>
        {backlog.length === 0 && <p className="empty">Nothing waiting.</p>}
        {backlog.length > 0 && (
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>Kind</th>
                  <th>Class</th>
                  <th className="right">Waiting</th>
                  <th>Oldest</th>
                  <th className="right">Attempts</th>
                </tr>
              </thead>
              <tbody>
                {backlog.map((row) => (
                  <tr key={`${row.class}-${row.kind}`}>
                    <td>{row.kind}</td>
                    <td>
                      <span className={`badge ${row.class === 'security' ? 'danger' : 'info'}`}>
                        {row.class}
                      </span>
                    </td>
                    <td className="right mono">{row.waiting}</td>
                    {/*
                      AGE AS WELL AS DEPTH. A queue of three that has been three
                      since Tuesday is a queue nobody is working; a queue of
                      forty turning over hourly is a busy morning. Alerting on
                      depth alone gets both wrong.
                    */}
                    <td className="muted nowrap">
                      {row.oldest === null ? '—' : new Date(row.oldest).toLocaleString()}
                    </td>
                    <td className="right mono">{row.worst_attempts}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="panel">
        <h2>Given up on</h2>
        <p className="lead">
          Abandoned rather than retried: waiting will not make these deliverable.
        </p>
        {abandoned.length === 0 && <p className="empty">None.</p>}
        {abandoned.map((row) => (
          <div className="row" key={row.id}>
            <span>
              {row.kind}
              <div className="cell-sub">{row.recipient}</div>
            </span>
            <span className="muted nowrap">{row.last_error ?? `${row.attempts} attempts`}</span>
          </div>
        ))}
      </div>

      <div className="panel">
        <h2>Recent</h2>
        {recent.length === 0 && <p className="empty">Nothing yet.</p>}
        {recent.length > 0 && (
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>Kind</th>
                  <th>To</th>
                  <th>State</th>
                  <th>When</th>
                </tr>
              </thead>
              <tbody>
                {recent.map((row) => (
                  <tr key={row.id}>
                    <td>{row.kind}</td>
                    <td className="mono">{row.recipient}</td>
                    <td>
                      <span
                        className={`badge ${
                          row.status === 'sent'
                            ? 'ok'
                            : row.status === 'abandoned'
                              ? 'danger'
                              : 'warn'
                        }`}
                      >
                        {row.status}
                      </span>
                    </td>
                    <td className="muted nowrap">
                      {new Date(row.sent_at ?? row.created_at).toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
