'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Shell } from '@/ui/shell';
import { FormError } from '@/ui/form-error';
import { useLoad, useSubmit, useXetral } from '@/lib/hooks';
import { messageFor } from '@/lib/errors';

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
          Ends this session only. Sign out on each device you no longer use.
        </p>
      </div>

      <YourDetails />
      <SetPin />
      <Consents />
      <YourData />
    </Shell>
  );
}

/**
 * The customer's own details, and the one field they may change.
 *
 * FOUR OF THE FIVE ARE READ-ONLY AND EACH SAYS WHAT CHANGES IT. A disabled
 * input reads as a bug — somebody taps it, nothing happens, and the screen has
 * given them no way forward. A line of text saying "verify your identity to
 * change this" is the same restriction stated as a next step.
 *
 * The name is editable because it is a GREETING: `040_countries.sql` keeps
 * `users.full_name` and `kyc_submissions.full_name` apart precisely so this one
 * can be personal on day one, and `058_payment_links.sql` calls it "a greeting
 * on a checkout page". Nothing that moves money reads it.
 */
function YourDetails() {
  const client = useXetral();
  const details = useLoad(() => client.accountDetails(), [client]);
  const { busy, error, code, done, run } = useSubmit();
  const [name, setName] = useState<string | undefined>(undefined);

  // `undefined` until the first render after the load, so the input is
  // controlled by what the server holds rather than by an empty string that
  // would blank a name the customer already has while the request is in
  // flight.
  const value = name ?? details.data?.full_name ?? '';
  const missing = details.data !== undefined && details.data.full_name === null;

  return (
    <form
      id="your-details"
      className="card"
      onSubmit={(event) => {
        event.preventDefault();
        void run(async () => {
          const saved = await client.updateName(value.trim());
          // Take the name back off the response rather than trusting the form:
          // the database trims and its CHECK is what actually holds.
          setName(saved.full_name ?? '');
          details.reload();
          return 'Saved.';
        });
      }}
    >
      <h2>Your details</h2>
      <p className="lead">
        {missing
          ? 'We do not have your name yet. It is how we greet you, and what somebody paying your link sees.'
          : 'What we hold about your account.'}
      </p>

      <label>
        Name
        <input
          value={value}
          onChange={(e) => setName(e.target.value)}
          placeholder="Your full name"
          autoComplete="name"
          minLength={2}
          maxLength={120}
          required
        />
        <span className="hint">
          How we greet you, and what somebody paying your link sees. Not your
          verified name — that comes from your identity documents.
        </span>
      </label>

      <button type="submit" disabled={busy || value.trim().length < 2}>
        {busy ? 'Saving…' : 'Save'}
      </button>

      <FormError error={error} code={code} />
      {done !== undefined && <p className="ok">{done}</p>}

      <div className="row">
        <span className="muted">Email</span>
        <span>{details.data?.email ?? '—'}</span>
      </div>
      <div className="row">
        <span className="muted">Phone</span>
        <span>{details.data?.phone ?? '—'}</span>
      </div>
      <div className="row">
        <span className="muted">Country</span>
        <span>{details.data?.country_name ?? details.data?.country ?? '—'}</span>
      </div>
      <div className="row">
        <span className="muted">Member since</span>
        <span>
          {details.data === undefined
            ? '—'
            : new Date(details.data.created_at).toLocaleDateString()}
        </span>
      </div>

      <p className="hint">
        Your email and phone number identify your account, and your country
        decides which payment rails serve you — so none of the three can be
        changed here. Contact support to change your email or phone number.
      </p>
    </form>
  );
}

