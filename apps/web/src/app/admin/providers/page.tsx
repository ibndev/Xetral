'use client';

import Link from 'next/link';
import { useAdmin, useLoad } from '@/lib/hooks';
import { AdminError } from '../access';

/**
 * Whether the providers are answering.
 *
 * WHAT THIS EXISTS FOR is that every kill switch has to be flipped by hand,
 * which means noticing first — and until now the first reliable signal that a
 * provider had stopped answering was a customer saying so.
 *
 * A REFUSAL IS NOT A FAILURE, and the table says so rather than leaving it to
 * be inferred. A declined card is the provider working; counting it as ill
 * health makes a busy decline rate look like an outage, and an alert that
 * fires on ordinary business is one people mute.
 *
 * NOTHING HERE DISABLES ANYTHING. That is a decision, and the page states it:
 * a flapping provider would switch off a flow nobody meant to stop, and
 * re-enabling needs a person anyway. The switch is one click away on the
 * settings screen and takes seconds — what was missing was never the flipping,
 * it was knowing.
 */
export default function Providers() {
  const admin = useAdmin();
  const health = useLoad(() => admin.providerHealth(), [admin]);

  return (
    <>
      <div className="panel">
        <h1>Providers</h1>
        <p className="lead">
          How every provider has been answering, over the last window. Refusals
          are shown and deliberately not counted as failures — a declined card
          is the provider working.
        </p>
        <AdminError error={health.error} code={health.code} role="support" />
        {health.loading && <p className="spinner">Loading…</p>}
        {health.data !== undefined && health.data.recent.length === 0 && (
          <div className="notice">
            <p>
              No provider calls in the window. That means nothing has been
              called — not that everything is well.
            </p>
            {/*
              Where to go instead, because this screen is named "Providers" and
              an operator arriving on it is usually looking for provider
              CONFIGURATION. Health is recorded from real calls, so on a fresh
              deployment it is empty by definition, and an empty page under
              that name reads as broken rather than as quiet.
            */}
            <p className="hint">
              Keys are pasted on <Link href="/admin/credentials">Provider keys</Link>,
              and a flow is switched off on <Link href="/admin/settings">Settings</Link>.
              This screen only reports what has been observed.
            </p>
          </div>
        )}
      </div>

      {health.data !== undefined && health.data.degraded.length > 0 && (
        <div className="panel">
          <h2 className="danger">Failing</h2>
          <p className="lead">
            Nothing has been switched off. Turning a flow off is a deliberate
            act on the <Link href="/admin/settings">settings</Link> screen, and
            it takes seconds.
          </p>
          <table>
            <thead>
              <tr>
                <th>Provider</th>
                <th>Operation</th>
                <th className="right">Failing</th>
                <th>Last error</th>
              </tr>
            </thead>
            <tbody>
              {health.data.degraded.map((row) => (
                <tr key={`${row.provider}:${row.operation}`}>
                  <td>
                    {row.provider}
                    {row.contract_broken && (
                      <>
                        {' '}
                        <span className="badge danger">contract</span>
                      </>
                    )}
                  </td>
                  <td>{row.operation}</td>
                  <td className="right amount">
                    {row.failure_percent}% of {row.attempts}
                  </td>
                  <td className="muted">{row.last_error ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {health.data.degraded.some((row) => row.contract_broken) && (
            <p className="hint">
              A <strong>contract</strong> failure means the provider replied
              with something the adapter cannot parse — they changed their API.
              The same request will fail for ever, so waiting does not help.
            </p>
          )}
        </div>
      )}

      {health.data !== undefined && health.data.recent.length > 0 && (
        <div className="panel">
          <h2>Everything, including what is fine</h2>
          <table>
            <thead>
              <tr>
                <th>Provider</th>
                <th>Operation</th>
                <th className="right">Calls</th>
                <th className="right">Refused</th>
                <th className="right">Failing</th>
                <th>Last seen</th>
              </tr>
            </thead>
            <tbody>
              {health.data.recent.map((row) => (
                <tr
                  key={`${row.provider}:${row.operation}`}
                  className={row.failure_percent === 0 ? 'muted' : undefined}
                >
                  <td>{row.provider}</td>
                  <td>{row.operation}</td>
                  <td className="right amount">{row.attempts}</td>
                  {/* Shown next to the failure rate on purpose: a high refusal
                      count with a zero failure rate is a fraud or funding
                      story, not an outage. */}
                  <td className="right amount">{row.rejected}</td>
                  <td className="right amount">{row.failure_percent}%</td>
                  <td className="muted">{new Date(row.last_seen).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
