'use client';

import { useEffect, useState } from 'react';
import { ACCOUNT_TIERS, formatAmount, tierLabel, wholeFigure } from '@xetral/client';
import type { KycLimits, KycStatus } from '@xetral/client';
import { Shell } from '@/ui/shell';
import { FormError } from '@/ui/form-error';
import { Icon } from '@/ui/icon';
import { useLoad, useSubmit, useXetral } from '@/lib/hooks';

/**
 * Identity verification.
 *
 * What it unblocks is the dollar card, crypto and the higher tiers' limits —
 * `provider_customers` is created by the approval and the card refuses without
 * it. NOT the naira account number: since round 26 a tier 1 account opens
 * without identity, and this file said otherwise until round 44.
 *
 * The BVN is typed here and never comes back. The server seals it and returns
 * four digits, which is enough for support to confirm they are talking about
 * the right one and not enough to be worth stealing from a screenshot.
 */
export default function Kyc() {
  const client = useXetral();
  const { data, loading, reload, error: readError, code: readCode } = useLoad<KycStatus | null>(
    () => client.kyc(),
    [client],
  );
  const { busy, error, code, run } = useSubmit();

  /*
   * WHAT SIGNUP ALREADY TOOK IS NOT ASKED AGAIN.
   *
   * This form used to open with five empty boxes, two of which the account
   * already held — and a verification step that re-asks for a name and a
   * phone number is one people abandon on the screen that unblocks the card
   * they came for. The session carries both, so they arrive filled in and
   * STILL EDITABLE: the name on a BVN is not always the name somebody typed
   * about themselves, and the reviewer reads it off a document either way.
   */
  const session = useLoad(() => client.currentSession(), [client]);

  const [form, setForm] = useState({
    fullName: '',
    dateOfBirth: '',
    phone: '',
    bvn: '',
    address: '',
  });

  useEffect(() => {
    const known = session.data;
    if (known === undefined) return;
    // Only ever fills a box the customer has not touched. Overwriting what
    // somebody has typed because a request finished late is the worse bug.
    setForm((f) => ({
      ...f,
      fullName: f.fullName === '' ? (known.full_name ?? '') : f.fullName,
      phone: f.phone === '' ? (known.phone ?? '') : f.phone,
    }));
  }, [session.data]);

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
      <Shell back="/more" title="Identity">
        <div className="card">
          <p className="spinner">Loading…</p>
        </div>
      </Shell>
    );
  }

  if (data !== null && data !== undefined) return <Submitted status={data} />;

  /*
   * A READ THAT FAILED IS NOT "NEVER SUBMITTED". The error was not read at
   * all, so a pending or verified customer whose status could not be fetched
   * was shown the blank form and invited to submit their BVN again.
   */
  if (readError !== undefined) {
    return (
      <Shell back="/more" title="Identity">
        <div className="card">
          <FormError error={readError} code={readCode} />
          <div className="actions" style={{ marginTop: 'var(--s-3)' }}>
            <button type="button" className="quiet" onClick={reload}>
              Try again
            </button>
          </div>
        </div>
      </Shell>
    );
  }

  return (
    /* A BACK ARROW AND A TITLE, because this screen is reached from More and
       from a refusal elsewhere, and is not a tab. It drew the brand header,
       so a customer sent here by a gate had no way back to what they were
       doing. */
    <Shell back="/more" title="Identity">
      {/*
        What they can move TODAY, before the form rather than after it.

        A customer arrives here either because something refused them or
        because they were told to. Either way the useful first sentence is what
        their current ceiling is — being refused and shown a form, with no
        statement of what changes, is what makes a limit feel arbitrary.
      */}
      <Limits />

      <form className="card" onSubmit={submit}>
        {/* A SECTION HEADING — the Shell names the screen. */}
        <h2>Verify your identity</h2>
        <h2>Your BVN, and a check of what we already hold</h2>

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
    <Shell back="/more" title="Identity">

      <div className="card">
        {/* THE STATE AND ITS BADGE ON ONE LINE. The badge was wrapped in an
            `<h2>` purely to get the spacing, which made a status pill a
            heading — and `.card > h2` now sets a size, so it was also a
            17px line containing a 12px chip. */}
        <div className="row-between" style={{ marginBottom: 'var(--s-3)' }}>
          <h2 style={{ margin: 0 }}>{state.title}</h2>
          <span className={`badge ${state.badge}`}>{status.status}</span>
        </div>

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
          <p className="hint">We&apos;ll notify you when review is completed</p>
        )}

        {status.rejection_reason !== null && (
          <div className="notice danger" style={{ marginTop: 16 }}>
            <p>{status.rejection_reason}</p>
            <p className="hint">
              Contact support to submit again with corrected details.
            </p>
          </div>
        )}
      </div>

      {/*
        THE LIMITS ARE THEIR OWN CARD, not one inside the identity card.

        `Limits` renders a `.card`, so nesting it here drew a picture of a
        card inside a picture of a card — two edges, two grounds, and the
        inner one overlapping the divider of the row above it. The two answer
        different questions and are two blocks on the page.
      */}
      <Limits />
    </Shell>
  );
}

