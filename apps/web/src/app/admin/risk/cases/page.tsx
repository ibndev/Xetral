'use client';

import Link from 'next/link';
import { useState } from 'react';
import type { AdminCaseOutcome, AdminRiskCase } from '@xetral/client';
import { useAdmin, useLoad } from '@/lib/hooks';
import { messageFor } from '@/lib/errors';
import { AdminError } from '../../access';
import { Select } from '@/ui/select';

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

  return (
    <>
      <div className="panel">
        <h1>Compliance cases</h1>
        <h2>One investigation, one customer</h2>
        <p className="lead">
          Closing a case decides every signal attached to it. New information after
          that opens a new case.
        </p>
        <p className="lead">
          <strong>Nothing here reaches the customer.</strong> Tipping off is an
          offence. Freezing an account is a separate, visible action.
        </p>
        <p className="hint">
          <Link href="/admin/risk">← the signal queue</Link>
        </p>
        <AdminError error={cases.error} code={cases.code} role="compliance" />
        {cases.loading && <p className="spinner">Loading…</p>}
        {cases.data !== undefined && cases.data.length === 0 && (
          <p className="hint">No open cases.</p>
        )}
      </div>

      {(cases.data ?? []).map((item) => (
        <Case key={item.id} item={item} onChanged={cases.reload} />
      ))}
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
    <div className="panel">
      <div className="field-row two">
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
