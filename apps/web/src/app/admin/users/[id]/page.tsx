'use client';

import { use, useState } from 'react';
import { formatMinor } from '@xetral/client';
import Link from 'next/link';
import { useAdmin, useLoad } from '@/lib/hooks';
import { messageFor } from '@/lib/errors';
import { AdminError } from '../../access';
import { Select } from '@/ui/select';

/**
 * One customer, and the two things support actually needs to do: see what is
 * going on, and stop it.
 *
 * FREEZING DOES NOT TOUCH BALANCES, and the page says so where an operator
 * will read it. The money stays the customer's and stays owed to them;
 * freezing stops it moving. Conflating the two is how a support action becomes
 * a seizure, and an operator who believes freezing takes the money will use it
 * differently from one who knows it does not.
 */
export default function UserDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const admin = useAdmin();
  const detail = useLoad(() => admin.user(id), [admin, id]);
  const [copied, setCopied] = useState(false);

  function copyId(): void {
    // Best effort. `navigator.clipboard` is unavailable over plain HTTP and
    // in some embedded browsers, and a support screen must not throw because
    // somebody tapped an id.
    void navigator.clipboard?.writeText(id).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1600);
      },
      () => undefined,
    );
  }

  const profile = (detail.data?.profile ?? {}) as Record<string, string>;
  const balances = detail.data?.balances ?? [];
  const devices = detail.data?.devices ?? [];
  const history = detail.data?.status_history ?? [];
  const cards = detail.data?.cards ?? [];
  const tier = profile['kyc_tier'] ?? '0';

  return (
    <>
      <div className="panel">
        <h1>{profile['account_name'] ?? profile['full_name'] ?? profile['email'] ?? 'Customer'}</h1>
        <h2>
          <Link href="/admin/users">← All customers</Link>
        </h2>

        {detail.loading && <p className="spinner">Loading…</p>}
        <AdminError error={detail.error} code={detail.code} role="support" />

        <div className="row">
          <span className="muted">Status</span>
          <span className={`badge ${profile['status'] === 'active' ? 'ok' : 'warn'}`}>
            {profile['status'] ?? '—'}
          </span>
        </div>
        {/*
          WHO THIS IS, which the page did not say. It opened with an email
          address and went straight to balances, so an operator on a call had
          no name to confirm, no number to check against the one calling them,
          and no handle to match a payment link against.

          `account_name` is what the customer typed about themselves.
          `full_name` below it is what a reviewer read off a document, and it
          is the only one any money decision may read — 040 keeps them apart,
          so this page shows both and labels which is which.
        */}
        <div className="row">
          <span className="muted">Name on the account</span>
          <span>{profile['account_name'] ?? <span className="muted">not set</span>}</span>
        </div>
        {profile['full_name'] !== undefined && profile['full_name'] !== null && (
          <div className="row">
            <span className="muted">Verified name</span>
            <span>{profile['full_name']}</span>
          </div>
        )}
        <div className="row">
          <span className="muted">Email</span>
          <span>{profile['email'] ?? <span className="muted">not set</span>}</span>
        </div>
        <div className="row">
          <span className="muted">Phone</span>
          <span className="mono">
            {profile['account_phone'] ?? profile['phone'] ?? (
              <span className="muted">not set</span>
            )}
          </span>
        </div>
        <div className="row">
          <span className="muted">Handle</span>
          <span className="mono">
            {profile['handle'] === undefined || profile['handle'] === null ? (
              <span className="muted">none claimed</span>
            ) : (
              `@${profile['handle']}`
            )}
          </span>
        </div>
        <div className="row">
          <span className="muted">Country</span>
          <span>{profile['country'] ?? <span className="muted">not set</span>}</span>
        </div>
        {/*
          THE SHORT FORM, WITH THE WHOLE THING ON DEMAND.

          A UUID is thirty-six characters and on this row it was wider than
          every other value on the page, so the one line an operator reads
          most — the name, the email, the phone — sat under a wall of hex.

          The first eight characters of a v4 UUID are thirty-two random bits.
          That is plenty to say "the customer you are looking at" in a ticket
          or across a desk, and it is NOT an identifier anything accepts: the
          API takes the full UUID, so a short form cannot be pasted somewhere
          it would match the wrong person. Whoever needs the real one opens
          the row and copies it.
        */}
        <div className="row">
          <span className="muted">Customer id</span>
          <span className="mono" title={id} style={{ cursor: 'pointer' }} onClick={copyId}>
            {copied ? 'copied' : `${id.slice(0, 8)}…`}
          </span>
        </div>
        <div className="row">
          <span className="muted">Joined</span>
          <span>
            {profile['created_at'] === undefined
              ? '—'
              : new Date(profile['created_at']).toLocaleString()}
          </span>
        </div>
      </div>

      <Transactions id={id} />

      <div className="grid two">
        <div className="panel">
          <h2>Balances</h2>
          {balances.length === 0 && <p className="empty">Nothing yet.</p>}
          {balances.map((balance, index) => {
            const row = balance as Record<string, string>;
            return (
              <div className="row" key={index}>
                <span>{row['currency']}</span>
                <span className="amount">{row['balance'] ?? row['amount_minor']}</span>
              </div>
            );
          })}
        </div>

        <div className="panel">
          <h2>Devices</h2>
          {devices.length === 0 && <p className="empty">None.</p>}
          {devices.map((device, index) => {
            const row = device as Record<string, string | null>;
            return (
              <div className="row" key={index}>
                <span>
                  {row['platform']}
                  <div className="hint mono">{String(row['fingerprint']).slice(0, 16)}…</div>
                </span>
                <span className={`badge ${row['revoked_at'] === null ? 'ok' : 'danger'}`}>
                  {row['revoked_at'] === null ? 'active' : 'revoked'}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      {/*
        THE CARDS, which this screen could not show at all. A customer ringing
        about a declined card was a conversation nobody on this side could
        follow: no status, no history, and no way to tell whether the card had
        been frozen or by whom.

        Four digits of the number and no more — the same amount the database
        stores, and this panel is read over shoulders and screenshotted into
        tickets.
      */}
      <div className="panel">
        <h2>
          Cards <span className="badge">tier {tier}</span>
        </h2>
        {cards.length === 0 && <p className="empty">None issued.</p>}
        {cards.map((card, index) => {
          const row = card as Record<string, string | number | null>;
          return (
            <CardRow key={index} card={row} onChanged={detail.reload} />
          );
        })}
      </div>

      <ChangeStatus id={id} current={profile['status'] ?? 'active'} onChanged={detail.reload} />

      <div className="panel">
        <h2>Status history</h2>
        {history.length === 0 && <p className="empty">Never changed.</p>}
        {history.map((change, index) => {
          const row = change as Record<string, string>;
          return (
            <div className="row" key={index}>
              <span>
                {row['from_status']} → {row['to_status']}
                <div className="hint">{row['reason']}</div>
              </span>
              <span className="muted nowrap">
                {row['changed_by']}
                <div className="hint">{new Date(row['created_at'] ?? '').toLocaleString()}</div>
              </span>
            </div>
          );
        })}
      </div>
    </>
  );
}

function ChangeStatus({
  id,
  current,
  onChanged,
}: {
  id: string;
  current: string;
  onChanged: () => void;
}) {
  const admin = useAdmin();
  const [status, setStatus] = useState<'active' | 'frozen' | 'closed'>('frozen');
  const [reason, setReason] = useState('');
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [done, setDone] = useState<string | undefined>();

  return (
    <form
      className="panel"
      onSubmit={(event) => {
        event.preventDefault();
        setBusy(true);
        setError(undefined);
        setDone(undefined);
        void (async () => {
          try {
            await admin.setUserStatus(id, status, reason, pin);
            setPin('');
            setReason('');
            setDone(DONE[status] ?? `Account is now ${status}.`);
            onChanged();
          } catch (cause) {
            setError(messageFor(cause));
          } finally {
            setBusy(false);
          }
        })();
      }}
    >
      <h2>Suspend or delete this account</h2>

      <div className="notice">
        <p>
          Suspending stops money moving. It does <strong>not</strong> touch the
          balance — the money stays theirs and stays owed to them.
        </p>
        <p className="hint">
          Both actions revoke every live session, so they take effect
          immediately rather than at the next sign-in. Deleting is final and
          keeps the record: AML requires five years of it, and the customer&apos;s
          own right to erasure is a separate request with a person deciding.
        </p>
      </div>

      <div className="field-row two">
        <label id="user-status">
          New status
          <Select
            labelledBy="user-status"
            value={status}
            onChange={(value) => setStatus(value as 'active' | 'frozen' | 'closed')}
            /*
             * THE OPERATOR'S WORDS, OVER THE DATABASE'S.
             *
             * "Suspend" and "delete" are what somebody comes to this screen
             * intending to do; `frozen` and `closed` are what `user_status`
             * calls them. They were the only labels here, so the two actions
             * support is asked for most often read as jargon and looked
             * absent — and the operations they name are not obvious from the
             * words: freezing does NOT take the money, and closing does not
             * remove the record.
             *
             * The stored values are unchanged. Renaming the enum would
             * rewrite what every past `user_status_changes` row is recorded
             * as, which is the gift card rate card lesson applied to a
             * compliance trail.
             */
            options={[
              { value: 'active', label: 'Active', hint: 'Can sign in and move money' },
              {
                value: 'frozen',
                label: 'Suspended (frozen)',
                hint: 'Signs out every session. The money stays theirs.',
              },
              {
                value: 'closed',
                label: 'Deleted (closed)',
                hint: 'Final. The record is kept — AML requires five years.',
              },
            ]}
          />
          <span className="hint">Currently {current}.</span>
        </label>

        <label>
          Your transaction PIN
          <input
            type="password"
            inputMode="numeric"
            autoComplete="off"
            value={pin}
            onChange={(e) => setPin(e.target.value)}
            required
          />
          <span className="hint">
            So an unlocked laptop is not the ability to freeze accounts.
          </span>
        </label>
      </div>

      <label>
        Why
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          required
          minLength={3}
        />
        <span className="hint">
          Required by the database, not just by this form. An operator who
          cannot say why should not be doing this.
        </span>
      </label>

      <button type="submit" className={status === 'active' ? undefined : 'danger'} disabled={busy}>
        {busy ? 'Working…' : LABEL[status]}
      </button>

      {error !== undefined && <p className="error">{error}</p>}
      {done !== undefined && <p className="ok">{done}</p>}
    </form>
  );
}

/**
 * What the button says, in the words the operator chose it with.
 *
 * "Set to closed" is a sentence about a column. Deleting an account is
 * irreversible and moves nothing, and a button that says so is the last place
 * somebody can notice they picked the wrong one.
 */
const DONE: Readonly<Record<string, string>> = {
  active: 'This account is active again.',
  frozen: 'This account is suspended. Every session has been signed out.',
  closed: 'This account is deleted. The record is kept.',
};

const LABEL: Readonly<Record<string, string>> = {
  active: 'Restore this account',
  frozen: 'Suspend this account',
  closed: 'Delete this account',
};

/**
 * One card, with its history on demand and a freeze an agent can actually
 * reach.
 *
 * FREEZE AND NOT TERMINATE. Freezing stops spending and the customer can undo
 * it; terminating moves their money and cannot be undone, and there is no
 * support conversation in which doing that without them is right. The API
 * agrees — there is no staff terminate endpoint to call.
 */
function CardRow({
  card,
  onChanged,
}: {
  card: Record<string, string | number | null>;
  onChanged: () => void;
}) {
  const admin = useAdmin();
  const id = String(card['id']);
  const status = String(card['status']);

  const [events, setEvents] = useState<readonly Record<string, string>[] | undefined>();
  const [reason, setReason] = useState('');
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  return (
    <div style={{ borderBottom: '1px solid var(--line)', paddingBottom: 12, marginBottom: 12 }}>
      <div className="row">
        <span>
          <span className="mono">•••• {String(card['last4'] ?? '????')}</span>{' '}
          <span className="hint">{String(card['currency'])}</span>
          {card['replaces_card_id'] !== null && (
            <div className="hint">Replaced an earlier card.</div>
          )}
          {card['replaced_by_card_id'] !== null && (
            <div className="hint">Replaced by a newer card.</div>
          )}
        </span>
        <span className={`badge ${status === 'active' ? 'ok' : status === 'terminated' ? 'danger' : 'warn'}`}>
          {status}
        </span>
      </div>

      <div className="actions">
        <button
          type="button"
          className="ghost small"
          onClick={() => {
            void (async () => {
              try {
                const detail = await admin.card(id);
                setEvents((detail['events'] ?? []) as Record<string, string>[]);
              } catch (cause) {
                setError(messageFor(cause));
              }
            })();
          }}
        >
          History
        </button>
      </div>

      {events !== undefined && (
        <div className="scroll" style={{ marginTop: 8 }}>
          <table>
            <tbody>
              {events.map((event, index) => (
                <tr key={index}>
                  <td className="mono">{event['kind']}</td>
                  <td>{new Date(event['created_at'] ?? '').toLocaleString()}</td>
                  <td className="hint">
                    {event['actor'] === 'system'
                      ? 'automatic'
                      : (event['actor_email'] ?? event['actor'])}
                  </td>
                  <td className="hint">{event['reason'] ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {status !== 'terminated' && status !== 'frozen' && (
        <div style={{ marginTop: 8 }}>
          <label>
            Freeze this card — why?
            <input
              value={reason}
              placeholder="e.g. customer reports charges they did not make"
              onChange={(e) => setReason(e.target.value)}
            />
          </label>
          {reason.trim() !== '' && (
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
              disabled={reason.trim().length < 5 || pin === '' || busy}
              onClick={() => {
                setBusy(true);
                setError(undefined);
                void (async () => {
                  try {
                    await admin.freezeCard(id, reason, pin);
                    setReason('');
                    setPin('');
                    onChanged();
                  } catch (cause) {
                    setError(messageFor(cause));
                  } finally {
                    setBusy(false);
                  }
                })();
              }}
            >
              {busy ? 'Freezing…' : 'Freeze'}
            </button>
            <span className="hint">
              Stops spending. The customer can unfreeze it themselves.
            </span>
          </div>
          {error !== undefined && <p className="error">{error}</p>}
        </div>
      )}
    </div>
  );
}

/**
 * WHAT ACTUALLY HAPPENED IN THIS ACCOUNT.
 *
 * THE GAP THIS CLOSES. This page showed balances, devices, cards, status
 * changes and tier changes — everything ABOUT an account and nothing that
 * happened IN it. So the question support is asked most often ("they say a
 * transfer did not arrive") could be answered only by asking the customer to
 * read their own screen back, or by somebody opening psql against the
 * production database that holds every customer's money.
 *
 * WIDER THAN THE CUSTOMER'S OWN HISTORY, deliberately. A customer's statement
 * shows one currency and only the wallet leg, because that is a statement. An
 * operator is looking at the whole account, and money sitting in
 * `customer_pending` against a card authorization or a gift card hold is
 * exactly what a "missing" balance turns out to be — hiding it would send
 * somebody looking for a bug in the ledger.
 *
 * FILTERED, NOT SEARCHED. A free-text box over somebody's transactions is a
 * query nobody has read reaching a table of postings; two closed dropdowns
 * answer the questions actually asked and cannot express anything else.
 */
function Transactions({ id }: { readonly id: string }) {
  const admin = useAdmin();
  const [currency, setCurrency] = useState('');
  const [kind, setKind] = useState('');
  /** Keyset, on the posting id. `OFFSET` shifts under an active account and
   *  produces duplicates and gaps, which reads as money appearing. */
  const [before, setBefore] = useState<string | undefined>(undefined);

  const rows = useLoad(
    () =>
      admin.userTransactions(id, {
        ...(currency === '' ? {} : { currency }),
        ...(kind === '' ? {} : { kind }),
        ...(before === undefined ? {} : { before }),
        limit: 50,
      }),
    [admin, id, currency, kind, before],
  );

  function reset(change: () => void): void {
    setBefore(undefined);
    change();
  }

  const last = rows.data?.[rows.data.length - 1];

  return (
    <div className="panel">
      <h2>Transactions</h2>

      <div className="actions" style={{ marginBottom: 16 }}>
        <div style={{ flex: '0 1 170px' }}>
          <Select
            value={currency}
            onChange={(value) => reset(() => setCurrency(value))}
            placeholder="Any currency"
            options={[
              { value: '', label: 'Any currency' },
              { value: 'NGN', label: 'NGN' },
              { value: 'USD', label: 'USD' },
              { value: 'USDT', label: 'USDT' },
              { value: 'USDC', label: 'USDC' },
              { value: 'BTC', label: 'BTC' },
            ]}
          />
        </div>
        <div style={{ flex: '0 1 210px' }}>
          {/*
            The kinds an operator is asked about, not all eighteen. The full
            enum lives in Postgres and a new kind arrives with a migration, so
            a complete list here would be one more thing to keep in step —
            and an unrecognised value is a query parameter that matches
            nothing rather than something reaching the SQL.
          */}
          <Select
            value={kind}
            onChange={(value) => reset(() => setKind(value))}
            placeholder="Anything"
            options={[
              { value: '', label: 'Anything' },
              { value: 'wallet_funding', label: 'Money in' },
              { value: 'wallet_transfer', label: 'Transfers' },
              { value: 'wallet_withdrawal', label: 'Payouts' },
              { value: 'card_authorization', label: 'Card spending' },
              { value: 'card_funding', label: 'Card funding' },
              { value: 'crypto_deposit', label: 'Crypto in' },
              { value: 'crypto_withdrawal', label: 'Crypto out' },
              { value: 'purchase', label: 'Bills and airtime' },
              { value: 'fx_trade', label: 'Currency exchange' },
              { value: 'reversal', label: 'Reversals' },
            ]}
          />
        </div>
        {before !== undefined && (
          <button type="button" className="ghost" onClick={() => setBefore(undefined)}>
            Back to newest
          </button>
        )}
      </div>

      {rows.loading && <p className="spinner">Loading…</p>}
      <AdminError error={rows.error} code={rows.code} role="support" />
      {rows.data !== undefined && rows.data.length === 0 && (
        <p className="empty">Nothing matches that.</p>
      )}

      {rows.data !== undefined && rows.data.length > 0 && (
        <>
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>When</th>
                  <th>What</th>
                  <th>Held in</th>
                  <th className="right">Amount</th>
                </tr>
              </thead>
              <tbody>
                {rows.data.map((row) => (
                  <tr key={row.posting_id}>
                    <td className="muted nowrap">
                      {new Date(row.occurred_at).toLocaleString()}
                    </td>
                    <td>
                      {row.kind}
                      {row.description === null ? null : (
                        <div className="cell-sub">{row.description}</div>
                      )}
                    </td>
                    {/*
                      WHICH ACCOUNT THE LEG LANDED IN, and it is the column
                      that answers the call. `customer_pending` is money the
                      customer has and cannot spend yet — a card hold, a gift
                      card hold, a payout in flight — and it is what "my
                      balance is wrong" almost always means.
                    */}
                    <td className="muted">{row.account_kind.replace('customer_', '')}</td>
                    <td className="right mono nowrap">
                      {/*
                        `formatMinor`, never `formatAmount`. The two look
                        identical at a call site and differ by a factor of a
                        hundred: this row is minor units, and the compliance
                        queue once rendered ₦500,000,000 for a ₦5,000,000
                        transfer for exactly this reason.
                      */}
                      {formatMinor(row.amount_minor, row.currency)} {row.currency}
                      {row.status === 'posted' ? null : (
                        <div className="cell-sub">{row.status}</div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {rows.data.length === 50 && last !== undefined && (
            <div className="actions">
              <button
                type="button"
                className="ghost"
                onClick={() => setBefore(last.posting_id)}
              >
                Older
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
