'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Nav } from '@/lib/nav';
import { useLoad, useSubmit, useXetral } from '@/lib/hooks';

/**
 * The customer's own account.
 *
 * The transaction PIN lives here and is deliberately separate from the login
 * password. Signing in and moving money are different acts with different
 * consequences, and a stolen session that also carried the ability to spend
 * would make the fifteen-minute access token window a fifteen-minute window
 * for emptying an account.
 */
export default function Settings() {
  const client = useXetral();
  const session = useLoad(() => client.currentSession(), [client]);
  const kyc = useLoad(() => client.kyc(), [client]);

  return (
    <main className="shell">
      <Nav />

      <div className="panel">
        <h1>Your account</h1>
        <h2>Session and verification</h2>

        <div className="row">
          <span className="muted">Identity</span>
          <span>
            {kyc.loading ? (
              '—'
            ) : kyc.data === null || kyc.data === undefined ? (
              <Link href="/kyc">Not started — verify now</Link>
            ) : (
              <span
                className={`badge ${
                  kyc.data.status === 'approved'
                    ? 'ok'
                    : kyc.data.status === 'rejected'
                      ? 'danger'
                      : 'warn'
                }`}
              >
                {kyc.data.status}
              </span>
            )}
          </span>
        </div>

        <div className="row">
          <span className="muted">This session expires</span>
          <span>
            {session.data === undefined
              ? '—'
              : new Date(session.data.expires_at).toLocaleString()}
          </span>
        </div>

        <p className="hint">
          Signing out ends this session immediately. It does not affect your
          other devices — sign out on each one you no longer use.
        </p>
      </div>

      <SetPin />
    </main>
  );
}

function SetPin() {
  const client = useXetral();
  const { busy, error, done, run } = useSubmit();
  const [current, setCurrent] = useState('');
  const [pin, setPin] = useState('');
  const [confirm, setConfirm] = useState('');
  const [mismatch, setMismatch] = useState(false);

  return (
    <form
      className="panel"
      onSubmit={(event) => {
        event.preventDefault();
        if (pin !== confirm) {
          setMismatch(true);
          return;
        }
        setMismatch(false);
        void run(async () => {
          await client.setPin(pin, current === '' ? undefined : current);
          // Cleared immediately. A PIN sitting in component state outlives the
          // request that needed it, and there is nothing further to do with
          // it here.
          setCurrent('');
          setPin('');
          setConfirm('');
          return 'Your transaction PIN is set.';
        });
      }}
    >
      <h2>Transaction PIN</h2>
      <p className="lead">
        Required for every action that moves money. Separate from your password
        on purpose.
      </p>

      <label>
        Current PIN
        <input
          type="password"
          inputMode="numeric"
          autoComplete="off"
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
        />
        <span className="hint">Leave empty if you have not set one before.</span>
      </label>

      <div className="field-row two">
        <label>
          New PIN
          <input
            type="password"
            inputMode="numeric"
            autoComplete="off"
            value={pin}
            onChange={(e) => setPin(e.target.value)}
            required
          />
        </label>

        <label>
          Confirm new PIN
          <input
            type="password"
            inputMode="numeric"
            autoComplete="off"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            required
          />
        </label>
      </div>

      <button type="submit" disabled={busy}>
        {busy ? 'Saving…' : 'Set PIN'}
      </button>

      {mismatch && <p className="error">Those two PINs are not the same.</p>}
      {error !== undefined && <p className="error">{error}</p>}
      {done !== undefined && <p className="ok">{done}</p>}

      <p className="hint">
        Five wrong attempts locks it for fifteen minutes. That is what stops
        somebody with your unlocked phone guessing it.
      </p>
    </form>
  );
}
