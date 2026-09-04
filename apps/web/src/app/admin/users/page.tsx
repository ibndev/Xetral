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
/**
 * WHO THIS IS, in one line.
 *
 * The signup name first, then the name a reviewer read off a document, then
 * the email address. The order is the point: `full_name` is what the customer
 * calls themselves and is the right thing to greet them by, while
 * `verified_name` is the only one a money decision may read — so the display
 * prefers the friendly one and falls back to the documented one rather than
 * showing an account with no name at all.
 */
function nameOf(user: {
  readonly full_name: string | null;
  readonly verified_name: string | null;
  readonly email: string | null;
}): string {
  return user.full_name ?? user.verified_name ?? user.email ?? 'Customer';
}

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
                    THE NAME ON TOP, THE WHOLE EMAIL UNDER IT.

                    Two rounds got this wrong in opposite directions. The
                    column started as an email address alone — the identifier
                    support has LEAST often, since a customer on the phone
                    gives a name. Then the name went on top and the address
                    beneath it was hidden whenever the name was missing, which
                    on these accounts meant the address appeared twice.

                    Both lines now say a different thing, always: who this is,
                    and how to reach them. `full_name` is what the customer
                    typed about themselves — never the verified name, which
                    only a reviewer reading a document establishes.
                  */}
                  <td>
                    <Link href={`/admin/users/${user.id}`}>{nameOf(user)}</Link>
                    <div className="cell-sub">
                      {[
                        // The address, unless the line above is already it —
                        // an account with neither name printed its own email
                        // twice, which reads as a rendering fault.
                        nameOf(user) === user.email ? null : user.email,
                        user.handle === null ? null : `@${user.handle}`,
                      ]
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
