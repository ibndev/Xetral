'use client';

import Link from 'next/link';
import { useAdmin, useLoad } from '@/lib/hooks';
import type { AdminReadinessRow } from '@xetral/client';
import { AdminError } from '../access';
import { AdminTitle } from '@/app/admin/nav';
import { Kpis } from '../queue';

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

type Mark = 'ok' | 'blocking' | 'elsewhere' | 'deliberate' | 'by-hand';

/** What the comp's right-hand column says, and the icon beside the name. */
function markOf(row: AdminReadinessRow): Mark {
  if (row.state === 'set') return 'ok';
  if (row.state === 'unset-here') return 'elsewhere';
  if (row.state === 'not-observable') return 'by-hand';
  return row.failure === 'default-is-deliberate' ? 'deliberate' : 'blocking';
}

const MARK_TEXT: Record<Mark, string> = {
  ok: 'set',
  blocking: 'unset',
  elsewhere: 'on the worker?',
  deliberate: 'default kept',
  'by-hand': 'confirm by hand',
};

/**
 * ONE CHECK PER ROW, as the comp lists them — a mark, the name, what it is
 * for, and its state. What happens if it is missed is the whole reason the
 * row exists, so it is one press away rather than a third column squeezing
 * every row to four lines.
 */
function Rows({ rows }: { rows: readonly AdminReadinessRow[] }) {
  return (
    <div className="checks">
      {rows.map((row) => {
        const mark = markOf(row);
        return (
          <details className={`check ${mark}`} key={`${row.kind}:${row.name}`}>
            <summary>
              <span className="check-mark" aria-hidden="true">
                {mark === 'ok' ? '✓' : mark === 'blocking' ? '✕' : mark === 'deliberate' ? '•' : '!'}
              </span>
              <span className="check-name">
                <code>{row.name}</code>
                <small>{row.flow ?? 'the platform'} · {FAILURE_LABEL[row.failure]}</small>
              </span>
              <span className="check-state">{MARK_TEXT[mark]}{mark === 'blocking' && row.failure === 'silent' ? ' — silent' : ''}</span>
            </summary>
            <p className="hint">{row.ifMissed}</p>
          </details>
        );
      })}
    </div>
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

  const blocking = silent.length + otherUnset.length;
  return (
    <>
      <AdminTitle>Readiness</AdminTitle>
      <Kpis
        items={[
          {
            label: 'Checks passing',
            value: report.data === undefined ? undefined : (
              <span className="pass">
                {done.length} / {rows.length}
              </span>
            ),
          },
          { label: 'Blocking', count: report.data === undefined ? undefined : blocking, tone: 'danger' },
          { label: 'Silent if missed', count: report.data === undefined ? undefined : silent.length, tone: 'danger' },
        ]}
      />
      <AdminError error={report.error} code={report.code} role="admin" />
      {report.loading && <p className="spinner">Loading…</p>}
      {report.data !== undefined && (
        /* IT ANSWERS FOR THE PROCESS THAT SERVED IT, and says so — worker
           intervals read unset here and are correctly set on the worker. */
        <p className="tbl-note flush">
          Answered by <code>{report.data.instance.hostname}</code>, running as{' '}
          <strong>{report.data.instance.environment}</strong>.
        </p>
      )}

      {silent.length > 0 && (
        <div className="panel">
          <span className="sec danger">Nothing will tell you about these</span>
          <p className="sub">
            Not set, and their absence produces no error anywhere. This is the
            list to work through first.
          </p>
          <Rows rows={silent} />
        </div>
      )}

      {otherUnset.length > 0 && (
        <div className="panel">
          <span className="sec">Not set</span>
          <p className="sub">
            These announce themselves — at boot, or at the first request on the
            flow they configure.
          </p>
          <Rows rows={otherUnset} />
        </div>
      )}

      {fine.length > 0 && (
        <div className="panel">
          <span className="sec">Not set, and that is the intended state</span>
          <p className="sub">
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
          <span className="sec">Expected to be set on another instance</span>
          <p className="sub">
            Worker intervals go on <strong>exactly one</strong> instance, so their
            absence here is correct if the worker has them.{' '}
            <em>Open this screen on the worker to confirm.</em>
          </p>
          <Rows rows={elsewhere} />
        </div>
      )}

      {byHand.length > 0 && (
        <div className="panel">
          <span className="sec">Nothing here can check these</span>
          <p className="sub">
            Things a person has to confirm — see{' '}
            <Link href="/admin/staff">Staff</Link> and{' '}
            <Link href="/admin/prices">Prices</Link>.
          </p>
          <Rows rows={byHand} />
        </div>
      )}

      {done.length > 0 && (
        <div className="panel">
          <span className="sec">Set</span>
          {/* Shown, not hidden: "nothing to do" and "not checked" look
              identical when the only thing on screen is an empty list. */}
          <p className="sub">{done.length} items, nothing to do.</p>
          <details>
            <summary>Show them</summary>
            <Rows rows={done} />
          </details>
        </div>
      )}
    </>
  );
}