/**
 * THE ACCOUNT'S TIER, AS A LADDER.
 *
 * Rendered on both states of this screen — before submitting and after — for
 * the same reason: a ceiling somebody cannot see is one they can only discover
 * by hitting it, and a refusal with no explanation of what would change is
 * what turns a control into a support ticket.
 *
 * THREE RUNGS, AS THE OWNER COUNTS THEM: Tier 1 on signing up, Tier 2 once a
 * BVN is verified, Tier 3 once an address is. It replaced a row per currency
 * reading "Limited" or "Raised" — two words that answered whether verifying
 * would help and nothing else, so the customer could not tell what the next
 * step was worth or how far they were from the top.
 *
 * ONE FIGURE PER RUNG, IN THEIR OWN CURRENCY. The API answers every
 * currency's ceiling at every tier; drawn whole that is a price list on a
 * screen whose subject is identity, and the crypto rows' real zeros read as
 * "not available yet". The figure is the customer's home currency, falling
 * back to naira — the currency every account can hold.
 */
function Limits() {
  const client = useXetral();
  const { data } = useLoad<KycLimits>(() => client.kycLimits(), [client]);
  const session = useLoad(() => client.currentSession(), [client]);
  const home = session.data?.home_currency ?? null;
  if (data === undefined) return null;

  const ladder = data.ladder ?? [{ tier: data.tier, limits: data.limits }];
  const currency =
    home !== null && ladder.some((r) => r.limits.some((l) => l.currency === home)) ? home : 'NGN';

  return (
    <div className="card tier-card">
      <div className="row-between tier-head">
        <h2>Your account tier</h2>
        <span className="badge ok">{tierLabel(data.tier)}</span>
      </div>
      <ol className="tier-ladder">
        {ACCOUNT_TIERS.map((rung) => {
          const state =
            rung.tier < data.tier ? 'done' : rung.tier === data.tier ? 'current' : 'locked';
          const limit = ladder
            .find((r) => r.tier === rung.tier)
            ?.limits.find((l) => l.currency === currency);
          return (
            <li key={rung.tier} className={`tier-step ${state}`}>
              <span className="tier-dot" aria-hidden>
                {state === 'done' ? <Icon name="check" size={14} /> : rung.tier + 1}
              </span>
              <span className="tier-body">
                <span className="tier-name">
                  {rung.label}
                  {state === 'current' && <span className="tier-now">You are here</span>}
                </span>
                <span className="tier-req">{rung.requirement}</span>
              </span>
              <span className="tier-limit">
                {limit === undefined ? (
                  '—'
                ) : (
                  <>
                    {formatAmount(wholeFigure(limit.daily_limit), currency)}
                    <span className="tier-per">a day</span>
                  </>
                )}
              </span>
            </li>
          );
        })}
      </ol>
      {data.tier === 0 && (
        <p className="hint">Verify your BVN to move to Tier 2 and unlock a dollar card.</p>
      )}
      {data.tier === 1 && (
        <p className="hint">Tier 3 needs your address verified. Contact support to request it.</p>
      )}
    </div>
  );
}
