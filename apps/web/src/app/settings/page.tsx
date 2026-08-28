'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Shell } from '@/ui/shell';
import { Icon } from '@/ui/icon';
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
    <Shell>

      <div className="card">
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
      <Consents />
    </Shell>
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
      className="card"
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

/**
 * What this customer has agreed to.
 *
 * THE WITHDRAWAL IS THE SAME CONTROL AS THE GRANT — one toggle, no
 * confirmation step, no PIN. Consent that is harder to withdraw than to give
 * is not freely given, and a screen that puts an extra dialog in front of
 * turning something OFF is exactly how that happens without anybody deciding
 * it.
 *
 * The terms and the privacy notice are shown and not toggleable, which is the
 * honest presentation: withdrawing them means closing the account, and a
 * switch that silently refused would be worse than none.
 */
function Consents() {
  const client = useXetral();
  const state = useLoad(() => client.consents(), [client]);
  const { busy, error, run } = useSubmit();

  const marketing = state.data?.documents.find((d) => d.kind === 'marketing_email');

  return (
    <div className="card">
      <h2>What you have agreed to</h2>
      <p className="lead">
        We keep a record of which version of each document you agreed to, and
        when. You can see it here.
      </p>

      {state.loading && <p className="spinner">Loading…</p>}
      {state.error !== undefined && <p className="error">{state.error}</p>}

      {state.data?.documents
        .filter((doc) => doc.kind !== 'marketing_email')
        .map((doc) => {
          const record = state.data?.consents.find((c) => c.kind === doc.kind);
          return (
            <div className="row" key={doc.kind}>
              <span className="muted">
                {doc.kind === 'terms' ? 'Terms of service' : 'Privacy notice'}
              </span>
              <span>
                {record === undefined ? (
                  <Link href={`/legal/${doc.kind}`}>Not recorded — please read</Link>
                ) : record.covers_current ? (
                  <>
                    Agreed {new Date(record.occurred_at).toLocaleDateString()}{' '}
                    <span className="muted">(version {record.version})</span>
                  </>
                ) : (
                  /* They agreed, but to different words. Saying "agreed" here
                     would treat a superseded consent as a current one. */
                  <Link href={`/legal/${doc.kind}`}>
                    Updated since you agreed — please read
                  </Link>
                )}
              </span>
            </div>
          );
        })}

      {marketing !== undefined && (
        <label className="row" style={{ alignItems: 'flex-start', gap: 12 }}>
          <input
            type="checkbox"
            checked={marketing.agreed}
            disabled={busy}
            onChange={(event) => {
              const granted = event.target.checked;
              void run(async () => {
                await client.setConsent('marketing_email', granted);
                state.reload();
                return granted ? 'You will hear from us.' : 'We will stop emailing you.';
              });
            }}
          />
          <span>
            {marketing.summary}
            <span className="hint" style={{ display: 'block' }}>
              Turning this off takes effect immediately. It never affects
              security alerts or receipts — those are not marketing, and you
              cannot be opted out of being told somebody signed in as you.
            </span>
          </span>
        </label>
      )}

      {error !== undefined && <p className="error">{error}</p>}
    </div>
  );
}
