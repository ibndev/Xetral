'use client';

import { useState } from 'react';
import type { AdminSetting } from '@xetral/client';
import { useAdmin, useLoad } from '@/lib/hooks';
import { messageFor } from '@/lib/errors';
import { AdminError } from '../access';
import { Select } from '@/ui/select';
import { AdminTitle } from '@/app/admin/nav';

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

  /*
   * ONE CATEGORY AT A TIME, because fifty-four rows in one column is not a
   * page anybody reads.
   *
   * They were all stacked, so finding the funding rail meant scrolling past
   * every fee, every retention period and every risk threshold — and an
   * operator scrolling past a control is an operator who has stopped seeing
   * it. The categories already exist: `platform_settings.category` is a
   * column every migration fills, so this is the data's own grouping rather
   * than a list typed here that a new setting would fall out of.
   *
   * `undefined` until the first load answers, so the tab that opens is the
   * first category the SERVER returned rather than one guessed here and then
   * corrected — which would render an empty panel for a moment on every
   * visit.
   */
  const categories = [...byCategory.keys()];
  const [chosen, setChosen] = useState<string | undefined>();
  const active = chosen !== undefined && byCategory.has(chosen) ? chosen : categories[0];
  const items = active === undefined ? [] : (byCategory.get(active) ?? []);

  return (
    <>
      <div className="panel set-top">
        <AdminTitle>Settings</AdminTitle>
        <p className="tbl-note">Every change takes your PIN and is recorded. Bounds are enforced by the database.</p>
        <AdminError error={settings.error} code={settings.code} role="finance" />
        {settings.loading && <p className="spinner">Loading…</p>}

        {categories.length > 0 && (
          /*
            CHIPS, NOT A SEGMENTED CONTROL.

            A segmented control is one choice out of a FIXED, SHORT set that
            all fit — it is a single track with two rounded ends, and the ends
            are what say "this is the whole set". There are NINE categories
            here, so the track ran off the side of the panel and the last one
            was cut in half against a straight edge: a control that looks
            complete and is not. Chips each have their own shape, so a
            half-visible one says there are more, which is the Activity
            screen's rail and the same argument.
          */
          <div
            className="chip-rail"
            role="tablist"
            aria-label="Setting categories"
          >
            {categories.map((category) => (
              <button
                key={category}
                type="button"
                role="tab"
                aria-selected={category === active}
                className={category === active ? 'chip on' : 'chip'}
                style={{ textTransform: 'capitalize' }}
                onClick={() => setChosen(category)}
              >
                {category}{' '}
                <span className="muted">
                  {byCategory.get(category)?.filter((x) => !WHEN_OFF_KEYS.has(x.key)).length}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      {active !== undefined && (
        <div className="panel set-list">
          {items
            // A service's `_when_off` row is drawn INSIDE its three-state
            // control below, never as a second row of its own (093).
            .filter((setting) => !WHEN_OFF_KEYS.has(setting.key))
            .map((setting) =>
              FEATURE_KEYS.has(setting.key) ? (
                <FeatureSetting
                  key={setting.key}
                  enabled={setting}
                  whenOff={(settings.data ?? []).find((s) => s.key === whenOffKeyOf(setting.key))}
                  onSaved={settings.reload}
                />
              ) : (
                <Setting key={setting.key} setting={setting} onSaved={settings.reload} />
              ),
            )}
        </div>
      )}
    </>
  );
}

/**
 * THE FIVE SERVICES WITH THREE STATES (093): Enabled, Coming soon, Hidden.
 *
 * Each is two rows — `<service>_enabled` and `<service>_when_off` — and an
 * operator should not have to know that, so they are one control here. The
 * writes are ORDERED so every state passed through on the way is itself one
 * of the three: `_when_off` is written first, then `_enabled`. A second write
 * that fails leaves the service exactly where it was, never half-hidden.
 */
const FEATURE_KEYS: ReadonlySet<string> = new Set([
  'crypto_enabled',
  'fx_enabled',
  'cards_enabled',
  'bills_enabled',
  'payouts_enabled',
]);
const whenOffKeyOf = (enabledKey: string) => enabledKey.replace(/_enabled$/, '_when_off');
const WHEN_OFF_KEYS: ReadonlySet<string> = new Set([...FEATURE_KEYS].map(whenOffKeyOf));

type FeatureState = 'enabled' | 'coming_soon' | 'hidden';
const STATE_LABEL: Readonly<Record<FeatureState, string>> = {
  enabled: 'Enabled',
  coming_soon: 'Coming soon',
  hidden: 'Hidden',
};
const STATE_MEANS: Readonly<Record<FeatureState, string>> = {
  enabled: 'Customers can use it.',
  coming_soon: 'Shown everywhere it is offered, marked Coming soon. New activity is refused.',
  hidden:
    'Removed from both apps — lists, home screen, navigation, links and pickers — and every customer endpoint it owns answers as if it did not exist.',
};

function stateOf(enabled: AdminSetting, whenOff: AdminSetting | undefined): FeatureState {
  if (enabled.value === 'true') return 'enabled';
  return whenOff?.value === 'hidden' ? 'hidden' : 'coming_soon';
}

function FeatureSetting({
  enabled,
  whenOff,
  onSaved,
}: {
  enabled: AdminSetting;
  whenOff: AdminSetting | undefined;
  onSaved: () => void;
}) {
  const admin = useAdmin();
  const current = stateOf(enabled, whenOff);
  const [target, setTarget] = useState<FeatureState>(current);
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [done, setDone] = useState(false);
  const open = target !== current;

  async function save() {
    setBusy(true);
    setError(undefined);
    setDone(false);
    try {
      if (target === 'enabled') {
        await admin.setSetting(enabled.key, 'true', pin);
      } else {
        if (whenOff === undefined) throw new Error('missing');
        if (whenOff.value !== target) await admin.setSetting(whenOff.key, target, pin);
        if (enabled.value !== 'false') await admin.setSetting(enabled.key, 'false', pin);
      }
      setPin('');
      setDone(true);
      onSaved();
    } catch (cause) {
      setError(
        whenOff === undefined && target !== 'enabled'
          ? 'This database is behind migration 093, so a service can only be switched on or off.'
          : messageFor(cause),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={open ? 'set-row open' : 'set-row'}>
      <div className="set-head">
        <span className="set-name">
          <strong>{enabled.label}</strong>
          <small>{STATE_MEANS[current]}</small>
        </span>
        {done && !open && <span className="badge ok" role="status">saved</span>}
        <div className="segmented" role="radiogroup" aria-label={`${enabled.label}: state`}>
          {(['enabled', 'coming_soon', 'hidden'] as const).map((option) => (
            <button
              key={option}
              type="button"
              role="radio"
              aria-checked={target === option}
              className={target === option ? 'active' : ''}
              // Hidden needs 093's row. Without it the choice could not be
              // written, so it is not offered rather than refused on Save.
              disabled={option === 'hidden' && whenOff === undefined}
              onClick={() => {
                setTarget(option);
                setDone(false);
                setError(undefined);
              }}
            >
              {STATE_LABEL[option]}
            </button>
          ))}
        </div>
      </div>

      {open && (
        <div className="set-edit">
          <div className="field-row two">
            <p className="hint">
              Set <strong>{enabled.label}</strong> to <strong>{STATE_LABEL[target]}</strong>?{' '}
              {STATE_MEANS[target]}
            </p>
            <label>
              <span>Transaction PIN</span>
              <input
                type="password"
                inputMode="numeric"
                autoComplete="off"
                value={pin}
                onChange={(e) => setPin(e.target.value)}
              />
            </label>
          </div>
          <div className="actions">
            <button type="button" className="small" disabled={busy || pin === ''} onClick={() => void save()}>
              {busy ? 'Saving…' : 'Save'}
            </button>
            <button
              type="button"
              className="ghost small"
              onClick={() => {
                setTarget(current);
                setPin('');
                setError(undefined);
              }}
            >
              Cancel
            </button>
          </div>
          {error !== undefined && <p className="error">{error}</p>}
          <p className="hint mono">
            {enabled.key}
            {whenOff !== undefined && ` · ${whenOff.key}`}
          </p>
        </div>
      )}
    </div>
  );
}

/** The first sentence of a description — what the row says at rest. The rest
 *  is one press away, never deleted: these are rows each migration wrote. */
function firstSentence(text: string): string {
  const end = text.search(/\.(\s|$)/);
  return end === -1 ? text : text.slice(0, end + 1);
}

function Setting({ setting, onSaved }: { setting: AdminSetting; onSaved: () => void }) {
  const admin = useAdmin();
  const [value, setValue] = useState(setting.value);
  const [open, setOpen] = useState(false);
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [done, setDone] = useState(false);
  const [history, setHistory] = useState<readonly Record<string, unknown>[] | undefined>();

  const changed = value !== setting.value;
  const boolean = setting.type === 'boolean';
  const on = setting.value === 'true';

  return (
    <div className={open ? 'set-row open' : 'set-row'}>
      {/* THE COMP'S ROW: what it is, what it is set to, and the control. A
          switch for a boolean — but pressing it OPENS the change rather than
          making it, because every change here takes a PIN and is recorded,
          and a switch that flipped a live kill switch on a stray click is
          the one control on this surface that must not be that easy. */}
      <div className="set-head">
        <span className="set-name">
          <strong>{setting.label}</strong>
          <small>{setting.description === '' ? setting.key : firstSentence(setting.description)}</small>
        </span>
        {done && !open && <span className="badge ok" role="status">saved</span>}
        {!boolean && <span className="set-value mono">{setting.value}</span>}
        {boolean ? (
          <button
            type="button"
            role="switch"
            aria-checked={on}
            aria-label={`${setting.label}: ${on ? 'on' : 'off'}`}
            className={on ? 'switch on' : 'switch'}
            onClick={() => {
              setValue(on ? 'false' : 'true');
              setOpen(true);
            }}
          />
        ) : (
          <button type="button" className="ghost" aria-expanded={open} onClick={() => setOpen((was) => !was)}>
            {open ? 'Close' : 'Change'}
          </button>
        )}
      </div>

      {open && (
        <div className="set-edit">
          <div className="field-row two">
            {boolean ? (
              <p className="hint">
                Turn <strong>{setting.label}</strong> {value === 'true' ? 'on' : 'off'}?
              </p>
            ) : (
              <label>
                <span>
                  New value{setting.min !== null && ` · min ${setting.min}`}
                  {setting.max !== null && ` · max ${setting.max}`}
                </span>
                <input
                  value={value}
                  inputMode={setting.type === 'integer' ? 'numeric' : 'text'}
                  onChange={(e) => setValue(e.target.value)}
                />
              </label>
            )}
            <label>
              <span>Transaction PIN</span>
              <input
                type="password"
                inputMode="numeric"
                autoComplete="off"
                value={pin}
                onChange={(e) => setPin(e.target.value)}
              />
            </label>
          </div>

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
                    setOpen(false);
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
                setValue(setting.value);
                setPin('');
                setOpen(false);
              }}
            >
              Cancel
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
          </div>
          {error !== undefined && <p className="error">{error}</p>}

          {/* THE WHOLE EXPLANATION, here where somebody is deciding — these
              are rows in `platform_settings`, written by the migration that
              introduced each setting. */}
          {setting.description !== '' && <p className="hint">{setting.description}</p>}
          <p className="hint mono">{setting.key} · {setting.type}</p>
        </div>
      )}

      {history !== undefined && open && (
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
