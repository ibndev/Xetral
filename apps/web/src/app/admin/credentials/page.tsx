'use client';

import { useState } from 'react';
import type { AdminCredential } from '@xetral/client';
import { useAdmin, useLoad } from '@/lib/hooks';
import { messageFor } from '@/lib/errors';
import { AdminError } from '../access';

/**
 * Where an operator pastes a provider key.
 *
 * The whole page is shaped by one rule: a credential goes IN and never comes
 * back out. There is no endpoint that returns one — not sealed, not masked —
 * so there is no field on this page that could render one, and the input is
 * always empty on load rather than pre-filled with what is stored. What an
 * operator gets to confirm they pasted the right thing is the last four
 * characters, which is the same amount of a card number this platform is
 * willing to keep.
 *
 * It is NOT the settings page, deliberately. A fee's whole history is the
 * point and is recorded value by value; an API key's history is a liability,
 * so replacing one records who and when and never what.
 */
export default function Credentials() {
  const admin = useAdmin();
  const credentials = useLoad(() => admin.credentials(), [admin]);

  const byProvider = new Map<string, AdminCredential[]>();
  for (const credential of credentials.data ?? []) {
    const list = byProvider.get(credential.provider) ?? [];
    list.push(credential);
    byProvider.set(credential.provider, list);
  }

  return (
    <>
      <div className="panel">
        <h1>Provider keys</h1>
        <h2>Stored encrypted. Never shown again.</h2>
        <p className="lead">
          A key pasted here takes effect within seconds, on every instance, with
          no deploy. It is sealed before it reaches the database and there is no
          way to read one back — not from this page, not from the API. If you
          lose one, issue a new one at the provider and paste that.
        </p>
        <p className="lead">
          The last four characters are kept so you can tell which key is
          installed. Replacing one records who did it and when, and never what
          it was.
        </p>
        <AdminError error={credentials.error} code={credentials.code} role="admin" />
        {credentials.loading && <p className="spinner">Loading…</p>}

        {/*
          THE EMPTY CASE NAMES ITS CAUSE, because "no boxes to type in" is what
          this page looks like when the catalogue has not been loaded — and an
          operator reasonably reads that as "there is nowhere to put the Bitnob
          key", which is the report that brought us here.

          The slots are a CATALOGUE, seeded by a file that is separate from the
          migration that creates the table. A deployment that applied the
          migrations and not the seeds gets exactly this: a working page with
          nothing to configure and no error, because the query succeeded and
          returned no rows.
        */}
        {credentials.data !== undefined && credentials.data.length === 0 && (
          <div className="notice warn">
            <p>
              No credential slots are defined, so there is nowhere to paste a key.
            </p>
            <p className="hint">
              The catalogue is seeded separately from the schema. On the database,
              apply{' '}
              <span className="mono">
                packages/ledger/sql/026_provider_credentials.seed.sql
              </span>
              , then reload. Until then every adapter falls back to its
              environment variable.
            </p>
          </div>
        )}
      </div>

      {[...byProvider.entries()].map(([provider, items]) => (
        <div className="panel" key={provider}>
          <h2 style={{ textTransform: 'capitalize' }}>{provider}</h2>
          {/*
            Said once per provider rather than once per field. A slot with no
            adapter behind it is offered so a key can be put in the right place
            now — but a filled box on an operations dashboard reads as "this is
            running", and an operator who believes identity checks are live
            when they are not is worse off than one who knows they are not.
          */}
          {items.every((item) => !item.in_use) && (
            <p className="hint">
              <span className="badge warn">not yet connected</span> These keys
              are stored safely and read by nothing. Pasting one changes no
              behaviour until the integration ships.
            </p>
          )}
          {items.map((credential) => (
            <Credential
              key={`${credential.provider}:${credential.name}`}
              credential={credential}
              onSaved={credentials.reload}
            />
          ))}
        </div>
      ))}
    </>
  );
}

