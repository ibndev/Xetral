'use client';

import Link from 'next/link';
import { useState } from 'react';
import { formatMinor } from '@xetral/client';
import type { AdminUser } from '@xetral/client';
import { useAdmin, useLoad } from '@/lib/hooks';
import { AdminError } from '../access';
import { Kpis } from '../queue';
import { Select } from '@/ui/select';
import { Icon } from '@/ui/icon';
import { CountryMark } from '@/ui/currency-mark';
import { AdminTitle } from '@/app/admin/nav';

/**
 * Finding a customer — the comp's screen: four figures over the WHOLE table,
 * then one panel that is a search, two filters and a page of rows.
 *
 * Search matches the name, the email, the phone number or the handle —
 * server-side, in one query. It was the email alone, which is the identifier
 * support has LEAST often: a customer on the phone gives a name and the
 * number they are calling from. There is deliberately no "list everyone":
 * a page at a time, keyset-paged, because an operations screen that renders
 * the whole customer table puts the whole customer table into a browser
 * cache, a screenshot and a support ticket.
 */

/**
 * WHO THIS IS, in one line.
 *
 * The signup name first, then the name a reviewer read off a document, then
 * the email address. `full_name` is what the customer calls themselves and is
 * the right thing to greet them by, while `verified_name` is the only one a
 * money decision may read — so the display prefers the friendly one and falls
 * back to the documented one rather than showing an account with no name.
 */
function nameOf(user: AdminUser): string {
  return user.full_name ?? user.verified_name ?? user.email ?? 'Customer';
}

function initialsOf(name: string): string {
  const parts = name.replace(/@.*/, '').trim().split(/[\s._-]+/).filter(Boolean);
  const first = parts[0]?.[0] ?? '';
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : '';
  return (first + last).toUpperCase() || '·';
}

/** "12 Mar 2025" — the comp's date, and unambiguous on either side of the Atlantic. */
function joined(iso: string): string {
  return new Date(iso)
    .toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
    .replace('Sept', 'Sep');
}

const KYC: Readonly<Record<string, { label: string; tone: string }>> = {
  approved: { label: 'Verified', tone: 'ok' },
  pending: { label: 'Pending', tone: 'warn' },
  rejected: { label: 'Rejected', tone: 'danger' },
};

const STATUS: Readonly<Record<string, string>> = { active: 'ok', frozen: 'danger', closed: 'danger' };

const PAGE = 25;

