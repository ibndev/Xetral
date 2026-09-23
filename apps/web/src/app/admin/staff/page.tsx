'use client';

import { Fragment, useState } from 'react';
import type { AdminStaffGrant, StaffRole } from '@xetral/client';
import { useAdmin, useLoad } from '@/lib/hooks';
import { messageFor } from '@/lib/errors';
import { AdminError } from '../access';
import { Select } from '@/ui/select';
import { AdminTitle } from '@/app/admin/nav';
import { Kpis } from '../queue';
import { ageSince } from '../age';

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
  { role: 'dispute_reviewer', can: 'Answer customer disputes, and refund one that is upheld.' },
  { role: 'admin', can: 'Grant and revoke roles. Read the audit log.' },
];

/** The comp's order: the widest role first, so "Admin" reads before "Support". */
const RANK: readonly string[] = ['admin', 'finance', 'compliance', 'dispute_reviewer', 'giftcard_reviewer', 'support'];
const roleName = (role: string): string =>
  role.replace(/_/g, ' ').replace(/^./, (c: string) => c.toUpperCase());

interface Person {
  readonly userId: string;
  readonly email: string;
  readonly name: string | null;
  readonly roles: readonly StaffRole[];
  readonly hasTotp: boolean | undefined;
  readonly lastActive: string | null | undefined;
}

/** One row per PERSON, which is what the comp lists and what an operator
 *  means by "who has access" — the API stays one row per grant. */
function people(grants: readonly AdminStaffGrant[]): Person[] {
  const by = new Map<string, Person>();
  for (const g of grants) {
    const was = by.get(g.user_id);
    by.set(g.user_id, {
      userId: g.user_id,
      email: g.email,
      name: g.full_name ?? null,
      roles: [...(was?.roles ?? []), g.role as StaffRole].sort((a, b) => RANK.indexOf(a) - RANK.indexOf(b)),
      hasTotp: g.has_totp,
      lastActive: g.last_active_at,
    });
  }
  return [...by.values()].sort((a, b) => RANK.indexOf(a.roles[0] ?? '') - RANK.indexOf(b.roles[0] ?? ''));
}

export default function Staff() {
  const admin = useAdmin();
  const staff = useLoad(() => admin.staff(), [admin]);
  const [open, setOpen] = useState<string | undefined>();
  const rows = people(staff.data ?? []);
  const loaded = staff.data !== undefined;

  return (
    <>
      <AdminTitle>Staff</AdminTitle>
      <Kpis
        items={[
          { label: 'Operators', count: loaded ? rows.length : undefined },
          { label: 'Without 2FA', count: loaded ? rows.filter((p) => p.hasTotp === false).length : undefined, tone: 'danger' },
          { label: 'Admin', count: loaded ? rows.filter((p) => p.roles.includes('admin')).length : undefined },
        ]}
      />

      <div className="panel tbl-panel">
        <AdminError error={staff.error} code={staff.code} role="admin" />
        {staff.loading && <p className="spinner">Loading…</p>}
        {loaded && rows.length === 0 && <p className="empty">Nobody has a role.</p>}

        {rows.length > 0 && (
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Role</th>
                  <th>2FA</th>
                  <th>Last active</th>
                  <th className="r" aria-label="Action" />
                </tr>
              </thead>
              <tbody>
                {rows.map((person) => (
                  <Fragment key={person.userId}>
                    <tr>
                      <td>
                        <strong>{person.name ?? person.email}</strong>
                        {person.name !== null && <div className="cell-sub">{person.email}</div>}
                      </td>
                      <td>
                        <strong>{roleName(person.roles[0] ?? '')}</strong>
                        {person.roles.length > 1 && (
                          <div className="cell-sub">+ {person.roles.slice(1).map(roleName).join(', ')}</div>
                        )}
                      </td>
                      <td>
                        {person.hasTotp === undefined ? (
                          <span className="muted">—</span>
                        ) : (
                          <span className={person.hasTotp ? 'badge ok' : 'badge danger'}>
                            {person.hasTotp ? 'On' : 'Off'}
                          </span>
                        )}
                      </td>
                      <td className="quiet">
                        {person.lastActive == null ? 'never' : `${ageSince(person.lastActive)} ago`}
                      </td>
                      <td className="r">
                        <button
                          type="button"
                          className="ghost"
                          aria-expanded={open === person.userId}
                          onClick={() => setOpen(open === person.userId ? undefined : person.userId)}
                        >
                          {open === person.userId ? 'Close' : 'Manage'}
                        </button>
                      </td>
                    </tr>
                    {open === person.userId && (
                      <tr className="detail">
                        <td colSpan={5}>
                          {/* A person without a confirmed factor is refused on
                              every staff route, reads included (014) — they
                              enrol from their own Your authenticator screen. */}
                          {person.hasTotp === false && (
                            <p className="hint">
                              No second factor yet: every operations screen refuses them until
                              they enrol on Your authenticator.
                            </p>
                          )}
                          {person.roles.map((role) => (
                            <div className="row" key={role}>
                              <span>{roleName(role)}</span>
                              <Revoke userId={person.userId} role={role} onDone={staff.reload} />
                            </div>
                          ))}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="grid two">
        <Grant onGranted={staff.reload} />

        <div className="panel">
          <span className="sec">What each role can do</span>
          {ROLES.map((entry) => (
            <div className="row" key={entry.role}>
              <span className="badge">{roleName(entry.role)}</span>
              <span className="muted" style={{ textAlign: 'right' }}>
                {entry.can}
              </span>
            </div>
          ))}
          <p className="hint">Grant the narrowest role that does the job.</p>
        </div>
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
      <span className="sec">Grant a role</span>

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

        <label id="staff-role">
          Role
          <Select
            labelledBy="staff-role"
            value={role}
            onChange={(value) => setRole(value as StaffRole)}
            options={ROLES.map((entry) => ({ value: entry.role, label: roleName(entry.role) }))}
          />
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
        You cannot grant a role to yourself.
      </p>
    </form>
  );
}
