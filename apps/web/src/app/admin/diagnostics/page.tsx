'use client';

import { useState } from 'react';
import { useAdmin, useLoad } from '@/lib/hooks';
import { messageFor } from '@/lib/errors';
import { AdminError } from '../access';
import { AdminTitle } from '@/app/admin/nav';

/**
 * WHY OPENING A NAIRA ACCOUNT IS FAILING.
 *
 * THE FAILURE THIS SCREEN EXISTS FOR is a failure of DIAGNOSIS, not of any
 * one flow. "Activate Account" can be refused by at least six unrelated
 * things — no key, a key from the other Paystack domain, dedicated accounts
 * not enabled on the business, a `preferred_bank` slug it is not approved
 * for, a migration that was never applied, a customer code minted under the
 * other domain — and every one of them reaches the customer as the same
 * sentence and the operator as the same sentence.
 *
 * So the only move available was to change something and try again, which
 * during an incident is how a correct live key gets replaced.
 *
 * Readiness answers "is it SET?". Every reason above survives that question.
 */
export default function Diagnostics() {
  const admin = useAdmin();
  const report = useLoad(() => admin.fundingDiagnostics(), [admin]);
  const [clearing, setClearing] = useState(false);
  const [clearError, setClearError] = useState<string | undefined>();

  const failing = report.data?.checks.filter((c) => c.state === 'fail') ?? [];

  return (
    <>
      <AdminTitle>Diagnostics</AdminTitle>
      {/* The comp's header row: what this is, and the one button. */}
      <div className="panel panel-head">
        <span className="sec">
          Provider probes
          {report.data !== undefined && (
            <span className={failing.length > 0 ? 'badge danger' : 'badge ok'}>
              {failing.length > 0 ? `${failing.length} blocking` : 'Nothing blocking'}
            </span>
          )}
        </span>
        <button type="button" disabled={report.loading} onClick={report.reload}>
          {report.loading ? 'Checking…' : 'Run all'}
        </button>
      </div>

      <div className="panel probe-panel">
        <AdminError error={report.error} code={report.code} role="admin" />
        {report.loading && report.data === undefined && <p className="spinner">Checking…</p>}
        {/*
          What each rail says when it is ASKED, rather than what it is
          configured to be. The detail is the provider's own sentence, and it
          is why every route behind this is `staff()`: it names our
          integration and must never reach a customer.
        */}
        {report.data?.checks.map((check) => (
          <div className="probe" key={check.name}>
            <span className={`dot ${badgeFor(check.state)}`} aria-hidden />
            <span className="what">
              <span className="name">{check.name}</span>
              <span className="sub">{check.detail}</span>
            </span>
            {/* Only a check that asked a provider has a latency; a configuration
                read printing "2ms" would read as the rail's. */}
            <span className="ms">{check.ms === undefined ? '' : `${check.ms}ms`}</span>
            <span className={`badge ${badgeFor(check.state)}`}>{labelFor(check.state)}</span>
          </div>
        ))}
      </div>

      {/*
        WHAT ACTUALLY THREW, and this is the half no configuration check can
        reach. The probes above answer "is the rail set up correctly"; a null
        column, a constraint or a typo in a SQL string passes every one of
        them and still answers 500. Every one of those has happened in this
        codebase, and every one presented to a person as the same sentence.

        These rows have existed since 015 and nothing rendered them. The
        reference is what makes one answerable: the six characters off
        somebody's screen name the row that says what they hit.
      */}
      {report.data !== undefined && (
        <div className="panel">
          <h2>Recent failures</h2>
          <p className="lead">
            The exception&apos;s own words, for every 5xx this instance has
            served. Match the reference to the one on the screen.
          </p>
          {/*
            CLEARING IS ACKNOWLEDGING, and the label says so rather than
            saying Delete. `error_events` is where the sentence behind a 500
            lives and where the reference an operator reads off a customer's
            screen resolves — a list that could really be emptied is one where
            the evidence for the incident being investigated disappears at the
            moment somebody tidies up. Anything still failing reopens itself
            on its next occurrence, so this cannot hide a live fault.
          */}
          {report.data.failures.length > 0 && (
            <div className="actions">
              <button
                type="button"
                className="ghost"
                disabled={clearing}
                onClick={() => {
                  setClearing(true);
                  setClearError(undefined);
                  void (async () => {
                    try {
                      await admin.clearFailures();
                      report.reload();
                    } catch (cause) {
                      setClearError(messageFor(cause));
                    } finally {
                      setClearing(false);
                    }
                  })();
                }}
              >
                {clearing ? 'Clearing…' : 'Clear the list'}
              </button>
            </div>
          )}
          {clearError !== undefined && <p className="error">{clearError}</p>}
          {report.data.failures.length === 0 && (
            <p className="empty">Nothing has failed. </p>
          )}
          {report.data.failures.map((failure, index) => (
            <div className="row" key={`${failure.route}-${index}`}>
              <span style={{ minWidth: 0 }}>
                <span className="mono">
                  {failure.status} {failure.route ?? 'unmatched'}
                </span>
                <div className="cell-sub">{failure.message}</div>
              </span>
              <span className="muted nowrap">
                {failure.reference === null ? null : (
                  <span className="mono">{failure.reference} · </span>
                )}
                {failure.occurrences}×
              </span>
            </div>
          ))}
        </div>
      )}

    </>
  );
}

function badgeFor(state: string): 'ok' | 'danger' | 'warn' | 'info' {
  if (state === 'pass') return 'ok';
  if (state === 'fail') return 'danger';
  if (state === 'warn') return 'warn';
  return 'info';
}

function labelFor(state: string): string {
  switch (state) {
    case 'pass':
      return 'OK';
    case 'fail':
      // "Blocking" rather than "failed", because that is what an operator
      // needs to know: this one stops customers, the warnings do not.
      return 'Blocking';
    case 'warn':
      return 'Check';
    default:
      return 'Skipped';
  }
}
