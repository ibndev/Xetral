'use client';

import Link from 'next/link';
import { Fragment, useState } from 'react';
import type { AdminCaseOutcome, AdminRiskCase } from '@xetral/client';
import { useAdmin, useLoad } from '@/lib/hooks';
import { messageFor } from '@/lib/errors';
import { AdminError } from '../../access';
import { Select } from '@/ui/select';
import { AdminTitle } from '@/app/admin/nav';
import { ageSince } from '../../age';
import { Kpis, shortRef } from '../../queue';

/**
 * Compliance cases: one investigation, one customer.
 *
 * NOTHING ON THIS PAGE HAS A CUSTOMER-FACING COUNTERPART, and that is a legal
 * constraint rather than a design choice. Tipping off is an offence, so where
 * a case ends in a report the customer must not learn it — not from a status,
 * not from an email, not from a support agent reading a note. The page says so
 * out loud, because the person most likely to break that rule is a helpful
 * colleague who did not know it existed.
 */

const OUTCOMES: readonly { value: AdminCaseOutcome; label: string; means: string }[] = [
  {
    value: 'no_action',
    label: 'No action',
    means: 'Looked at, explained, nothing further to do.',
  },
  {
    value: 'reported',
    label: 'Reported to the NFIU',
    means: 'A Suspicious Transaction Report was filed. Its reference is required.',
  },
  {
    value: 'account_restricted',
    label: 'Account restricted',
    means:
      'The account was frozen or closed. Do that on the customer’s own page — ' +
      'this records that it was the outcome, it does not perform it.',
  },
];

