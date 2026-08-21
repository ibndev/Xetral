'use client';

import { useState } from 'react';
import type { StaffRole } from '@xetral/client';
import { useAdmin, useLoad } from '@/lib/hooks';
import { messageFor } from '@/lib/errors';

/**
 * Who can do what.
 *
 * Roles are read FRESH from the database on every request and are deliberately
 * not carried in the access token. A signed token cannot be revoked mid-life,
 * so a role baked into one would keep working for fifteen minutes after it was
 * withdrawn — and the moment you most want to remove somebody's approval
 * rights is the moment you have just found out why.
 *
 * So a revocation on this page bites on the next request, not at the next
 * sign-in.
 */
const ROLES: readonly { role: StaffRole; can: string }[] = [
  { role: 'support', can: 'Read customers, balances and held purchases. Cannot change anything.' },
  { role: 'compliance', can: 'Review identity documents. Freeze, unfreeze and close accounts.' },
  { role: 'finance', can: 'Move suspense money to a customer. Change fees, ceilings and limits.' },
  { role: 'giftcard_reviewer', can: 'Approve gift card payouts, reveal a code, claw one back.' },
  { role: 'admin', can: 'Grant and revoke roles. Read the audit log.' },
];

export default function Staff() {
  const admin = useAdmin();
  const staff = useLoad(() => admin.staff(), [admin]);

  return (
    <>
      <div className="panel">
        <h1>Staff</h1>
        <h2>{staff.data?.length ?? 0} active grant(s)</h2>

        {staff.error !== undefined && <p className="error">{staff.error}</p>}
        {staff.loading && <p className="spinner">Loading…</p>}
        {staff.data !== undefined && staff.data.length === 0 && (
          <p className="empty">Nobody has a role.</p>
        )}

        {staff.data !== undefined && staff.data.length > 0 && (
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>Person</th>
                  <th>Role</th>
                  <th>Granted</th>
                  <th>By</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {staff.data.map((grant) => (
                  <tr key={`${grant.user_id}:${grant.role}`}>
                    <td>{grant.email}</td>
                    <td>
                      <span className="badge">{grant.role}</span>
                    </td>
                    <td className="muted nowrap">
                      {new Date(grant.granted_at).toLocaleDateString()}
                    </td>
                    <td className="muted">{grant.granted_by ?? 'system'}</td>
                    <td className="right">
                      <Revoke
                        userId={grant.user_id}
                        role={grant.role as StaffRole}
                        onDone={staff.reload}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <Grant onGranted={staff.reload} />

      <div className="panel">
        <h2>What each role can do</h2>
        {ROLES.map((entry) => (
          <div className="row" key={entry.role}>
            <span>
              <span className="badge">{entry.role}</span>
            </span>
            <span className="muted" style={{ textAlign: 'right' }}>
              {entry.can}
            </span>
          </div>
        ))}
        <p className="hint">
          Grant the narrowest role that does the job. Somebody answering the
          phone does not need the ability to change the transfer fee.
        </p>
      </div>
    </>
  );
}

function Revoke({
  userId,
  role,
  onDone,
}: {
  userId: string;
  role: StaffRole;
  onDone: () => void;
}) {
  const admin = useAdmin();
  const [pin, setPin] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  if (pin === undefined) {
    return (
      <button type="button" className="ghost small" onClick={() => setPin('')}>
        Revoke
      </button>
    );
  }

  return (
    <span className="actions" style={{ justifyContent: 'flex-end' }}>
      <input
        type="password"
        inputMode="numeric"
        autoComplete="off"
        placeholder="Your PIN"
        style={{ marginTop: 0, width: 120 }}
        value={pin}
        onChange={(e) => setPin(e.target.value)}
      />
      <button
        type="button"
        className="danger small"
        disabled={busy || pin === ''}
        onClick={() => {
          setBusy(true);
          void (async () => {
            try {
              await admin.revokeRole(userId, role, pin);
              onDone();
            } catch (cause) {
              setError(messageFor(cause));
            } finally {
              setBusy(false);
            }
          })();
        }}
      >
        Confirm
      </button>
      {error !== undefined && <span className="error">{error}</span>}
    </span>
  );
}

function Grant({ onGranted }: { onGranted: () => void }) {
  const admin = useAdmin();
  const [userId, setUserId] = useState('');
  const [role, setRole] = useState<StaffRole>('support');
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [done, setDone] = useState<string | undefined>();

  return (
    <form
      className="panel"
      onSubmit={(event) => {
        event.preventDefault();
        setBusy(true);
        setError(undefined);
        setDone(undefined);
        void (async () => {
          try {
            await admin.grantRole(userId, role, pin);
            setPin('');
            setUserId('');
            setDone('Granted.');
            onGranted();
          } catch (cause) {
            setError(messageFor(cause));
          } finally {
            setBusy(false);
          }
        })();
      }}
    >
      <h2>Grant a role</h2>

      <div className="field-row two">
        <label>
          Customer id
          <input
            className="mono"
            value={userId}
            onChange={(e) => setUserId(e.target.value)}
            required
          />
          <span className="hint">
            From their page under Customers. Staff are customers with a role.
          </span>
        </label>

        <label>
          Role
          <select value={role} onChange={(e) => setRole(e.target.value as StaffRole)}>
            {ROLES.map((entry) => (
              <option key={entry.role} value={entry.role}>
                {entry.role}
              </option>
            ))}
          </select>
        </label>
      </div>

      <label>
        Your transaction PIN
        <input
          type="password"
          inputMode="numeric"
          autoComplete="off"
          value={pin}
          onChange={(e) => setPin(e.target.value)}
          required
        />
      </label>

      <button type="submit" disabled={busy}>
        {busy ? 'Granting…' : 'Grant'}
      </button>

      {error !== undefined && <p className="error">{error}</p>}
      {done !== undefined && <p className="ok">{done}</p>}

      <p className="hint">
        You cannot grant a role to yourself. That is refused by the database, so
        the check does not depend on this page.
      </p>
    </form>
  );
}
