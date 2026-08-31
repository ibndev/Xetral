'use client';

import { useState } from 'react';
import { formatAmount } from '@xetral/client';
import type { KycLimits, KycStatus } from '@xetral/client';
import { Shell } from '@/ui/shell';
import { FormError } from '@/ui/form-error';
import { Icon } from '@/ui/icon';
import { useLoad, useSubmit, useXetral } from '@/lib/hooks';

/**
 * Identity verification.
 *
 * The screen that unblocks everything else: no bank account number and no card
 * exists for a customer until this has been approved, because `provider_customers`
 * is created by the approval and both of those refuse without it.
 *
 * The BVN is typed here and never comes back. The server seals it and returns
 * four digits, which is enough for support to confirm they are talking about
 * the right one and not enough to be worth stealing from a screenshot.
 */
export default function Kyc() {
  const client = useXetral();
  const { data, loading, reload } = useLoad<KycStatus | null>(() => client.kyc(), [client]);
  const { busy, error, code, run } = useSubmit();

  const [form, setForm] = useState({
    fullName: '',
    dateOfBirth: '',
    phone: '',
    bvn: '',
    address: '',
  });

  const set = (field: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [field]: e.target.value }));

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    await run(async () => {
      await client.submitKyc(form);
      // Clear the BVN from the page's own state the moment it has been sent.
      // It is in a React tree, a devtools inspector and a memory dump until
      // something removes it, and it has no further use here.
      setForm((f) => ({ ...f, bvn: '' }));
      reload();
      return 'Submitted. We will review this and let you know.';
    });
  }

  if (loading) {
    return (
      <Shell>
        <div className="card">
          <p className="spinner">Loading…</p>
        </div>
      </Shell>
    );
  }

  if (data !== null && data !== undefined) return <Submitted status={data} />;

  return (
    <Shell>
      {/*
        What they can move TODAY, before the form rather than after it.

        A customer arrives here either because something refused them or
        because they were told to. Either way the useful first sentence is what
        their current ceiling is — being refused and shown a form, with no
        statement of what changes, is what makes a limit feel arbitrary.
      */}
      <Limits />

      <form className="card" onSubmit={submit}>
        <h1>Verify your identity</h1>
        <h2>Required before you can be issued an account number or a card</h2>

        <label>
          Full name, as it appears on your BVN
          <input value={form.fullName} onChange={set('fullName')} required minLength={3} />
        </label>

        <div className="field-row two">
          <label>
            Date of birth
            <input type="date" value={form.dateOfBirth} onChange={set('dateOfBirth')} required />
          </label>

          <label>
            Phone number
            <input
              type="tel"
              inputMode="tel"
              placeholder="+2348012345678"
              value={form.phone}
              onChange={set('phone')}
              required
            />
          </label>
        </div>

        <label>
          BVN
          <input
            inputMode="numeric"
            pattern="[0-9]{11}"
            maxLength={11}
            value={form.bvn}
            onChange={set('bvn')}
            required
            // Never offered back by the browser on another form. A BVN in an
            // autofill dropdown is a BVN on the next person's screen.
            autoComplete="off"
          />
          <span className="hint">Eleven digits. We store this encrypted and never show it again.</span>
        </label>

        <label>
          Residential address
          <textarea value={form.address} onChange={set('address')} required minLength={10} />
        </label>

        <button type="submit" disabled={busy}>
          {busy ? 'Submitting…' : 'Submit for review'}
        </button>

        <FormError error={error} code={code} />
      </form>
    </Shell>
  );
}

function Submitted({ status }: { status: KycStatus }) {
  const state =
    status.status === 'approved'
      ? { badge: 'ok', title: 'You are verified' }
      : status.status === 'rejected'
        ? { badge: 'danger', title: 'We could not verify this' }
        : { badge: 'warn', title: 'Under review' };

  return (
    <Shell>

      <div className="card">
        <h1>{state.title}</h1>
        <h2>
          <span className={`badge ${state.badge}`}>{status.status}</span>
        </h2>

        <div className="row">
          <span className="muted">Name</span>
          <span>{status.full_name}</span>
        </div>
        <div className="row">
          <span className="muted">BVN</span>
          <span className="mono">•••••••{status.bvn_last4}</span>
        </div>
        <div className="row">
          <span className="muted">Submitted</span>
          <span>{new Date(status.created_at).toLocaleDateString()}</span>
        </div>

        {status.status === 'pending' && (
          <p className="hint">
            Reviews are done by a person, not automatically. You can keep using
            your wallet in the meantime.
          </p>
        )}

        <Limits />

        {status.rejection_reason !== null && (
          <div className="notice danger" style={{ marginTop: 16 }}>
            <p>{status.rejection_reason}</p>
            <p className="hint">
              Contact support to submit again with corrected details.
            </p>
          </div>
        )}
      </div>
    </Shell>
  );
}

/**
 * What this customer's verification currently allows.
 *
 * Rendered on both states of this screen — before submitting and after — for
 * the same reason: a ceiling somebody cannot see is one they can only discover
 * by hitting it, and a refusal with no explanation of what would change is
 * what turns a control into a support ticket.
 *
 * A ZERO IS A REAL LIMIT and is shown as one. An unverified account may move
 * no crypto at all, because a chain transaction is the single movement nobody
 * can recall — and saying "not available yet" is more honest than hiding the
 * row and letting somebody find out at the moment they try.
 */
function Limits() {
  const client = useXetral();
  const { data } = useLoad<KycLimits>(() => client.kycLimits(), [client]);
  if (data === undefined) return null;

  const TIERS = ['Registered', 'Verified', 'Enhanced'];

  return (
    <div className="card">
      <h2>
        Your daily limits{' '}
        <span className="badge">{TIERS[data.tier] ?? `tier ${data.tier}`}</span>
      </h2>
      {data.limits.map((limit) => (
        <div className="row" key={limit.currency}>
          <span className="muted">{limit.currency}</span>
          <span className="mono">
            {/*
              A regex, not `=== '0'`: the API sends major units, so a zero
              ceiling arrives as "0.00" for naira and "0.00000000" for BTC.
              Comparing against a bare '0' would render the "no crypto without
              an identity" limit as an ordinary allowance of nothing.
            */}
            {/^0(\.0+)?$/.test(limit.daily_limit) ? (
              'not available yet'
            ) : (
              <>{formatAmount(limit.daily_limit, limit.currency)} a day</>
            )}
          </span>
        </div>
      ))}
      {data.next_tier === 1 && (
        <p className="hint">
          Verifying your identity raises every one of these, and is what lets us
          issue you an account number and a card.
        </p>
      )}
    </div>
  );
}
