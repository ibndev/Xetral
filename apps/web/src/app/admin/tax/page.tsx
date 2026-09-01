'use client';

import { useState } from 'react';
import { formatMinor } from '@xetral/client';
import { useAdmin, useLoad } from '@/lib/hooks';
import { AdminError } from '../access';
import { Select } from '@/ui/select';

/**
 * What was collected for a revenue authority, and what is still held.
 *
 * TAX IS NOT REVENUE, and this screen exists so that distinction is visible to
 * the person who has to act on it. Money collected for the FIRS is money owed
 * to the FIRS; booking it as revenue overstates what the business earned and
 * understates what it owes, and both errors point the flattering way.
 *
 * Every figure comes from a VIEW over the ledger. Nothing here is a counter
 * this page maintains, because a revenue number computed from a second record
 * drifts, and the drift is discovered while filing a return.
 *
 * NOTHING ON THIS PAGE IS TAX ADVICE. The rate and the levy are settings an
 * operator reviews.
 */

const KINDS: Readonly<Record<string, string>> = {
  vat: 'VAT on fees',
  transfer_levy: 'Transfer levy',
};

const ACCOUNTS: Readonly<Record<string, string>> = {
  revenue_fees: 'Fees kept',
  revenue_fx_spread: 'FX spread',
  liability_tax_payable: 'Tax collected (not ours)',
};

export default function Tax() {
  const admin = useAdmin();
  const [months, setMonths] = useState(12);
  const report = useLoad(() => admin.tax(months), [admin, months]);

  return (
    <>
      <div className="panel">
        <h1>Tax</h1>
        <p className="lead">
          What was collected on a revenue authority&rsquo;s behalf, read from the
          ledger. It is a liability, not revenue.
        </p>
        <label id="tax-months">
          Months
          <Select
            labelledBy="tax-months"
            value={String(months)}
            onChange={(value) => setMonths(Number(value))}
            options={[
              { value: '3', label: 'Last 3' },
              { value: '12', label: 'Last 12' },
              { value: '36', label: 'Last 36' },
            ]}
          />
        </label>
        <AdminError error={report.error} code={report.code} role="finance" />
        {report.loading && <p className="spinner">Loading…</p>}
      </div>

      {/*
        First, and deliberately: tax held that no collection explains means a
        path posted the money and forgot the record. Empty is the only good
        answer, and an operator should not have to scroll past two tables to
        find out it is not.
      */}
      {report.data !== undefined && report.data.drift.length > 0 && (
        <div className="panel">
          <h2 className="danger">Unexplained tax held</h2>
          <p className="lead">
            More is held than any recorded collection accounts for.
          </p>
          <table>
            <thead>
              <tr>
                <th>Currency</th>
                <th>Recorded</th>
                <th>Held</th>
                <th>Unexplained</th>
              </tr>
            </thead>
            <tbody>
              {report.data.drift.map((row) => (
                <tr key={row.currency}>
                  <td>{row.currency}</td>
                  <td>{formatMinor(row.collected_minor, row.currency)}</td>
                  <td>{formatMinor(row.held_minor, row.currency)}</td>
                  <td className="danger">
                    {formatMinor(row.difference_minor, row.currency)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="panel">
        <h2>Held, not yet remitted</h2>
        <p className="lead">
          From the account balance, not from the record describing it.
        </p>
        {report.data !== undefined && report.data.payable.length === 0 && (
          <p className="empty">Nothing held.</p>
        )}
        {report.data !== undefined && report.data.payable.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>Currency</th>
                <th>Balance</th>
              </tr>
            </thead>
            <tbody>
              {report.data.payable.map((row) => (
                <tr key={row.currency}>
                  <td>{row.currency}</td>
                  <td>{formatMinor(row.balance_minor, row.currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="panel">
        <h2>Collected by month</h2>
        <p className="lead">
          A Lagos month, and a row per currency.
        </p>
        {report.data !== undefined && report.data.collected.length === 0 && (
          <p className="empty">Nothing collected yet.</p>
        )}
        {report.data !== undefined && report.data.collected.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>Month</th>
                <th>Kind</th>
                <th>Currency</th>
                <th>Transactions</th>
                <th>Charged on</th>
                <th>Collected</th>
              </tr>
            </thead>
            <tbody>
              {report.data.collected.map((row) => (
                <tr key={`${row.month}:${row.kind}:${row.currency}`}>
                  <td>{row.month.slice(0, 7)}</td>
                  <td>{KINDS[row.kind] ?? row.kind}</td>
                  <td>{row.currency}</td>
                  <td>{row.transactions}</td>
                  <td>{formatMinor(row.base_minor, row.currency)}</td>
                  <td>{formatMinor(row.collected_minor, row.currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="panel">
        <h2>Revenue by month</h2>
        <p className="lead">
          Read from postings, with the tax part of each fee shown alongside.
        </p>
        {report.data !== undefined && report.data.revenue.length === 0 && (
          <p className="empty">No revenue yet.</p>
        )}
        {report.data !== undefined && report.data.revenue.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>Month</th>
                <th>Account</th>
                <th>Currency</th>
                <th>Amount</th>
              </tr>
            </thead>
            <tbody>
              {report.data.revenue.map((row) => (
                <tr key={`${row.month}:${row.account}:${row.currency}`}>
                  <td>{row.month.slice(0, 7)}</td>
                  <td>{ACCOUNTS[row.account] ?? row.account}</td>
                  <td>{row.currency}</td>
                  <td>{formatMinor(row.amount_minor, row.currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
