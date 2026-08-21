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
