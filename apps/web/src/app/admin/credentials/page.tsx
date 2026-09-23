'use client';

import { Fragment, useState } from 'react';
import type { AdminCredential } from '@xetral/client';
import { useAdmin, useLoad } from '@/lib/hooks';
import { messageFor } from '@/lib/errors';
import { AdminError } from '../access';
import { AdminTitle } from '@/app/admin/nav';
import { Kpis } from '../queue';
import { ageSince } from '../age';

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
  const [copied, setCopied] = useState<string | undefined>();

  const [open, setOpen] = useState<string | undefined>();
  // What is wired up first: a slot documented ahead of its adapter is read by
  // nothing, and listing it between two live keys buries the ones that matter.
  const slots = [...(credentials.data?.slots ?? [])].sort(
    (a, b) => Number(b.in_use) - Number(a.in_use) || a.provider.localeCompare(b.provider),
  );
  const live = slots.filter((c) => c.in_use);
  /* A key older than this is due a rotation. Ninety days is the usual policy
     figure; it is a prompt on a dashboard, not a control. */
  const STALE_MS = 90 * 86_400_000;
  const stale = (c: AdminCredential): boolean =>
    c.is_set && c.updated_at !== null && Date.now() - Date.parse(c.updated_at) > STALE_MS;
  const loaded = credentials.data !== undefined;

  return (
    <>
      <AdminTitle>Provider keys</AdminTitle>
      <Kpis
        items={[
          { label: 'Keys configured', count: loaded ? live.filter((c) => c.is_set).length : undefined },
          { label: 'Missing', count: loaded ? live.filter((c) => !c.is_set).length : undefined, tone: 'danger' },
          { label: 'Rotate soon', count: loaded ? live.filter(stale).length : undefined, tone: 'warn' },
        ]}
      />

      <div className="panel tbl-panel">
        <span className="tbl-note">
          Stored encrypted and never shown again — only the last four characters are kept. A new
          key takes effect within seconds, with no deploy.
        </span>
        <AdminError error={credentials.error} code={credentials.code} role="admin" />
        {credentials.loading && <p className="spinner">Loading…</p>}

        {loaded && slots.length === 0 && (
          <div className="notice warn">
            <p>No credential slots are defined, so there is nowhere to paste a key.</p>
            <p className="hint">
              Apply <span className="mono">packages/ledger/sql/026_provider_credentials.seed.sql</span>{' '}
              and reload.
            </p>
          </div>
        )}

        {slots.length > 0 && (
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>Provider</th>
                  <th>Key</th>
                  <th>Status</th>
                  <th>Last rotated</th>
                  <th className="r" aria-label="Action" />
                </tr>
              </thead>
              <tbody>
                {slots.map((credential) => {
                  const id = `${credential.provider}:${credential.name}`;
                  return (
                    <Fragment key={id}>
                      <tr>
                        <td>
                          <strong style={{ textTransform: 'capitalize' }}>{credential.provider}</strong>
                          <div className="cell-sub">{credential.label}</div>
                        </td>
                        <td className="mono soft">{credential.is_set ? `••••${credential.hint ?? ''}` : '—'}</td>
                        <td>
                          {/* NOT CONNECTED is its own state, not "missing": a slot
                              documented ahead of its adapter is read by nothing,
                              and a green "Set" beside it would read as running. */}
                          {!credential.in_use ? (
                            <span className="badge">Not connected</span>
                          ) : credential.is_set ? (
                            <span className={stale(credential) ? 'badge warn' : 'badge ok'}>
                              {stale(credential) ? 'Rotate' : 'Set'}
                            </span>
                          ) : (
                            <span className="badge danger">Missing</span>
                          )}
                        </td>
                        <td className={stale(credential) ? 'owed' : 'quiet'}>
                          {credential.updated_at === null
                            ? credential.is_set
                              ? 'from environment'
                              : 'never'
                            : `${ageSince(credential.updated_at)} ago`}
                        </td>
                        <td className="r">
                          <button
                            type="button"
                            className={credential.is_set || !credential.in_use ? 'ghost' : undefined}
                            aria-expanded={open === id}
                            onClick={() => setOpen(open === id ? undefined : id)}
                          >
                            {open === id ? 'Close' : credential.is_set ? 'Rotate' : 'Add key'}
                          </button>
                        </td>
                      </tr>
                      {open === id && (
                        <tr className="detail">
                          <td colSpan={5}>
                            <Credential
                              credential={credential}
                              onSaved={() => {
                                setOpen(undefined);
                                credentials.reload();
                              }}
                            />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/*
        THE OTHER HALF OF CONFIGURING A PROVIDER. A secret verifies a signature
        on a request sent to a URL, and the dashboard used to show only the
        secret — so the URL got guessed, and a guessed one answers 404 to a
        provider that will keep POSTing to it while deposits go unrecorded here.
        Neither side reports anything.
      */}
      {(credentials.data?.webhooks.length ?? 0) > 0 && (
        <div className="panel">
          <span className="sec">Webhook URLs</span>
          <p className="sub">Paste these into each provider&rsquo;s dashboard.</p>

          {credentials.data?.webhooks[0]?.absolute === false && (
            <div className="notice warn">
              <p>
                <strong>Set <span className="mono">WEBHOOK_BASE_URL</span></strong> to the address a
                provider can reach this API on, then reload for the full URLs.
              </p>
              <p className="hint">
                Not the web app&rsquo;s address: its proxy drops the signature header, so every
                event would answer 401.
              </p>
            </div>
          )}

          {credentials.data?.webhooks.map((hook) => (
            <div className="webhook-row" key={hook.path}>
              <div className="webhook-main">
                <span className="webhook-label">{hook.label}</span>
                <span className="mono webhook-url">{hook.url}</span>
              </div>
              <button
                type="button"
                className="ghost small"
                onClick={() => {
                  void navigator.clipboard?.writeText(hook.url).then(
                    () => setCopied(hook.path),
                    // A refused clipboard is not worth a banner: the URL is on
                    // screen and can be selected.
                    () => undefined,
                  );
                }}
              >
                {copied === hook.path ? 'Copied' : 'Copy'}
              </button>
            </div>
          ))}
        </div>
      )}

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
          {/* A LABEL, NOT EMPHASIS IN A SENTENCE. A bare `<strong>` inherits
              the body size and 700 weight, so a slot's name rendered at the
              same weight as the PROVIDER heading above it — a field
              outranking the group it is in. Every other `<strong>` on this
              surface is genuinely a word emphasised mid-sentence, which is
              why this is a class rather than a rule about the element. */}
          <span className="slot-label">{credential.label}</span>
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

          {/*
            A TRANSACTION PIN, and this is back deliberately.

            It was removed on the reasoning that a PIN authorises money
            leaving a customer's own account and pasting a key moves nothing.
            True, and it undervalued what the key IS: every provider call
            authenticates with it, so replacing one can point the funding
            rail, the card issuer or the payout rail at somebody else's
            account. No money moves in this request; where all of it goes
            afterwards is decided by it.

            The authenticator code is NOT a second field here. It goes to the
            elevation prompt, which is what appears when the session needs
            one — two boxes on one form asking for two different six-digit
            secrets is exactly how an operator holding both correct ones ends
            up being told they are wrong.
          */}
          <label>
            Transaction PIN
            <input
              type="password"
              inputMode="numeric"
              autoComplete="off"
              maxLength={6}
              value={pin}
              onChange={(e) => setPin(e.target.value)}
            />
          </label>

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
                    await admin.setCredential(credential.provider, credential.name, secret, pin);
                    // Cleared on success and left in place on failure, so a
                    // typed key survives a refusal but never sits in a form
                    // field after it has been stored.
                    setSecret('');
                    // The PIN authorises ONE instruction. Cleared whatever
                    // happened, so it is never left in a field for the next
                    // save to reuse.
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
