'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useAdmin, useLoad } from '@/lib/hooks';
import { AdminError } from '../access';
import { Select } from '@/ui/select';

/**
 * Finding a customer.
 *
 * Search matches the name, the email, the phone number or the handle —
 * server-side, in one query. It was the email alone, which is the identifier
 * support has LEAST often: a customer on the phone gives a name and the
 * number they are calling from. There is deliberately no
 * "list everyone" default beyond the most recent page: an operations screen
 * that renders the whole customer table is a screen that puts the whole
 * customer table into a browser cache, a screenshot and a support ticket.
 */
export default function Users() {
  const admin = useAdmin();
  const [search, setSearch] = useState('');
  const [applied, setApplied] = useState('');
  const [status, setStatus] = useState('');

  const users = useLoad(
    () =>
      admin.users({
        ...(applied === '' ? {} : { search: applied }),
        ...(status === '' ? {} : { status }),
        limit: 50,
      }),
    [admin, applied, status],
  );

  return (
    <div className="panel">
      <h1>Customers</h1>
      <h2>Fifty most recent, or search by name, email, phone or handle</h2>

      <form
        className="actions"
        style={{ marginBottom: 16 }}
        onSubmit={(event) => {
          event.preventDefault();
          setApplied(search);
        }}
      >
        <input
          style={{ flex: '1 1 220px', marginTop: 0 }}
          placeholder="Name, email, phone or @handle"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div style={{ flex: '0 1 160px' }}>
          <Select
            value={status}
            onChange={setStatus}
            placeholder="Any status"
            options={[
              { value: '', label: 'Any status' },
              { value: 'active', label: 'Active' },
              { value: 'frozen', label: 'Frozen' },
              { value: 'closed', label: 'Closed' },
            ]}
          />
        </div>
        <button type="submit" className="ghost">
          Search
        </button>
      </form>

      {users.loading && <p className="spinner">Loading…</p>}
      <AdminError error={users.error} code={users.code} role="support" />
      {users.data !== undefined && users.data.length === 0 && (
        <p className="empty">No customers match that.</p>
      )}

      {users.data !== undefined && users.data.length > 0 && (
        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th>Customer</th>
                <th>Phone</th>
                <th>Status</th>
                <th>Identity</th>
                <th>Joined</th>
              </tr>
            </thead>
            <tbody>
              {users.data.map((user) => (
                <tr key={user.id}>
                  {/*
                    THE NAME LEADS AND THE ADDRESS IS UNDER IT, ONCE.
                    
                    This column was an email address alone — the identifier
                    support has LEAST often, since a customer on the phone
                    gives a name and somebody reporting a payment link gives a
                    handle. The first fix put the name on top and the address
                    beneath, and on an account with no name that printed the
                    SAME address twice, which reads as a rendering bug.

                    So the second line carries only what the first is not
                    already saying. `full_name` is what the customer typed
                    about themselves — never the verified name, which only a
                    reviewer reading a document establishes.
                  */}
                  <td>
                    <Link href={`/admin/users/${user.id}`}>
                      {user.full_name ?? user.email ?? 'Customer'}
                    </Link>
                    <div className="cell-sub">
                      {[user.full_name === null ? null : user.email,
                        user.handle === null ? null : `@${user.handle}`]
                        .filter((part) => part !== null && part !== '')
                        .join(' · ')}
                    </div>
                  </td>
                  <td className="mono nowrap">
                    {user.phone ?? <span className="muted">—</span>}
                  </td>
                  <td>
                    <span
                      className={`badge ${
                        user.status === 'active'
                          ? 'ok'
                          : user.status === 'frozen'
                            ? 'warn'
                            : 'danger'
                      }`}
                    >
                      {user.status}
                    </span>
                  </td>
                  <td>
                    {user.kyc_status === null ? (
                      <span className="muted">none</span>
                    ) : (
                      <span
                        className={`badge ${
                          user.kyc_status === 'approved'
                            ? 'ok'
                            : user.kyc_status === 'rejected'
                              ? 'danger'
                              : 'warn'
                        }`}
                      >
                        {user.kyc_status}
                      </span>
                    )}
                  </td>
                  <td className="muted nowrap">
                    {new Date(user.created_at).toLocaleDateString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
