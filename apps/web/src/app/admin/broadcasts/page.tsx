'use client';

import { useEffect, useState } from 'react';
import type { AdminAudienceEstimate, AdminBroadcast } from '@xetral/client';
import { useAdmin, useLoad } from '@/lib/hooks';
import { messageFor } from '@/lib/errors';
import { Select } from '@/ui/select';
import { AdminError } from '../access';
import { AdminTitle } from '@/app/admin/nav';
import { ageSince, ago } from '../age';

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
  // NOW OR LATER. Later is a local date and time in the operator's own zone,
  // converted to an instant before it leaves the page — the API takes ISO with
  // an offset, so the dashboard's timezone decides nothing on the server.
  const [when, setWhen] = useState<'now' | 'later'>('now');
  const [at, setAt] = useState('');
  const [cancelling, setCancelling] = useState<string | undefined>(undefined);

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
  const laterAt = when === 'later' && at !== '' ? new Date(at) : undefined;
  const laterInvalid =
    when === 'later' &&
    (laterAt === undefined || Number.isNaN(laterAt.getTime()) || laterAt.getTime() <= Date.now());

  async function cancel(uuid: string): Promise<void> {
    setCancelling(uuid);
    setError(undefined);
    try {
      await admin.cancelBroadcast(uuid);
      setReport('Cancelled. It will not go out.');
      history.reload();
    } catch (caught) {
      setError(messageFor(caught));
    } finally {
      setCancelling(undefined);
    }
  }

  async function send(): Promise<void> {
    setBusy(true);
    setError(undefined);
    setReport(undefined);
    try {
      const queued = await admin.queueBroadcast({
        title: title.trim(),
        body: body.trim(),
        ...(country === '' ? {} : { country }),
        ...(laterAt === undefined ? {} : { sendAt: laterAt.toISOString() }),
        pin,
      });
      setTitle('');
      setBody('');
      // The PIN is deliberately NOT cleared — the argument the prices screen
      // records: a credential re-entered per action is one people find a way
      // to stop re-entering. It is component state and goes when the page does.
      setAt('');
      setWhen('now');
      setReport(
        Date.parse(queued.send_at) > Date.now()
          ? `Scheduled for ${new Date(queued.send_at).toLocaleString()}. ` +
              `It appears in customers' notifications then, and can be cancelled until it does.`
          : `Sent to ${queued.country ?? 'every country'}. It is in customers' notifications now; ` +
              `phones with push are reached next.`,
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
        {/* THE EXPLANATIONS ARE ONE TAP AWAY, not on the form. The owner's
            call: the counters and the lock-screen warning stay, the
            paragraphs go behind the help button. A <details> rather than a
            tooltip, because a tooltip does not exist on a touch screen. */}
        <details className="announce-help">
          <summary aria-label="How announcements work">?</summary>
          <p>
            Every customer in the audience sees it in the app&rsquo;s notification feed. It also goes
            by push to phones whose owner has the app installed and product news switched on.
            Security and transaction messages are sent by the flows that owe them, never from here.
          </p>
          <p>
            &ldquo;In the app&rdquo; means customers can read it now. Push reaches phones with the app
            installed and product news switched on; &ldquo;no phones&rdquo; means no handset has
            registered yet. A scheduled announcement can be cancelled until its time comes.
          </p>
        </details>

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
          <span className="hint">{240 - body.length} left. No amounts — it shows on a lock screen.</span>
        </label>

        {/* WHEN. Two answers, so a segmented pair rather than a picker; the
            date only appears once "Later" is chosen. */}
        <div className="announce-when">
          <span className="tbl-inline">When</span>
          <div className="segmented" role="radiogroup" aria-label="When">
            {(['now', 'later'] as const).map((option) => (
              <button
                key={option}
                type="button"
                role="radio"
                aria-checked={when === option}
                className={when === option ? 'active' : ''}
                onClick={() => setWhen(option)}
              >
                {option === 'now' ? 'Now' : 'Later'}
              </button>
            ))}
          </div>
          {when === 'later' && (
            <input
              type="datetime-local"
              aria-label="Send at"
              value={at}
              min={localNow()}
              onChange={(e) => setAt(e.target.value)}
            />
          )}
        </div>

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
                : `${audience.in_app} customer${audience.in_app === 1 ? '' : 's'} in the app · ` +
                  `${audience.devices} phone${audience.devices === 1 ? '' : 's'} by push`}
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
            disabled={busy || tooShort || laterInvalid || pin === '' || (audience?.in_app ?? 0) === 0}
            onClick={() => void send()}
          >
            {busy ? 'Saving…' : when === 'later' ? 'Schedule announcement' : 'Send announcement'}
          </button>
        </div>

        {error !== undefined && <p className="error">{error}</p>}
        {report !== undefined && <p className="ok">{report}</p>}
      </div>

      <div className="panel tbl-panel">
        <div className="tbl-head">
          <span className="sec">Announcements</span>
        </div>
        <AdminError error={history.error} code={history.code} role="support" />
        {history.loading && <p className="spinner">Loading…</p>}
        {history.data !== undefined && history.data.length === 0 && <p className="empty">Nothing sent yet.</p>}

        {(history.data?.length ?? 0) > 0 && (
          <div className="scroll">
            <table className="announce-table">
              <thead>
                <tr>
                  <th>Title</th>
                  <th>Audience</th>
                  <th>Status</th>
                  <th className="r">Push</th>
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
                    <td className="quiet nowrap">{row.country ?? 'All customers'}</td>
                    {/* IN THE APP IS THE DELIVERY; PUSH IS A SECOND CHANNEL.
                        It said "queued" beside an announcement every customer
                        could already read, because the only state shown was
                        the push worker's. The feed shows a row the moment it
                        is due, whatever the push has done. */}
                    <td>
                      <BroadcastStatus
                        row={row}
                        cancelling={cancelling === row.uuid}
                        onCancel={() => void cancel(row.uuid)}
                      />
                    </td>
                    <td className="r quiet nowrap">
                      <PushCell row={row} />
                    </td>
                    <td className="r quiet nowrap">
                      {ago(row.send_at)}
                      {Date.parse(row.send_at) > Date.now() && row.cancelled_at === null && (
                        <span className="cell-sub">
                          {new Date(row.send_at).toLocaleString(undefined, {
                            weekday: 'short',
                            hour: '2-digit',
                            minute: '2-digit',
                          })}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}

/** Where an announcement is: waiting, called back, or in customers' feeds. */
function BroadcastStatus({
  row,
  cancelling,
  onCancel,
}: {
  row: AdminBroadcast;
  cancelling: boolean;
  onCancel: () => void;
}) {
  if (row.cancelled_at !== null) return <span className="badge">cancelled</span>;
  if (Date.parse(row.send_at) > Date.now()) {
    return (
      <span className="announce-scheduled">
        <span className="badge info">scheduled</span>
        <button type="button" className="ghost small" disabled={cancelling} onClick={onCancel}>
          {cancelling ? 'Cancelling…' : 'Cancel'}
        </button>
      </span>
    );
  }
  return <span className="badge ok">in the app</span>;
}

/**
 * What the push did. "No phones" is its own answer rather than a zero: until
 * the app is built with an EAS project and FCM credentials no handset can
 * register, and a "0" there reads as a broken send.
 */
function PushCell({ row }: { row: AdminBroadcast }) {
  if (row.cancelled_at !== null || Date.parse(row.send_at) > Date.now()) return <>—</>;
  if (row.sent_at === null) return <span className="badge warn">sending</span>;
  if (row.devices === 0) return <>no phones</>;
  return (
    <>
      {row.accepted} of {row.devices}
      {row.without_consent > 0 && <span className="cell-sub">{row.without_consent} opted out</span>}
    </>
  );
}

/** Now, as a `datetime-local` value in the operator's own zone. */
function localNow(): string {
  const now = new Date();
  now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
  return now.toISOString().slice(0, 16);
}