export default function Users() {
  const admin = useAdmin();
  const [search, setSearch] = useState('');
  const [applied, setApplied] = useState('');
  const [country, setCountry] = useState('');
  const [kyc, setKyc] = useState('');
  /* Keyset paging: each page is "older than the last row of the one before",
     and Previous pops back to the cursor that produced the page before. */
  const [cursors, setCursors] = useState<readonly (string | undefined)[]>([undefined]);
  const before = cursors[cursors.length - 1];

  const list = useLoad(
    () =>
      admin.customers({
        ...(applied === '' ? {} : { search: applied }),
        ...(country === '' ? {} : { country }),
        ...(kyc === '' ? {} : { kyc }),
        ...(before === undefined ? {} : { before }),
        limit: PAGE,
      }),
    [admin, applied, country, kyc, before],
  );
  const countries = useLoad(() => admin.countries().catch(() => undefined), [admin]);

  const restart = (apply: () => void): void => {
    apply();
    setCursors([undefined]);
  };

  const rows = list.data?.users ?? [];
  const totals = list.data?.totals;
  const filtered = applied !== '' || country !== '' || kyc !== '';
  const offset = (cursors.length - 1) * PAGE;
  const count = (value: string | undefined): number | undefined =>
    value === undefined ? undefined : Number(value);

  return (
    <>
      <AdminTitle>Customers</AdminTitle>
      <Kpis
        items={[
          { label: 'Total customers', count: count(totals?.total), value: totals === undefined ? undefined : Number(totals.total).toLocaleString('en-GB') },
          {
            label: 'New · 24h',
            count: count(totals?.new_24h),
            tone: 'ok',
            value: totals === undefined ? undefined : `${Number(totals.new_24h) > 0 ? '+' : ''}${Number(totals.new_24h).toLocaleString('en-GB')}`,
          },
          { label: 'KYC pending', count: count(totals?.kyc_pending), tone: 'warn' },
          { label: 'Frozen', count: count(totals?.frozen), tone: 'danger' },
        ]}
      />

      <div className="panel tbl-panel">
        <form
          className="tbl-tools"
          role="search"
          onSubmit={(event) => {
            event.preventDefault();
            restart(() => setApplied(search.trim()));
          }}
        >
          <label className="tbl-search">
            <Icon name="search" size={17} />
            <input
              aria-label="Search customers"
              placeholder="Search name, email, phone or @handle"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </label>
          <Select
            value={country}
            onChange={(value) => restart(() => setCountry(value))}
            placeholder="All countries"
            options={[
              { value: '', label: 'All countries' },
              ...(countries.data?.countries ?? []).map((c) => ({ value: c.code, label: c.name })),
            ]}
          />
          <Select
            value={kyc}
            onChange={(value) => restart(() => setKyc(value))}
            placeholder="KYC status"
            options={[
              { value: '', label: 'KYC status' },
              { value: 'approved', label: 'Verified' },
              { value: 'pending', label: 'Pending' },
              { value: 'rejected', label: 'Rejected' },
              { value: 'none', label: 'Not submitted' },
            ]}
          />
        </form>

        {list.loading && <p className="spinner">Loading…</p>}
        <AdminError error={list.error} code={list.code} role="support" />
        {!list.loading && list.error === undefined && rows.length === 0 && (
          <p className="empty">No customers match that.</p>
        )}

        {rows.length > 0 && (
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>Customer</th>
                  <th>Country</th>
                  <th>KYC</th>
                  <th className="r">Balance</th>
                  <th>Joined</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((user) => {
                  const name = nameOf(user);
                  const kycTone = user.kyc_status === null ? undefined : KYC[user.kyc_status];
                  return (
                    <tr key={user.id}>
                      {/* THE NAME ON TOP, THE WHOLE EMAIL UNDER IT — unless the
                          name IS the email, which printed twice reads as a
                          rendering fault. The phone is what support is read
                          out on a call, so it rides on the same line. */}
                      <td>
                        <div className="who">
                          <span className="avatar" aria-hidden="true">{initialsOf(name)}</span>
                          <span>
                            <Link href={`/admin/users/${user.id}`}>{name}</Link>
                            <small>
                              {[name === user.email ? null : user.email, user.phone]
                                .filter((part) => part !== null && part !== '')
                                .join(' · ')}
                            </small>
                          </span>
                        </div>
                      </td>
                      <td>
                        {user.country === null ? (
                          <span className="muted">—</span>
                        ) : (
                          <span title={user.country}>
                            <CountryMark country={user.country} size={20} />
                          </span>
                        )}
                      </td>
                      <td>
                        {kycTone === undefined ? (
                          <span className="badge">{user.kyc_status ?? 'None'}</span>
                        ) : (
                          <span className={`badge ${kycTone.tone}`}>{kycTone.label}</span>
                        )}
                      </td>
                      <td className="r mono soft">
                        {formatMinor(user.balance_minor, user.balance_currency)}
                      </td>
                      <td className="quiet nowrap">{joined(user.created_at)}</td>
                      <td>
                        <span className={`badge ${STATUS[user.status] ?? ''}`}>
                          {user.status.charAt(0).toUpperCase() + user.status.slice(1)}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {(rows.length > 0 || cursors.length > 1) && (
          <div className="tbl-foot">
            <span>
              {rows.length === 0
                ? 'No more customers'
                : `Showing ${offset + 1}–${offset + rows.length}${
                    filtered || totals === undefined
                      ? ''
                      : ` of ${Number(totals.total).toLocaleString('en-GB')}`
                  }`}
            </span>
            <span className="acts">
              <button
                type="button"
                className="ghost"
                disabled={cursors.length <= 1}
                onClick={() => setCursors((was) => was.slice(0, -1))}
              >
                Previous
              </button>
              <button
                type="button"
                className="ghost"
                disabled={rows.length < PAGE}
                onClick={() => {
                  const last = rows[rows.length - 1];
                  if (last !== undefined) setCursors((was) => [...was, last.row_id]);
                }}
              >
                Next
              </button>
            </span>
          </div>
        )}
      </div>
    </>
  );
}