function SetPin() {
  const client = useXetral();
  const { busy, error, code, done, run } = useSubmit();
  const [current, setCurrent] = useState('');
  const [pin, setPin] = useState('');
  const [confirm, setConfirm] = useState('');
  const [mismatch, setMismatch] = useState(false);

  return (
    <form
      // Named so every screen that refuses an action for a missing PIN can
      // link straight here rather than telling a customer to go and find it.
      id="transaction-pin"
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
      <FormError error={error} code={code} />
      {done !== undefined && <p className="ok">{done}</p>}

      <p className="hint">
        Five wrong attempts locks it for fifteen minutes.
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
  const { busy, error, code, run } = useSubmit();

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
            <span className="hint" style={{ display: 'block' }}>            Takes effect immediately. Security alerts and receipts are not
            marketing and keep coming.</span>
          </span>
        </label>
      )}

      <FormError error={error} code={code} />
    </div>
  );
}

/**
 * A copy of your data, and asking for it to be erased.
 *
 * THE EXPORT ASKS FOR THE PIN, unlike everything else a customer reads. It is
 * every balance, every transaction and every place they have signed in from in
 * one file — and the screen says why, because an unexplained extra step reads
 * as friction rather than as protection.
 *
 * ERASURE IS A REQUEST AND SAYS SO. Presenting it as a button that deletes
 * everything would be a promise the law does not let us keep: AML requires
 * five years of transaction records after an account closes. Telling a
 * customer that up front is the difference between an honest limit and a
 * broken promise, and the retained list below comes from the same table the
 * deletion job reads.
 */
function YourData() {
  const client = useXetral();
  const requests = useLoad(() => client.myDataRequests(), [client]);
  const scope = useLoad(() => client.erasureScope(), [client]);
  const { busy, error, code, done, run } = useSubmit();
  const [pin, setPin] = useState('');

  const retained = scope.data?.filter((row) => row.scope === 'retained') ?? [];

  return (
    <div className="card">
      <h2>Your data</h2>
      <p className="lead">
        You can download everything we hold about you, and you can ask us to
        erase it.
      </p>

      <form
        onSubmit={(event) => {
          event.preventDefault();
          void run(async () => {
            const data = await client.exportMyData(pin);
            setPin('');
            /* Built and revoked in the browser. The file never touches a
               server of ours a second time, and the object URL is released
               immediately so it cannot be reopened from history. */
            const url = URL.createObjectURL(
              new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }),
            );
            const link = document.createElement('a');
            link.href = url;
            link.download = 'xetral-my-data.json';
            link.click();
            URL.revokeObjectURL(url);
            return 'Your data has been downloaded.';
          });
        }}
      >
        <label>
          Transaction PIN
          <input
            type="password"
            inputMode="numeric"
            autoComplete="off"
            value={pin}
            onChange={(e) => setPin(e.target.value)}
            required
          />
          <span className="hint">          One file with every balance, transaction and sign-in.</span>
        </label>
        <button type="submit" disabled={busy}>
          {busy ? 'Preparing…' : 'Download my data'}
        </button>
      </form>

      <h2 style={{ marginTop: 28 }}>Erasure</h2>
      <p className="lead">
        A person reviews every request. What the law requires us to keep is listed
        below, and is deleted when its period ends.
      </p>

      {retained.length > 0 && (
        <ul className="hint">
          {retained.slice(0, 6).map((row) => (
            <li key={row.table_name}>{row.rationale}</li>
          ))}
        </ul>
      )}

      <button
        type="button"
        className="ghost"
        disabled={busy}
        onClick={() => {
          void run(async () => {
            await client.requestMyData('erasure');
            requests.reload();
            return 'We have your request and will respond within the statutory period.';
          });
        }}
      >
        Ask for erasure
      </button>

      {requests.data !== undefined && requests.data.length > 0 && (
        <table style={{ marginTop: 16 }}>
          <thead>
            <tr>
              <th>Request</th>
              <th>Status</th>
              <th>Due by</th>
            </tr>
          </thead>
          <tbody>
            {requests.data.map((row) => (
              <tr key={row.uuid}>
                <td>{row.kind === 'erasure' ? 'Erasure' : 'Copy of my data'}</td>
                <td>{row.status}</td>
                <td>{new Date(row.deadline_at).toLocaleDateString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <FormError error={error} code={code} />
      {done !== undefined && <p className="ok">{done}</p>}
    </div>
  );
}
