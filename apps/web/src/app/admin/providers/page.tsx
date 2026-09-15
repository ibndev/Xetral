'use client';

import Link from 'next/link';
import { formatMinor } from '@xetral/client';
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
          How every provider has been answering. Refusals are shown and not counted
          as failures.
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
              Keys go on <Link href="/admin/credentials">Provider keys</Link>; flows
              are switched off on <Link href="/admin/settings">Settings</Link>.
            </p>
          </div>
        )}
      </div>

      {health.data !== undefined && health.data.degraded.length > 0 && (
        <div className="panel">
          <h2 className="danger">Failing</h2>
          <p className="lead">
            Nothing has been switched off. Flows are turned off on{' '}
            <Link href="/admin/settings">Settings</Link>.
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
              A <strong>contract</strong> failure means they changed their API. It
              will not resolve on its own.
            </p>
          )}
        </div>
      )}

      {health.data !== undefined && health.data.float.length > 0 && (
        <div className="panel">
          <h2>What we hold at our providers</h2>
          <p className="lead">
            Flutterwave is a prefunded wallet: a cedi payout spends a cedi
            balance we have to put there first. A corridor with nothing in it
            refuses every transfer, and until now that refusal reached the
            customer as a message about their own account.
          </p>
          <table>
            <thead>
              <tr>
                <th>Currency</th>
                <th className="right">Held</th>
                <th className="right">Committed</th>
                <th className="right">Available</th>
                <th>Last movement</th>
              </tr>
            </thead>
            <tbody>
              {health.data.float.map((row) => (
                <tr key={row.currency} className={row.short ? undefined : 'muted'}>
                  <td>
                    {row.currency}{' '}
                    {row.short && <span className="badge danger">short</span>}
                  </td>
                  {/*
                    `formatMinor` and never `formatAmount`. The two look
                    identical at a call site and differ by a factor of a
                    hundred — `formatAmount` takes MAJOR units and every figure
                    here is `*_minor`. That is exactly the error that had the
                    compliance queue rendering ₦500,000,000 for a ₦5,000,000
                    transfer.
                  */}
                  <td className="right amount">
                    {formatMinor(row.held_minor, row.currency)}
                  </td>
                  <td className="right amount">
                    {formatMinor(row.committed_minor, row.currency)}
                  </td>
                  <td className="right amount">
                    {formatMinor(row.available_minor, row.currency)}
                  </td>
                  <td className="muted">
                    {row.last_movement_at === null
                      ? '—'
                      : new Date(row.last_movement_at).toLocaleString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {health.data.float.some((row) => row.short) && (
            <p className="hint">
              A currency marked <strong>short</strong> has payouts reserved
              against it that it cannot cover. Send the provider more of that
              currency — payouts on it are refused until you do, deliberately,
              because the alternative is the provider refusing them afterwards
              with a message that reads as the customer&rsquo;s fault.
            </p>
          )}
        </div>
      )}

      {health.data !== undefined && health.data.nameEnquiry.length > 0 && (
        <div className="panel">
          <h2>Recipient names that could not be confirmed</h2>
          <p className="lead">
            A rail that cannot name a recipient refuses every send on that
            corridor, and the customer is told to check a number that is
            correct. This is the provider&rsquo;s own reason.
          </p>
          <table>
            <thead>
              <tr>
                <th>Rail</th>
                <th className="right">Refusals</th>
                <th>Key</th>
                <th>What the provider said</th>
              </tr>
            </thead>
            <tbody>
              {health.data.nameEnquiry.map((row) => (
                <tr key={`${row.provider}:${row.country}:${row.rail_code}`}>
                  <td>
                    {row.provider} &middot; {row.country} {row.rail_code}
                  </td>
                  <td className="right amount">{row.refusals}</td>
                  <td>
                    {/*
                      THE FIELD MOST LIKELY TO ANSWER THE WHOLE THING.
                      Flutterwave's sandbox cannot verify a real account —
                      their own documentation says only test accounts resolve
                      in test mode — so a deployment on a test key refuses
                      every genuine number, correctly, for a reason that has
                      nothing to do with the number.
                    */}
                    {row.key_mode === 'test' ? (
                      <span className="badge danger">test key</span>
                    ) : row.key_mode === 'unset' ? (
                      <span className="badge danger">no key</span>
                    ) : (
                      <span className="muted">{row.key_mode}</span>
                    )}
                  </td>
                  <td className="muted">
                    {row.last_message}
                    <br />
                    <span className="hint">{row.last_tried}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {health.data.nameEnquiry.some((row) => row.key_mode === 'test') && (
            <p className="hint">
              A <strong>test key</strong> cannot verify a real account at all.
              Paste the live secret key on{' '}
              <Link href="/admin/credentials">Provider keys</Link> — until then
              every correct number on that corridor is refused.
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
