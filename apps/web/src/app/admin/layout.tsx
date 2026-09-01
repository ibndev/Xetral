import type { ReactNode } from 'react';
import { ElevationProvider } from '@/lib/elevation';
import { AdminGate } from './gate';
import { AdminShell } from './nav';

/**
 * The operations backend.
 *
 * THE GUARD IS STILL ON THE SERVER, and `AdminGate` does not replace it.
 * Every `/v1/admin/` route is gated on a staff role read fresh from the
 * database on each request; that is what protects the data, and it is what
 * would still protect it if this file were deleted.
 *
 * What the gate protects is the CHROME. Without it a stranger who typed this
 * address got the sidebar, the section names and a grid of empty tables — no
 * customer data, and still a map of the operations surface, and still a screen
 * from which "the admin is open for anyone to visit" is the obvious
 * conclusion. See `gate.tsx` for the three answers it distinguishes.
 *
 * Roles are also graduated rather than one "admin" flag: `support` can read,
 * `compliance` can freeze an account and review identity, `finance` can move
 * suspense money and change settings, `admin` can grant roles. Somebody
 * answering the phone does not need the ability to change the transfer fee.
 */
export default function AdminLayout({ children }: { children: ReactNode }) {
  return (
    <AdminGate>
      {/*
        The second factor, asked for ONCE per work session and handled at the
        client boundary rather than on each form. Without it every acting
        route answered `totp_required` for ever after the ten minutes that
        follow enrolment, because nothing in the product could elevate a
        session again — see lib/elevation.tsx.
      */}
      <ElevationProvider>
        <AdminShell>{children}</AdminShell>
      </ElevationProvider>
    </AdminGate>
  );
}
