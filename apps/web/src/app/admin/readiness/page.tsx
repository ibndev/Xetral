'use client';

import Link from 'next/link';
import { useAdmin, useLoad } from '@/lib/hooks';
import type { AdminReadinessRow } from '@xetral/client';
import { AdminError } from '../access';

/**
 * What this deployment has not been told yet.
 *
 * WHAT THIS EXISTS FOR is that the prerequisites were six paragraphs in three
 * documents, and the worst of them fail SILENTLY: an unset notification
 * interval means the outbox fills, the API keeps saying "check your email",
 * and nothing is sent. Nothing errors, because writing the row succeeded.
 *
 * THE SILENT ONES ARE FIRST, and everything else is below them, because a
 * screen that sorts alphabetically buries the row that matters under forty
 * that do not.
 *
 * `unset-here` IS NOT A FAULT and is shown separately for that reason. A
 * worker interval belongs on ONE instance, so its absence from the API
 * container is correct — listing it as a problem would put nine false
 * findings on every production deployment, and a screen that is wrong nine
 * times is a screen nobody opens.
 */

const FAILURE_LABEL: Record<AdminReadinessRow['failure'], string> = {
  'refuses-to-boot': 'refuses to boot',
  'refuses-the-first-request': 'refuses the first request',
  silent: 'fails silently',
  'wrong-by-default': 'runs on a number nobody chose',
  'default-is-deliberate': 'default is deliberate',
};

function Rows({ rows }: { rows: readonly AdminReadinessRow[] }) {
  return (
    <table>
      <thead>
        <tr>
          <th>What</th>
          <th>Flow</th>
          <th>If it is missed</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={`${row.kind}:${row.name}`}>
            <td>
              <code>{row.name}</code>
              <br />
              <span className="muted">{FAILURE_LABEL[row.failure]}</span>
            </td>
            <td className="muted">{row.flow ?? 'the platform'}</td>
            <td>{row.ifMissed}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default function Readiness() {
  const admin = useAdmin();
  const report = useLoad(() => admin.readiness(), [admin]);

  const rows = report.data?.rows ?? [];
  const unset = rows.filter((r) => r.state === 'unset');
  const silent = unset.filter((r) => r.failure === 'silent');
  // Separated from the rest of the unset rows, because a `default-is-deliberate`
  // item is not a finding: an operator who never touches it has not made a
  // mistake. Putting it under "not set" alongside a missing webhook secret is
  // how a screen ends up mostly wrong and stops being opened.
  const fine = unset.filter((r) => r.failure === 'default-is-deliberate');
  const otherUnset = unset.filter(
    (r) => r.failure !== 'silent' && r.failure !== 'default-is-deliberate',
  );
  const elsewhere = rows.filter((r) => r.state === 'unset-here');
  const byHand = rows.filter((r) => r.state === 'not-observable');
  const done = rows.filter((r) => r.state === 'set');

  return (
    <>
      <div className="panel">
        <h1>Readiness</h1>
        <p className="lead">
          Every prerequisite this platform has, asked of the process that answered
          this request.
        </p>
        <AdminError error={report.error} code={report.code} role="admin" />
        {report.loading && <p className="spinner">Loading…</p>}
        {report.data !== undefined && (
          <p className="hint">
            Answered by <code>{report.data.instance.hostname}</code>, running as{' '}
            <strong>{report.data.instance.environment}</strong>. {done.length} of{' '}
            {rows.length} set.
          </p>
        )}
      </div>

      {silent.length > 0 && (
        <div className="panel">
          <h2 className="danger">Nothing will tell you about these</h2>
          <p className="lead">
            Not set, and their absence produces no error anywhere. This is the
            list to work through first.
          </p>
          <Rows rows={silent} />
        </div>
      )}

      {otherUnset.length > 0 && (
        <div className="panel">
          <h2>Not set</h2>
          <p className="lead">
            These announce themselves — at boot, or at the first request on the
            flow they configure.
          </p>
          <Rows rows={otherUnset} />
        </div>
      )}

      {fine.length > 0 && (
        <div className="panel">
          <h2>Not set, and that is the intended state</h2>
          <p className="lead">
            Each has a deliberate default. Listed for completeness, not as a
            problem.
          </p>
          <details>
            <summary>Show {fine.length}</summary>
            <Rows rows={fine} />
          </details>
        </div>
      )}

      {elsewhere.length > 0 && (
        <div className="panel">
          <h2>Expected to be set on another instance</h2>
          <p className="lead">
            Worker intervals go on <strong>exactly one</strong> instance, so their
            absence here is correct if the worker has them.{' '}
            <em>Open this screen on the worker to confirm.</em>
          </p>
          <Rows rows={elsewhere} />
        </div>
      )}

      {byHand.length > 0 && (
        <div className="panel">
          <h2>Nothing here can check these</h2>
          <p className="lead">
            Things a person has to confirm — see{' '}
            <Link href="/admin/staff">Staff</Link> and{' '}
            <Link href="/admin/prices">Prices</Link>.
          </p>
          <Rows rows={byHand} />
        </div>
      )}

      {done.length > 0 && (
        <div className="panel">
          <h2>Set</h2>
          {/* Shown, not hidden: "nothing to do" and "not checked" look
              identical when the only thing on screen is an empty list. */}
          <p className="lead">{done.length} items, nothing to do.</p>
          <details>
            <summary>Show them</summary>
            <Rows rows={done} />
          </details>
        </div>
      )}
    </>
  );
}
