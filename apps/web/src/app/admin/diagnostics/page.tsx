'use client';

import { useAdmin, useLoad } from '@/lib/hooks';
import { Icon } from '@/ui/icon';
import { AdminError } from '../access';

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

  const failing = report.data?.checks.filter((c) => c.state === 'fail') ?? [];

  return (
    <>
      <div className="panel">
        <h1>Diagnostics</h1>
        <h2>{report.data === undefined ? '—' : `${failing.length} blocking`}</h2>
        <p className="lead">
          What the naira rail says when it is asked, rather than what it is
          configured to be.
        </p>
        <AdminError error={report.error} code={report.code} role="admin" />
        {report.loading && <p className="spinner">Checking…</p>}

        {report.data !== undefined && (
          <div className="actions">
            <button type="button" className="ghost" onClick={report.reload}>
              Check again
            </button>
          </div>
        )}
      </div>

      {/*
        WHAT ACTUALLY THREW, and this is the half no configuration check can
        reach. The checks below answer "is the rail set up correctly"; a null
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

      {report.data?.checks.map((check) => (
        <div className="panel" key={check.name}>
          <div className="row">
            <span>
              <Icon name={iconFor(check.state)} size={16} /> <strong>{check.name}</strong>
            </span>
            <span className={`badge ${badgeFor(check.state)}`}>{labelFor(check.state)}</span>
          </div>
          {/*
            The provider's OWN sentence, verbatim. It is the whole reason this
            page is worth building, and it is why every route behind it is
            `staff()`: it names our integration and must never reach a
            customer.
          */}
          <p className="hint">{check.detail}</p>
        </div>
      ))}
    </>
  );
}

function iconFor(state: string): 'check' | 'alert' | 'clock' {
  if (state === 'pass') return 'check';
  if (state === 'fail') return 'alert';
  return 'clock';
}

/** The product's own status chip, so this page looks like the rest of the
 *  dashboard rather than inventing a fourth vocabulary of colours. */
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
