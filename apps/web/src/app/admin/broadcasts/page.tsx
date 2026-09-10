'use client';

import { useEffect, useState } from 'react';
import type { AdminAudienceEstimate, AdminBroadcast } from '@xetral/client';
import { useAdmin, useLoad } from '@/lib/hooks';
import { messageFor } from '@/lib/errors';
import { Select } from '@/ui/select';
import { AdminError } from '../access';

/**
 * TELLING CUSTOMERS SOMETHING, ON THE DEVICE THEY ALREADY CARRY.
 *
 * There was exactly one way to reach a customer and it was EMAIL. 012's outbox
 * is right for a receipt, a reset code or a new-device alert — each about one
 * customer's own account, enqueued by the flow that owed it. What nothing
 * could do was tell everybody something: the app is down for an hour, a new
 * corridor is open. An operator with news had a database and no way to say it.
 *
 * THE AUDIENCE IS SHOWN BEFORE THE BUTTON IS PRESSED, from the same view the
 * worker sends to. Writing to every customer's lock screen at once is not an
 * action to take on a guess about how many that is — and when the number is
 * lower than expected, `customers` against `devices` and the skipped count are
 * what say whether the difference is consent or handsets.
 *
 * EVERY ANNOUNCEMENT IS CONSENT-GATED, and there is deliberately no dropdown
 * that switches that off. A transactional message is about one customer's own
 * transaction and is enqueued by a flow; anything typed into a box and sent to
 * everybody is an announcement whatever it says. A "service" option here is
 * how every message becomes a service message on the afternoon somebody is in
 * a hurry.
 */
export default function Broadcasts() {
  const admin = useAdmin();
  const history = useLoad(() => admin.broadcasts(), [admin]);
  const countries = useLoad(() => admin.countries(), [admin]);

  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [country, setCountry] = useState('');
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [report, setReport] = useState<string | undefined>(undefined);
  const [audience, setAudience] = useState<AdminAudienceEstimate | undefined>(undefined);

  // Re-asked whenever the audience changes, because the number is the whole
  // point of showing it — a stale one is worse than none.
  useEffect(() => {
    let live = true;
    admin
      .broadcastAudience(country === '' ? undefined : country)
      .then((estimate) => {
        if (live) setAudience(estimate);
      })
      .catch(() => {
        if (live) setAudience(undefined);
      });
    return () => {
      live = false;
    };
  }, [admin, country]);

  const tooShort = title.trim().length < 3 || body.trim().length < 3;

  async function send(): Promise<void> {
    setBusy(true);
    setError(undefined);
    setReport(undefined);
    try {
      const queued = await admin.queueBroadcast({
        title: title.trim(),
        body: body.trim(),
        ...(country === '' ? {} : { country }),
        pin,
      });
      setTitle('');
      setBody('');
      // The PIN is deliberately NOT cleared — the argument the prices screen
      // records: a credential re-entered per action is one people find a way
      // to stop re-entering. It is component state and goes when the page does.
      setReport(
        `Queued for ${queued.country ?? 'every country'}. The worker sends it ` +
          `within a minute; this list shows what actually happened.`,
      );
      history.reload();
    } catch (caught) {
      setError(messageFor(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="panel">
        <h1>Announcements</h1>
        <p className="lead">
          A notification on every customer’s phone. Only customers who have
          opted in to product news are included — security and transaction
          messages are unaffected and are sent by the flows that owe them.
        </p>

        <label>
          Who
          <Select
            value={country}
            onChange={setCountry}
            options={[
              { value: '', label: 'Every country' },
              ...(countries.data?.countries ?? []).map((row) => ({
                value: row.code,
                label: row.name,
              })),
            ]}
          />
        </label>

        {/*
          The estimate, before the button. `customers` beside `devices` is what
          says whether a small number is few people or few handsets.
        */}
        <div className="row">
          <span className="muted">Will reach</span>
          <span>
            {audience === undefined
              ? '—'
              : `${audience.devices} device${audience.devices === 1 ? '' : 's'} · ` +
                `${audience.customers} customer${audience.customers === 1 ? '' : 's'}`}
          </span>
        </div>

        <label>
          Title
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={80}
            placeholder="Scheduled maintenance"
          />
          <span className="hint">
            {80 - title.length} characters left. Phones truncate long titles on
            a lock screen.
          </span>
        </label>

        <label>
          Message
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            maxLength={240}
            rows={3}
            placeholder="Xetral will be briefly unavailable tonight from 11pm."
          />
          <span className="hint">
            {240 - body.length} characters left. No balances or amounts — a
            notification is read off a lock screen by anybody holding the phone.
          </span>
        </label>

        <label>
          Transaction PIN
          <input
            type="password"
            inputMode="numeric"
            autoComplete="off"
            value={pin}
            onChange={(e) => setPin(e.target.value)}
          />
        </label>

        <button
          type="button"
          disabled={busy || tooShort || pin === '' || (audience?.devices ?? 0) === 0}
          onClick={() => void send()}
        >
          {busy ? 'Queueing…' : 'Send announcement'}
        </button>

        {/*
          Said on the page rather than in a tooltip, which does not exist on a
          touch screen — the lesson the rate-generation button records.
        */}
        {(audience?.devices ?? 0) === 0 && (
          <p className="hint">
            Nobody to tell: no customer in this audience has both the app
            installed and product news switched on.
          </p>
        )}

        {error !== undefined && <p className="error">{error}</p>}
        {report !== undefined && <p className="ok">{report}</p>}
      </div>

      <div className="panel">
        <h2>Sent</h2>
        <AdminError error={history.error} code={history.code} role="support" />
        {history.loading && <p className="spinner">Loading…</p>}

        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Announcement</th>
                <th>Who</th>
                <th className="right">Devices</th>
                <th className="right">Delivered</th>
                <th className="right">Skipped</th>
              </tr>
            </thead>
            <tbody>
              {(history.data ?? []).map((row: AdminBroadcast) => (
                <tr key={row.uuid}>
                  <td>{new Date(row.created_at).toLocaleString()}</td>
                  <td>
                    <strong>{row.title}</strong>
                    <br />
                    <span className="muted">{row.body}</span>
                  </td>
                  <td>{row.country ?? 'Everywhere'}</td>
                  <td className="right">
                    {/*
                      Queued is a real state and not a zero. `sent_at IS NULL`
                      is the whole state machine, and a row that reads "0
                      devices" where it should read "not sent yet" is how a
                      worker nobody started looks like a broadcast nobody
                      could receive.
                    */}
                    {row.sent_at === null ? 'queued' : row.devices}
                  </td>
                  <td className="right">
                    {row.sent_at === null
                      ? '—'
                      : `${row.accepted}${row.rejected > 0 ? ` (${row.rejected} failed)` : ''}`}
                  </td>
                  <td className="right">{row.sent_at === null ? '—' : row.without_consent}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <p className="hint">
          <strong>Skipped</strong> counts customers with the app installed who
          have not opted in to product news. If announcements stay “queued”, no
          instance has <code>PUSH_BROADCAST_INTERVAL_SECONDS</code> set — the
          row is written and nothing is ever sent, and nothing errors.
        </p>
      </div>
    </>
  );
}
