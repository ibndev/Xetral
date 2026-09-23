'use client';

import { useState } from 'react';
import { formatMinor } from '@xetral/client';
import { useAdmin, useLoad } from '@/lib/hooks';
import { AdminError } from '../access';
import { Select } from '@/ui/select';
import { AdminTitle } from '@/app/admin/nav';
import { Kpis, MoneyFigure } from '../queue';

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
      <AdminTitle>Tax</AdminTitle>
      <Kpis
        items={[
          {
            label: 'Owed onward',
            value: report.data === undefined ? undefined : (
              <MoneyFigure totals={report.data.payable.map((p) => ({ currency: p.currency, amount_minor: p.balance_minor }))} />
            ),
          },
          {
            label: 'Remitted · 30d',
            value: report.data === undefined ? undefined : (
              <MoneyFigure
                totals={(report.data.positions ?? [])
                  .filter((p) => BigInt(p.remitted_30d_minor) > 0n)
                  .map((p) => ({ currency: p.currency, amount_minor: p.remitted_30d_minor }))}
              />
            ),
          },
          { label: 'Currencies held', count: report.data?.positions?.length },
        ]}
      />
      <AdminError error={report.error} code={report.code} role="finance" />
      {report.loading && <p className="spinner">Loading…</p>}

      {/* THE COMP'S TABLE: per currency, what came in, what went out, what is
          still ours to pay. "Owed" is the account BALANCE — not collected
          minus remitted — so a path that posted tax and forgot the record
          shows here as well as in the drift panel below. */}
      {report.data !== undefined && (
        <div className="panel tbl-panel">
          {(report.data.positions ?? []).length === 0 ? (
            <p className="empty">Nothing collected yet. VAT on fees is collected as fees are charged.</p>
          ) : (
            <div className="scroll">
              <table>
                <thead>
                  <tr>
                    <th>Tax</th>
                    <th>Currency</th>
                    <th className="r">Collected</th>
                    <th className="r">Remitted</th>
                    <th className="r">Owed</th>
                  </tr>
                </thead>
                <tbody>
                  {(report.data.positions ?? []).map((row) => {
                    const owed = report.data?.payable.find((p) => p.currency === row.currency)?.balance_minor ?? '0';
                    return (
                      <tr key={row.currency}>
                        <td>
                          <strong>{row.kinds.map((k) => KINDS[k] ?? k).join(', ') || 'Tax'}</strong>
                        </td>
                        <td className="quiet">{row.currency}</td>
                        <td className="r mono soft">{formatMinor(row.collected_minor, row.currency)}</td>
                        <td className="r mono soft">{formatMinor(row.remitted_minor, row.currency)}</td>
                        <td className={BigInt(owed) > 0n ? 'r mono owed' : 'r mono paid'}>
                          {formatMinor(owed, row.currency)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/*
        First, and deliberately: tax held that no collection explains means a
        path posted the money and forgot the record. Empty is the only good
        answer, and an operator should not have to scroll past two tables to
        find out it is not.
      */}
      {report.data !== undefined && report.data.drift.length > 0 && (
        <div className="panel tbl-panel">
          <div className="tbl-head">
            <span className="sec danger">Unexplained tax held</span>
          </div>
          <span className="tbl-note">More is held than any recorded collection accounts for.</span>
          <div className="scroll"><table>
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
          </table></div>
        </div>
      )}

      <div className="panel tbl-panel">
        <div className="tbl-head">
          <span className="sec">Collected by month</span>
          <Select
            labelledBy="tax-months"
            value={String(months)}
            onChange={(value) => setMonths(Number(value))}
            options={[
              { value: '3', label: 'Last 3 months' },
              { value: '12', label: 'Last 12 months' },
              { value: '36', label: 'Last 36 months' },
            ]}
          />
        </div>
        <span className="tbl-note" id="tax-months">A Lagos month, and a row per currency — what a return is filed from.</span>
        {report.data !== undefined && report.data.collected.length === 0 && (
          <p className="empty">Nothing collected in this window.</p>
        )}
        {report.data !== undefined && report.data.collected.length > 0 && (
          <div className="scroll"><table>
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
          </table></div>
        )}
      </div>

      <div className="panel tbl-panel">
        <div className="tbl-head">
          <span className="sec">Revenue by month</span>
        </div>
        <span className="tbl-note">Read from postings, with the tax part of each fee shown alongside.</span>
        {report.data !== undefined && report.data.revenue.length === 0 && (
          <p className="empty">No revenue yet.</p>
        )}
        {report.data !== undefined && report.data.revenue.length > 0 && (
          <div className="scroll"><table>
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
          </table></div>
        )}
      </div>
    </>
  );
}