function Credential({
  credential,
  onSaved,
}: {
  credential: AdminCredential;
  onSaved: () => void;
}) {
  const admin = useAdmin();
  // Always empty. Pre-filling it with anything — even a mask — invites somebody
  // to save the mask as the key.
  const [secret, setSecret] = useState('');
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [done, setDone] = useState(false);
  const [rotations, setRotations] = useState<readonly Record<string, unknown>[] | undefined>();

  const ready = secret.trim() !== '' && pin !== '';

  return (
    <div style={{ borderBottom: '1px solid var(--line)', paddingBottom: 16, marginBottom: 16 }}>
      <div className="field-row two">
        <div>
          <strong>{credential.label}</strong>
          <p className="hint">{credential.description}</p>
          <p className="hint mono">
            {credential.provider}.{credential.name} · falls back to {credential.env_var}
          </p>
          <p className="hint">
            {credential.is_set ? (
              <>
                <span className="badge ok">set</span>{' '}
                <span className="mono">…{credential.hint}</span>
                {credential.updated_at !== null && (
                  <> · updated {new Date(credential.updated_at).toLocaleString()}</>
                )}
              </>
            ) : (
              <>
                <span className="badge warn">not set</span> Using{' '}
                <span className="mono">{credential.env_var}</span> from the
                environment, if it is set there.
              </>
            )}
          </p>
        </div>

        <div>
          <label>
            {credential.is_set ? 'Replace with' : 'Paste the key'}
            <input
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder={credential.is_set ? 'a new key' : ''}
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
            />
          </label>

          {secret.trim() !== '' && (
            <label>
              Your transaction PIN
              <input
                type="password"
                inputMode="numeric"
                autoComplete="off"
                value={pin}
                onChange={(e) => setPin(e.target.value)}
              />
              {/*
                NAMED, because this field and the authenticator code were
                confused and the confusion was the product's fault. The
                dashboard used to refuse this action with "enter the six-digit
                code from your authenticator app" and offer nowhere to put
                one — so the code went in here, the PIN check refused it, and
                an operator holding both correct secrets was told they were
                wrong. The code is now asked for in its own dialog.
              */}
              <span className="hint">
                Your own PIN — not the six-digit code from your authenticator app.
              </span>
            </label>
          )}

          <div className="actions">
            <button
              type="button"
              className="small"
              disabled={!ready || busy}
              onClick={() => {
                setBusy(true);
                setError(undefined);
                setDone(false);
                void (async () => {
                  try {
                    await admin.setCredential(
                      credential.provider,
                      credential.name,
                      secret,
                      pin,
                    );
                    // Cleared on success AND left in place on failure, so a
                    // typed key is not lost to a wrong PIN — but never left
                    // sitting in a form field after it has been stored.
                    setSecret('');
                    setPin('');
                    setDone(true);
                    onSaved();
                  } catch (cause) {
                    setError(messageFor(cause));
                  } finally {
                    setBusy(false);
                  }
                })();
              }}
            >
              {busy ? 'Saving…' : credential.is_set ? 'Replace' : 'Save'}
            </button>

            <button
              type="button"
              className="ghost small"
              onClick={() => {
                void (async () => {
                  try {
                    setRotations(
                      await admin.credentialRotations(credential.provider, credential.name),
                    );
                  } catch (cause) {
                    setError(messageFor(cause));
                  }
                })();
              }}
            >
              History
            </button>

            {done && <span className="badge ok">saved</span>}
          </div>

          {error !== undefined && <p className="error">{error}</p>}
        </div>
      </div>

      {rotations !== undefined && (
        <div className="scroll" style={{ marginTop: 12 }}>
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>From</th>
                <th>To</th>
                <th>By</th>
              </tr>
            </thead>
            <tbody>
              {rotations.length === 0 && (
                <tr>
                  <td colSpan={4} className="hint">
                    Never set.
                  </td>
                </tr>
              )}
              {rotations.map((row, index) => (
                <tr key={index}>
                  <td>{new Date(String(row['changed_at'])).toLocaleString()}</td>
                  <td className="mono">
                    {row['old_hint'] === null ? '—' : `…${String(row['old_hint'])}`}
                  </td>
                  <td className="mono">…{String(row['new_hint'])}</td>
                  <td>{row['changed_by'] === null ? 'system' : String(row['changed_by'])}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
