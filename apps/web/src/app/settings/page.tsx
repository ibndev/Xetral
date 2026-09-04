'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Shell } from '@/ui/shell';
import { FormError } from '@/ui/form-error';
import { Icon } from '@/ui/icon';
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

  /*
   * The link, fetched here rather than on the Send screen, because this is
   * where somebody comes to FIND it. `profile()` mints one on the first call
   * and returns the same one afterwards, so opening this page is what gives a
   * customer a handle.
   */
  const profile = useLoad(() => client.profile(), [client]);
  const [copied, setCopied] = useState(false);
  const [editing, setEditing] = useState(false);
  const [handle, setHandle] = useState('');
  const [pin, setPin] = useState('');
  const [saving, setSaving] = useState(false);
  const [handleError, setHandleError] = useState<string | undefined>();

  return (
    <Shell>

      <div className="card">
        <h1>Your payment link</h1>
        <h2>Share it and anyone can pay you</h2>
        <p className="lead">
          Safe to post publicly. It reveals nothing but the name on your account.
        </p>

        {profile.loading && <p className="spinner">Loading…</p>}
        {profile.data !== undefined && (
          <>
            <div className="balance">
              <div>
                <div className="amount mono">@{profile.data.handle}</div>
                {profile.data.link !== null && (
                  <div className="pending">{profile.data.link}</div>
                )}
              </div>
            </div>
            {/*
              COPY WHAT THERE IS. With no APP_BASE_URL the server sends no
              link, and offering to copy one anyway would put a string in the
              customer's clipboard that nobody they send it to can open. The
              handle works on its own — it is typed into the Send screen — so
              that is what the button copies.
            */}
            <div className="actions">
              <button
                type="button"
                onClick={() => {
                  const text = profile.data?.link ?? `@${profile.data?.handle ?? ''}`;
                  void navigator.clipboard
                    ?.writeText(text)
                    .then(() => setCopied(true))
                    // A clipboard a browser refused is not an error worth a
                    // banner — the link is on screen and can be selected.
                    .catch(() => undefined);
                }}
              >
                <Icon name="copy" size={16} />{' '}
                {copied ? 'Copied' : profile.data.link === null ? 'Copy my handle' : 'Copy my link'}
              </button>
            </div>
            <p className="hint">
              Yours permanently. It is never reissued to anybody else.
            </p>

            {/*
              THE OLD HANDLE IS NOT FREED, and the copy says so before the
              field rather than after the mistake. 039 refuses a released
              handle to anybody else, so a link already posted goes on
              pointing at a handle only this customer has ever had, instead of
              quietly starting to pay a stranger.
            */}
            {!editing && (
              <div className="actions">
                <button
                  type="button"
                  className="ghost"
                  onClick={() => {
                    setHandle(profile.data?.handle ?? '');
                    setEditing(true);
                  }}
                >
                  Change my handle
                </button>
              </div>
            )}

            {editing && (
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  setSaving(true);
                  setHandleError(undefined);
                  void (async () => {
                    try {
                      await client.chooseHandle(handle, pin);
                      setPin('');
                      setEditing(false);
                      profile.reload();
                    } catch (cause) {
                      setHandleError(messageFor(cause));
                    } finally {
                      setSaving(false);
                    }
                  })();
                }}
              >
                <div className="field">
                  <label htmlFor="handle">New handle</label>
                  {/*
                    The `@` is DRAWN, not typed, and it is not part of the
                    value. `.input-affix` is built for a TRAILING control —
                    the password reveal — so reusing it here would put the
                    symbol on top of the text; `.handle-field` is its leading
                    twin, the same shape `.input-affix.dial` takes for a
                    dialling code. A pasted `@` is still accepted: the server
                    strips one before it checks anything.
                  */}
                  <div className="handle-field">
                    <span className="handle-at" aria-hidden="true">@</span>
                    <input
                      id="handle"
                      value={handle}
                      autoCapitalize="none"
                      autoCorrect="off"
                      spellCheck={false}
                      placeholder="olawale"
                      onChange={(e) => setHandle(e.target.value)}
                      required
                    />
                  </div>
                  <p className="hint">
                    3–20 characters: letters, numbers and underscores. Links
                    using your old handle stop working, and nobody else can
                    ever take it — you can change back to it.
                  </p>
                </div>

                <div className="field">
                  <label htmlFor="handle-pin">Transaction PIN</label>
                  <input
                    id="handle-pin"
                    type="password"
                    inputMode="numeric"
                    autoComplete="off"
                    value={pin}
                    onChange={(e) => setPin(e.target.value)}
                    required
                  />
                </div>

                <div className="actions">
                  <button type="submit" disabled={saving}>
                    {saving ? 'Saving…' : 'Save handle'}
                  </button>
                  <button
                    type="button"
                    className="ghost"
                    onClick={() => {
                      setEditing(false);
                      setHandleError(undefined);
                      setPin('');
                    }}
                  >
                    Cancel
                  </button>
                </div>

                {handleError !== undefined && <p className="error">{handleError}</p>}
              </form>
            )}
          </>
        )}
        <FormError error={profile.error} code={profile.code} />
      </div>

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

      <SetPin />
      <Consents />
      <YourData />
    </Shell>
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
