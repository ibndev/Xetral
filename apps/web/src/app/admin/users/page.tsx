'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useAdmin, useLoad } from '@/lib/hooks';
import { AdminError } from '../access';
import { Select } from '@/ui/select';

/**
 * Finding a customer.
 *
 * Search is a server-side `LIKE` on the email, and there is deliberately no
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
      <h2>Fifty most recent, or search by email</h2>

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
          placeholder="Email"
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
                <th>Email</th>
                <th>Status</th>
                <th>Identity</th>
                <th>Joined</th>
              </tr>
            </thead>
            <tbody>
              {users.data.map((user) => (
                <tr key={user.id}>
                  <td>
                    <Link href={`/admin/users/${user.id}`}>{user.email}</Link>
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
