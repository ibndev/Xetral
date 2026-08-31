import type { ReactNode } from 'react';
import { AdminShell } from './nav';

/**
 * The operations backend.
 *
 * Nothing here is protected by this layout, and that is worth being explicit
 * about: the guard is on the SERVER, where every `/v1/admin/` route is gated
 * on a staff role read fresh from the database on each request. A customer who
 * types this address sees a page of empty tables and a row of "you do not have
 * access to that" — which is the correct outcome and is what a client-side
 * check would only be decorating.
 *
 * Roles are also graduated rather than one "admin" flag: `support` can read,
 * `compliance` can freeze an account and review identity, `finance` can move
 * suspense money and change settings, `admin` can grant roles. Somebody
 * answering the phone does not need the ability to change the transfer fee.
 */
export default function AdminLayout({ children }: { children: ReactNode }) {
  return <AdminShell>{children}</AdminShell>;
}
