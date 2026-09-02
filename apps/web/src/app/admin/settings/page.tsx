'use client';

import { useState } from 'react';
import type { AdminSetting } from '@xetral/client';
import { useAdmin, useLoad } from '@/lib/hooks';
import { messageFor } from '@/lib/errors';
import { AdminError } from '../access';
import { Select } from '@/ui/select';

/**
 * The controls that used to be a deployment.
 *
 * Fees, ceilings, limits and feature flags were environment variables, which
 * meant changing a fee was a release and turning a feature off during an
 * incident was a release under pressure. They are rows now.
 *
 * The BOUNDS are the point, and they are in the database rather than in this
 * form. A transfer fee is capped at 500 basis points by a CHECK, so `1500`
 * typed where basis points were meant — 15% of every transfer, the one mistake
 * that takes money from every customer at once — is refused whether it arrives
 * through this page, through a script, or through psql at 3am. A validation
 * that only exists in a browser is not a control.
 */
export default function Settings() {
  const admin = useAdmin();
  const settings = useLoad(() => admin.settings(), [admin]);

  const byCategory = new Map<string, AdminSetting[]>();
  for (const setting of settings.data ?? []) {
    const list = byCategory.get(setting.category) ?? [];
    list.push(setting);
    byCategory.set(setting.category, list);
  }

  return (
    <>
      <div className="panel">
        <h1>Settings</h1>
        <h2>Changes take effect within thirty seconds, on every instance</h2>
        <p className="lead">
          Every change is recorded with who made it and when. Bounds are enforced by
          the database.
        </p>
        <AdminError error={settings.error} code={settings.code} role="finance" />
        {settings.loading && <p className="spinner">Loading…</p>}
      </div>

      {[...byCategory.entries()].map(([category, items]) => (
        <div className="panel" key={category}>
          <h2 style={{ textTransform: 'capitalize' }}>{category}</h2>
          {items.map((setting) => (
            <Setting key={setting.key} setting={setting} onSaved={settings.reload} />
          ))}
        </div>
      ))}
    </>
  );
}

function Setting({ setting, onSaved }: { setting: AdminSetting; onSaved: () => void }) {
  const admin = useAdmin();
  const [value, setValue] = useState(setting.value);
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [done, setDone] = useState(false);
  const [history, setHistory] = useState<readonly Record<string, unknown>[] | undefined>();

  const changed = value !== setting.value;

  return (
    <div style={{ borderBottom: '1px solid var(--line)', paddingBottom: 16, marginBottom: 16 }}>
      <div className="field-row two">
        <div>
          <strong>{setting.label}</strong>
          <p className="hint">{setting.description}</p>
          <p className="hint mono">
            {setting.key} · {setting.type}
            {setting.min !== null && ` · min ${setting.min}`}
            {setting.max !== null && ` · max ${setting.max}`}
          </p>
        </div>

        <div>
          <label id="setting-value">
            Value
            {setting.type === 'boolean' ? (
              <Select
                labelledBy="setting-value"
                value={value}
                onChange={setValue}
                options={[
                  { value: 'true', label: 'On' },
                  { value: 'false', label: 'Off' },
                ]}
              />
            ) : (
              <input
                value={value}
                inputMode={setting.type === 'integer' ? 'numeric' : 'text'}
                onChange={(e) => setValue(e.target.value)}
              />
            )}
          </label>

          {changed && (
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
              disabled={!changed || busy || pin === ''}
              onClick={() => {
                setBusy(true);
                setError(undefined);
                setDone(false);
                void (async () => {
                  try {
                    await admin.setSetting(setting.key, value, pin);
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
              {busy ? 'Saving…' : 'Save'}
            </button>

            <button
              type="button"
              className="ghost small"
              onClick={() => {
                void (async () => {
                  try {
                    setHistory(await admin.settingHistory(setting.key));
                  } catch (cause) {
                    setError(messageFor(cause));
                  }
                })();
              }}
            >
              History
            </button>

            {changed && <span className="badge warn">unsaved</span>}
            {done && <span className="badge ok">saved</span>}
          </div>

          {error !== undefined && <p className="error">{error}</p>}
        </div>
      </div>

      {history !== undefined && (
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
              {history.length === 0 && (
                <tr>
                  <td colSpan={4} className="muted">
                    Never changed from its default.
                  </td>
                </tr>
              )}
              {history.map((entry, index) => {
                const row = entry as Record<string, string | null>;
                return (
                  <tr key={index}>
                    <td className="nowrap muted">
                      {new Date(row['changed_at'] ?? '').toLocaleString()}
                    </td>
                    <td className="mono">{row['old_value'] ?? '—'}</td>
                    <td className="mono">{row['new_value']}</td>
                    <td>{row['changed_by'] ?? 'system'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
