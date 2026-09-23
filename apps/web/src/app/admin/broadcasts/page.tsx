'use client';

import { useEffect, useState } from 'react';
import type { AdminAudienceEstimate, AdminBroadcast } from '@xetral/client';
import { useAdmin, useLoad } from '@/lib/hooks';
import { messageFor } from '@/lib/errors';
import { Select } from '@/ui/select';
import { AdminError } from '../access';
import { AdminTitle } from '@/app/admin/nav';
import { ageSince } from '../age';

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
      <AdminTitle>Announcements</AdminTitle>
      <div className="panel announce">
        <span className="sec">New announcement</span>
        <p className="sub">
          To every customer who has opted in to product news. Security and transaction messages are
          sent by the flows that owe them, never from here.
        </p>

        <label>
          <span>Title</span>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={80}
            placeholder="Scheduled maintenance"
          />
          <span className="hint">{80 - title.length} left — phones truncate long titles on a lock screen.</span>
        </label>

        <label>
          <span>Message</span>
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            maxLength={240}
            rows={3}
            placeholder="Kept short — push copy carries no amount, ever."
          />
          <span className="hint">
            {240 - body.length} left. No balances or amounts — a notification is read off a lock
            screen by anybody holding the phone.
          </span>
        </label>

        {/* THE COMP'S SEND ROW: who, how many that is, and the button — the
            estimate sits BESIDE the audience it describes, before anything is
            pressed. `customers` beside `devices` is what says whether a small
            number is few people or few handsets. */}
        <div className="announce-send">
          <span className="announce-who">
            <span className="tbl-inline">Audience</span>
            <Select
              value={country}
              onChange={setCountry}
              options={[
                { value: '', label: 'All customers' },
                ...(countries.data?.countries ?? []).map((row) => ({ value: row.code, label: row.name })),
              ]}
            />
            <span className="quiet-text">
              {audience === undefined
                ? ''
                : `${audience.devices} device${audience.devices === 1 ? '' : 's'} · ` +
                  `${audience.customers} customer${audience.customers === 1 ? '' : 's'}`}
            </span>
          </span>
          <input
            className="tbl-pin"
            type="password"
            inputMode="numeric"
            autoComplete="off"
            aria-label="Transaction PIN"
            placeholder="PIN"
            value={pin}
            onChange={(e) => setPin(e.target.value)}
          />
          <button
            type="button"
            disabled={busy || tooShort || pin === '' || (audience?.devices ?? 0) === 0}
            onClick={() => void send()}
          >
            {busy ? 'Queueing…' : 'Send announcement'}
          </button>
        </div>

        {/* Said on the page rather than in a tooltip, which does not exist on
            a touch screen — the lesson the rate-generation button records. */}
        {(audience?.devices ?? 0) === 0 && (
          <p className="hint">
            Nobody to tell: no customer in this audience has both the app installed and product news
            switched on.
          </p>
        )}
        {error !== undefined && <p className="error">{error}</p>}
        {report !== undefined && <p className="ok">{report}</p>}
      </div>

      <div className="panel tbl-panel">
        <div className="tbl-head">
          <span className="sec">Sent</span>
        </div>
        <AdminError error={history.error} code={history.code} role="support" />
        {history.loading && <p className="spinner">Loading…</p>}
        {history.data !== undefined && history.data.length === 0 && <p className="empty">Nothing sent yet.</p>}

        {(history.data?.length ?? 0) > 0 && (
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>Title</th>
                  <th>Audience</th>
                  <th className="r">Reach</th>
                  <th className="r">Skipped</th>
                  <th className="r">When</th>
                </tr>
              </thead>
              <tbody>
                {(history.data ?? []).map((row: AdminBroadcast) => (
                  <tr key={row.uuid}>
                    <td>
                      <strong>{row.title}</strong>
                      <div className="cell-sub">{row.body}</div>
                    </td>
                    <td className="quiet">{row.country ?? 'All customers'}</td>
                    {/* QUEUED IS A REAL STATE AND NOT A ZERO. `sent_at IS NULL`
                        is the whole state machine, and "0" where it should
                        read "not sent yet" is how a worker nobody started
                        looks like a broadcast nobody could receive. */}
                    <td className="r mono">
                      {row.sent_at === null ? (
                        <span className="badge warn">queued</span>
                      ) : (
                        <>
                          {row.accepted}
                          {row.rejected > 0 && <span className="cell-sub">{row.rejected} failed</span>}
                        </>
                      )}
                    </td>
                    <td className="r mono quiet">{row.sent_at === null ? '—' : row.without_consent}</td>
                    <td className="r quiet nowrap">{ageSince(row.created_at)} ago</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <span className="tbl-note">
          Skipped counts customers with the app installed who have not opted in to product news. If
          one stays queued, no instance has PUSH_BROADCAST_INTERVAL_SECONDS set — nothing errors.
        </span>
      </div>
    </>
  );
}
