'use client';

import { useAdmin, useLoad } from '@/lib/hooks';
import { AdminError } from '../access';
import { AdminTitle } from '@/app/admin/nav';
import { Kpis } from '../queue';
import { ageSince } from '../age';
import { Icon } from '@/ui/icon';

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
/** "password_reset" → "Password reset" — what an operator calls it. */
const kindName = (kind: string): string => kind.replace(/_/g, ' ').replace(/^./, (c: string) => c.toUpperCase());

/** Five minutes: longer than any sane worker interval, short enough that a
 *  locked-out customer is still waiting when somebody reads this. */
const STALLED_MS = 5 * 60_000;

export default function Notifications() {
  const admin = useAdmin();
  const data = useLoad(() => admin.notifications(), [admin]);

  const backlog = data.data?.backlog ?? [];
  const abandoned = data.data?.abandoned ?? [];
  const recent = data.data?.recent ?? [];

  const waiting = backlog.reduce((sum, row) => sum + Number(row.waiting), 0);
  const security = backlog.filter((row) => row.class === 'security');
  const oldest = backlog.reduce<string | null>(
    (min, row) => (row.oldest !== null && (min === null || row.oldest < min) ? row.oldest : min),
    null,
  );
  /*
   * STALLED MEANS SOMETHING HAS WAITED LONGER THAN A WORKER WOULD LET IT. Not
   * "the queue is non-empty" — a busy minute has a queue — but the oldest
   * message older than any interval anybody would set. That is the silent
   * failure 012 names: the interval unset, rows accumulating, nothing erroring.
   */
  const stalled = oldest !== null && Date.now() - Date.parse(oldest) > STALLED_MS;
  const lastSent = data.data?.last_sent_at ?? null;

  return (
    <>
      <AdminTitle>Notifications</AdminTitle>
      <Kpis
        items={[
          { label: 'Queued', count: data.data === undefined ? undefined : waiting, tone: 'warn' },
          { label: 'Sent · 24h', count: data.data?.sent_24h, tone: 'ok' },
          { label: 'Last sent', value: data.data === undefined ? undefined : lastSent === null ? 'never' : `${ageSince(lastSent)} ago` },
        ]}
      />
      <AdminError error={data.error} code={data.code} role="support" />
      {data.loading && <p className="spinner">Loading…</p>}

      {data.data !== undefined && (
        /* THE COMP'S STATUS BAR, and what it says is measured, not configured:
           the API cannot see the worker's interval from its own container. */
        <div className={stalled ? 'panel status-bar warn' : 'panel status-bar'}>
          <span className="status-icon" aria-hidden="true">
            <Icon name={stalled ? 'alert' : 'check'} size={18} />
          </span>
          <span>
            <strong>
              {stalled
                ? `Nothing has drained the outbox for ${ageSince(oldest ?? '')}`
                : waiting > 0
                  ? 'Outbox worker is draining'
                  : 'Outbox is empty'}
            </strong>
            <small>
              {stalled
                ? security.length > 0
                  ? 'Password resets and new-device alerts are waiting. Check that exactly one instance has NOTIFICATION_INTERVAL_SECONDS set.'
                  : 'Check that exactly one instance has NOTIFICATION_INTERVAL_SECONDS set.'
                : lastSent === null
                  ? 'No message has been sent yet.'
                  : `Last message left ${ageSince(lastSent)} ago. Nothing here sends inline — a worker drains the outbox.`}
            </small>
          </span>
        </div>
      )}

      <div className="panel tbl-panel">
        <div className="tbl-head">
          <span className="sec">Recent</span>
        </div>
        {data.data !== undefined && recent.length === 0 && <p className="empty">Nothing yet.</p>}
        {recent.length > 0 && (
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>Channel</th>
                  <th>Message</th>
                  <th>To</th>
                  <th>Status</th>
                  <th className="r">When</th>
                </tr>
              </thead>
              <tbody>
                {recent.map((row) => (
                  <tr key={row.id}>
                    <td>Email</td>
                    <td>
                      <strong>{kindName(row.kind)}</strong>
                      {row.class === 'security' && <div className="cell-sub">security</div>}
                    </td>
                    <td className="quiet">{row.recipient}</td>
                    <td>
                      <span
                        className={`badge ${
                          row.status === 'sent' ? 'ok' : row.status === 'abandoned' ? 'danger' : 'warn'
                        }`}
                      >
                        {row.status === 'pending' ? 'Queued' : kindName(row.status)}
                      </span>
                    </td>
                    <td className="r quiet nowrap">{ageSince(row.sent_at ?? row.created_at)} ago</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {backlog.length > 0 && (
        <div className="panel tbl-panel">
          <div className="tbl-head">
            <span className="sec">Waiting, by kind</span>
          </div>
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>Kind</th>
                  <th>Class</th>
                  <th className="r">Waiting</th>
                  <th>Oldest</th>
                  <th className="r">Attempts</th>
                </tr>
              </thead>
              <tbody>
                {backlog.map((row) => (
                  <tr key={`${row.class}-${row.kind}`}>
                    <td>{kindName(row.kind)}</td>
                    <td>
                      <span className={`badge ${row.class === 'security' ? 'danger' : 'info'}`}>{row.class}</span>
                    </td>
                    <td className="r mono">{row.waiting}</td>
                    {/* AGE AS WELL AS DEPTH — a queue of three that has been
                        three since Tuesday is a queue nobody is working. */}
                    <td className="quiet nowrap">{row.oldest === null ? '—' : `${ageSince(row.oldest)} ago`}</td>
                    <td className="r mono">{row.worst_attempts}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {abandoned.length > 0 && (
        <div className="panel tbl-panel">
          <div className="tbl-head">
            <span className="sec">Given up on</span>
          </div>
          <span className="tbl-note">Abandoned rather than retried: waiting will not make these deliverable.</span>
          <div className="scroll">
            <table>
              <tbody>
                {abandoned.map((row) => (
                  <tr key={row.id}>
                    <td>
                      {kindName(row.kind)}
                      <div className="cell-sub">{row.recipient}</div>
                    </td>
                    <td className="r quiet">{row.last_error ?? `${row.attempts} attempts`}</td>
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
