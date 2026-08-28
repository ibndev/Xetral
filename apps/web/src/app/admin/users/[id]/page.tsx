'use client';

import { use, useState } from 'react';
import Link from 'next/link';
import { useAdmin, useLoad } from '@/lib/hooks';
import { messageFor } from '@/lib/errors';

/**
 * One customer, and the two things support actually needs to do: see what is
 * going on, and stop it.
 *
 * FREEZING DOES NOT TOUCH BALANCES, and the page says so where an operator
 * will read it. The money stays the customer's and stays owed to them;
 * freezing stops it moving. Conflating the two is how a support action becomes
 * a seizure, and an operator who believes freezing takes the money will use it
 * differently from one who knows it does not.
 */
export default function UserDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const admin = useAdmin();
  const detail = useLoad(() => admin.user(id), [admin, id]);

  const profile = (detail.data?.profile ?? {}) as Record<string, string>;
  const balances = detail.data?.balances ?? [];
  const devices = detail.data?.devices ?? [];
  const history = detail.data?.status_history ?? [];
  const cards = detail.data?.cards ?? [];
  const tier = profile['kyc_tier'] ?? '0';

  return (
    <>
      <div className="panel">
        <h1>{profile['email'] ?? 'Customer'}</h1>
        <h2>
          <Link href="/admin/users">← All customers</Link>
        </h2>

        {detail.loading && <p className="spinner">Loading…</p>}
        {detail.error !== undefined && <p className="error">{detail.error}</p>}

        <div className="row">
          <span className="muted">Status</span>
          <span className={`badge ${profile['status'] === 'active' ? 'ok' : 'warn'}`}>
            {profile['status'] ?? '—'}
          </span>
        </div>
        <div className="row">
          <span className="muted">Customer id</span>
          <span className="mono">{id}</span>
        </div>
        <div className="row">
          <span className="muted">Joined</span>
          <span>
            {profile['created_at'] === undefined
              ? '—'
              : new Date(profile['created_at']).toLocaleString()}
          </span>
        </div>
      </div>

      <div className="grid two">
        <div className="panel">
          <h2>Balances</h2>
          {balances.length === 0 && <p className="empty">Nothing yet.</p>}
          {balances.map((balance, index) => {
            const row = balance as Record<string, string>;
            return (
              <div className="row" key={index}>
                <span>{row['currency']}</span>
                <span className="amount">{row['balance'] ?? row['amount_minor']}</span>
              </div>
            );
          })}
        </div>

        <div className="panel">
          <h2>Devices</h2>
          {devices.length === 0 && <p className="empty">None.</p>}
          {devices.map((device, index) => {
            const row = device as Record<string, string | null>;
            return (
              <div className="row" key={index}>
                <span>
                  {row['platform']}
                  <div className="hint mono">{String(row['fingerprint']).slice(0, 16)}…</div>
                </span>
                <span className={`badge ${row['revoked_at'] === null ? 'ok' : 'danger'}`}>
                  {row['revoked_at'] === null ? 'active' : 'revoked'}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      {/*
        THE CARDS, which this screen could not show at all. A customer ringing
        about a declined card was a conversation nobody on this side could
        follow: no status, no history, and no way to tell whether the card had
        been frozen or by whom.

        Four digits of the number and no more — the same amount the database
        stores, and this panel is read over shoulders and screenshotted into
        tickets.
      */}
      <div className="panel">
        <h2>
          Cards <span className="badge">tier {tier}</span>
        </h2>
        {cards.length === 0 && <p className="empty">None issued.</p>}
        {cards.map((card, index) => {
          const row = card as Record<string, string | number | null>;
          return (
            <CardRow key={index} card={row} onChanged={detail.reload} />
          );
        })}
      </div>

      <ChangeStatus id={id} current={profile['status'] ?? 'active'} onChanged={detail.reload} />

      <div className="panel">
        <h2>Status history</h2>
        {history.length === 0 && <p className="empty">Never changed.</p>}
        {history.map((change, index) => {
          const row = change as Record<string, string>;
          return (
            <div className="row" key={index}>
              <span>
                {row['from_status']} → {row['to_status']}
                <div className="hint">{row['reason']}</div>
              </span>
              <span className="muted nowrap">
                {row['changed_by']}
                <div className="hint">{new Date(row['created_at'] ?? '').toLocaleString()}</div>
              </span>
            </div>
          );
        })}
      </div>
    </>
  );
}

function ChangeStatus({
  id,
  current,
  onChanged,
}: {
  id: string;
  current: string;
  onChanged: () => void;
}) {
  const admin = useAdmin();
  const [status, setStatus] = useState<'active' | 'frozen' | 'closed'>('frozen');
  const [reason, setReason] = useState('');
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [done, setDone] = useState<string | undefined>();

  return (
    <form
      className="panel"
      onSubmit={(event) => {
        event.preventDefault();
        setBusy(true);
        setError(undefined);
        setDone(undefined);
        void (async () => {
          try {
            await admin.setUserStatus(id, status, reason, pin);
            setPin('');
            setReason('');
            setDone(`Account is now ${status}.`);
            onChanged();
          } catch (cause) {
            setError(messageFor(cause));
          } finally {
            setBusy(false);
          }
        })();
      }}
    >
      <h2>Change account status</h2>

      <div className="notice">
        <p>
          Freezing stops money moving. It does <strong>not</strong> touch the
          balance — the money stays theirs and stays owed to them.
        </p>
        <p className="hint">
          Freezing also revokes their live sessions, so it takes effect
          immediately rather than at their next sign-in.
        </p>
      </div>

      <div className="field-row two">
        <label>
          New status
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value as 'active' | 'frozen' | 'closed')}
          >
            <option value="active">Active</option>
            <option value="frozen">Frozen</option>
            <option value="closed">Closed</option>
          </select>
          <span className="hint">Currently {current}.</span>
        </label>

        <label>
          Your transaction PIN
          <input
            type="password"
            inputMode="numeric"
            autoComplete="off"
            value={pin}
            onChange={(e) => setPin(e.target.value)}
            required
          />
          <span className="hint">
            So an unlocked laptop is not the ability to freeze accounts.
          </span>
        </label>
      </div>

      <label>
        Why
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          required
          minLength={3}
        />
        <span className="hint">
          Required by the database, not just by this form. An operator who
          cannot say why should not be doing this.
        </span>
      </label>

      <button type="submit" className={status === 'active' ? undefined : 'danger'} disabled={busy}>
        {busy ? 'Working…' : `Set to ${status}`}
      </button>

      {error !== undefined && <p className="error">{error}</p>}
      {done !== undefined && <p className="ok">{done}</p>}
    </form>
  );
}

/**
 * One card, with its history on demand and a freeze an agent can actually
 * reach.
 *
 * FREEZE AND NOT TERMINATE. Freezing stops spending and the customer can undo
 * it; terminating moves their money and cannot be undone, and there is no
 * support conversation in which doing that without them is right. The API
 * agrees — there is no staff terminate endpoint to call.
 */
function CardRow({
  card,
  onChanged,
}: {
  card: Record<string, string | number | null>;
  onChanged: () => void;
}) {
  const admin = useAdmin();
  const id = String(card['id']);
  const status = String(card['status']);

  const [events, setEvents] = useState<readonly Record<string, string>[] | undefined>();
  const [reason, setReason] = useState('');
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  return (
    <div style={{ borderBottom: '1px solid var(--line)', paddingBottom: 12, marginBottom: 12 }}>
      <div className="row">
        <span>
          <span className="mono">•••• {String(card['last4'] ?? '????')}</span>{' '}
          <span className="hint">{String(card['currency'])}</span>
          {card['replaces_card_id'] !== null && (
            <div className="hint">Replaced an earlier card.</div>
          )}
          {card['replaced_by_card_id'] !== null && (
            <div className="hint">Replaced by a newer card.</div>
          )}
        </span>
        <span className={`badge ${status === 'active' ? 'ok' : status === 'terminated' ? 'danger' : 'warn'}`}>
          {status}
        </span>
      </div>

      <div className="actions">
        <button
          type="button"
          className="ghost small"
          onClick={() => {
            void (async () => {
              try {
                const detail = await admin.card(id);
                setEvents((detail['events'] ?? []) as Record<string, string>[]);
              } catch (cause) {
                setError(messageFor(cause));
              }
            })();
          }}
        >
          History
        </button>
      </div>

      {events !== undefined && (
        <div className="scroll" style={{ marginTop: 8 }}>
          <table>
            <tbody>
              {events.map((event, index) => (
                <tr key={index}>
                  <td className="mono">{event['kind']}</td>
                  <td>{new Date(event['created_at'] ?? '').toLocaleString()}</td>
                  <td className="hint">
                    {event['actor'] === 'system'
                      ? 'automatic'
                      : (event['actor_email'] ?? event['actor'])}
                  </td>
                  <td className="hint">{event['reason'] ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {status !== 'terminated' && status !== 'frozen' && (
        <div style={{ marginTop: 8 }}>
          <label>
            Freeze this card — why?
            <input
              value={reason}
              placeholder="e.g. customer reports charges they did not make"
              onChange={(e) => setReason(e.target.value)}
            />
          </label>
          {reason.trim() !== '' && (
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
              disabled={reason.trim().length < 5 || pin === '' || busy}
              onClick={() => {
                setBusy(true);
                setError(undefined);
                void (async () => {
                  try {
                    await admin.freezeCard(id, reason, pin);
                    setReason('');
                    setPin('');
                    onChanged();
                  } catch (cause) {
                    setError(messageFor(cause));
                  } finally {
                    setBusy(false);
                  }
                })();
              }}
            >
              {busy ? 'Freezing…' : 'Freeze'}
            </button>
            <span className="hint">
              Stops spending. The customer can unfreeze it themselves.
            </span>
          </div>
          {error !== undefined && <p className="error">{error}</p>}
        </div>
      )}
    </div>
  );
}