export default function Cases() {
  const admin = useAdmin();
  const cases = useLoad(() => admin.riskCases(), [admin]);
  const [open, setOpen] = useState<string | undefined>();
  const rows = cases.data ?? [];

  return (
    <>
      <AdminTitle>Compliance cases</AdminTitle>
      {/* Counted from the open list itself: every figure here is a property
          of the rows below, so none of them can disagree with the table. */}
      <Kpis
        items={[
          { label: 'Open cases', count: cases.data?.length, tone: 'warn' },
          {
            label: 'Past their deadline',
            count: cases.data?.filter((c) => c.overdue).length,
            tone: 'danger',
          },
          {
            label: 'Signals inside them',
            count: cases.data?.reduce((total, c) => total + c.signals, 0),
          },
        ]}
      />

      <div className="panel tbl-panel">
        <span className="tbl-note">
          Closing a case decides every signal attached to it.{' '}
          <strong>Nothing here reaches the customer</strong> — tipping off is an
          offence. <Link href="/admin/risk">← the signal queue</Link>
        </span>
        <AdminError error={cases.error} code={cases.code} role="compliance" />
        {cases.loading && <p className="spinner">Loading…</p>}
        {cases.data !== undefined && rows.length === 0 && <p className="empty">No open cases.</p>}

        {rows.length > 0 && (
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>Case</th>
                  <th>Subject</th>
                  <th>Signals</th>
                  <th>Opened by</th>
                  <th>Due</th>
                  <th className="r" aria-label="Action" />
                </tr>
              </thead>
              <tbody>
                {rows.map((item) => (
                  <Fragment key={item.id}>
                    <tr>
                      <td className="ref">{shortRef('RC', item.id)}</td>
                      <td>
                        {item.email ?? item.user_uuid}
                        {item.user_status !== 'active' && (
                          <span className="badge danger"> {item.user_status}</span>
                        )}
                      </td>
                      <td className="quiet">{item.signals}</td>
                      <td className="quiet">
                        {item.opened_by_the_sweep ? 'The sweep' : (item.opened_by_email ?? 'a reviewer')}
                      </td>
                      <td className={item.overdue ? 'alarm' : 'quiet'}>
                        {item.overdue ? `${ageSince(item.due_at)} late` : ageSince(item.due_at)}
                      </td>
                      <td className="r">
                        <button
                          type="button"
                          className={open === item.id ? 'ghost' : undefined}
                          aria-expanded={open === item.id}
                          onClick={() => setOpen(open === item.id ? undefined : item.id)}
                        >
                          {open === item.id ? 'Close' : 'Review'}
                        </button>
                      </td>
                    </tr>
                    {open === item.id && (
                      <tr className="detail">
                        <td colSpan={6}>
                          <Case
                            item={item}
                            onChanged={() => {
                              cases.reload();
                            }}
                          />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}

function Case({ item, onChanged }: { item: AdminRiskCase; onChanged: () => void }) {
  const admin = useAdmin();
  const [detail, setDetail] = useState<Record<string, unknown> | undefined>();
  const [note, setNote] = useState('');
  const [outcome, setOutcome] = useState<AdminCaseOutcome>('no_action');
  const [summary, setSummary] = useState('');
  const [reference, setReference] = useState('');
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const chosen = OUTCOMES.find((o) => o.value === outcome);
  const needsReference = outcome === 'reported';
  const canClose =
    summary.trim().length >= 20 && pin !== '' && (!needsReference || reference.trim() !== '');

  async function load(): Promise<void> {
    try {
      setDetail(await admin.riskCase(item.id));
    } catch (cause) {
      setError(messageFor(cause));
    }
  }

  return (
    <div className="review-grid">
      <div>
        <strong>{item.email ?? item.user_uuid}</strong>{' '}
        {item.overdue && <span className="badge warn">overdue</span>}
        {item.user_status !== 'active' && (
          <span className="badge warn"> {item.user_status}</span>
        )}
        <p className="hint">{item.reason}</p>
        <p className="hint mono">
          {item.signals} signal{item.signals === 1 ? '' : 's'} · {item.notes} note
          {item.notes === 1 ? '' : 's'} · due{' '}
          {new Date(item.due_at).toLocaleString()}
        </p>
        <p className="hint">
          {item.opened_by_the_sweep ? (
            // Worth saying: a case opened by counting is a different
            // starting point from one a person judged worth opening.
            <>Opened automatically, because the signals became a pattern.</>
          ) : (
            <>Opened by {item.opened_by_email ?? 'a reviewer'}.</>
          )}
        </p>

        <div className="actions">
          <button type="button" className="ghost small" onClick={() => void load()}>
            {detail === undefined ? 'Open the file' : 'Refresh'}
          </button>
        </div>

        {detail !== undefined && <Detail detail={detail} />}
      </div>

      <div>
        <label>
          Add a note
          <textarea
            rows={3}
            value={note}
            placeholder="What you found, or who you spoke to"
            onChange={(e) => setNote(e.target.value)}
          />
        </label>
        <div className="actions">
          <button
            type="button"
            className="ghost small"
            disabled={note.trim().length < 3 || busy}
            onClick={() => {
              setBusy(true);
              setError(undefined);
              void (async () => {
                try {
                  await admin.noteRiskCase(item.id, note);
                  setNote('');
                  await load();
                  onChanged();
                } catch (cause) {
                  setError(messageFor(cause));
                } finally {
                  setBusy(false);
                }
              })();
            }}
          >
            Save note
          </button>
        </div>

        <hr />

        <label id="case-outcome">
          Outcome
          <Select
            labelledBy="case-outcome"
            value={outcome}
            onChange={(value) => setOutcome(value as AdminCaseOutcome)}
            options={OUTCOMES.map((o) => ({ value: o.value, label: o.label }))}
          />
        </label>
        <p className="hint">{chosen?.means}</p>

        {needsReference && (
          <label>
            Report reference
            <input
              value={reference}
              placeholder="the reference it was filed under"
              onChange={(e) => setReference(e.target.value)}
            />
          </label>
        )}

        <label>
          What was found, and why it ends this way
          <textarea
            rows={4}
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
          />
        </label>
        <p className="hint">
          This becomes the resolution on all {item.signals} signal
          {item.signals === 1 ? '' : 's'} attached to this case.
        </p>

        {summary.trim() !== '' && (
          <label>
            Your transaction PIN
            <input
              type="password"
              inputMode="numeric"
              autoComplete="off"
              value={pin}
              onChange={(e) => setPin(e.target.value)}
            />
          </label>
        )}

        <div className="actions">
          <button
            type="button"
            className="small"
            disabled={!canClose || busy}
            onClick={() => {
              setBusy(true);
              setError(undefined);
              void (async () => {
                try {
                  await admin.closeRiskCase(
                    item.id,
                    {
                      outcome,
                      summary,
                      ...(needsReference ? { report_reference: reference } : {}),
                    },
                    pin,
                  );
                  onChanged();
                } catch (cause) {
                  setError(messageFor(cause));
                } finally {
                  setBusy(false);
                }
              })();
            }}
          >
            {busy ? 'Closing…' : 'Close the case'}
          </button>
          {summary.trim() !== '' && summary.trim().length < 20 && (
            <span className="badge warn">say a little more</span>
          )}
        </div>

        {error !== undefined && <p className="error">{error}</p>}
      </div>
    </div>
  );
}

function Detail({ detail }: { detail: Record<string, unknown> }): React.ReactElement {
  const signals = (detail['signals'] ?? []) as {
    id: string;
    rule: string;
    observed_at: string;
  }[];
  const notes = (detail['notes'] ?? []) as {
    note: string;
    created_at: string;
    author: string;
  }[];

  return (
    <div style={{ marginTop: 12 }}>
      <h3>Transactions</h3>
      <div className="scroll">
        <table>
          <tbody>
            {signals.map((signal) => (
              <tr key={signal.id}>
                <td className="mono">{signal.rule}</td>
                <td>{new Date(signal.observed_at).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h3>Notes</h3>
      {notes.length === 0 && <p className="hint">Nothing written down yet.</p>}
      {notes.map((entry, index) => (
        <p key={index} className="hint">
          <strong>{entry.author}</strong> ·{' '}
          {new Date(entry.created_at).toLocaleString()}
          <br />
          {entry.note}
        </p>
      ))}
    </div>
  );
}
