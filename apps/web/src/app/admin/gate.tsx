'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { ReactNode } from 'react';
import { Icon } from '@/ui/icon';
import { useAdmin, useLoad } from '@/lib/hooks';

/**
 * WHO IS ALLOWED TO SEE THE OPERATIONS CHROME.
 *
 * The guard on every `/v1/admin/` route is real and lives on the SERVER, where
 * it belongs: a role read fresh from the database on each request, so a
 * withdrawn role stops working immediately rather than at the next sign-in.
 * None of that changes here.
 *
 * What was wrong is what a STRANGER SAW. The layout rendered unconditionally,
 * so anyone who typed /admin got the sidebar, the section names, the queue
 * headings and a grid of empty tables. No customer data reached them — every
 * call was refused — but "the admin is just open for anyone to visit" is a
 * reasonable thing to conclude from that screen, and it is also a map of the
 * operations surface handed to whoever asked.
 *
 * So the chrome now waits for an answer, and there are three:
 *
 *   NO SESSION      → sign-in, with no operations vocabulary shown on the way.
 *   NO STAFF ROLE   → a plain refusal. Not a list of roles they might want:
 *                     telling a signed-in stranger that `compliance` and
 *                     `finance` exist is the same leak in fewer words.
 *   A ROLE          → the dashboard, exactly as before.
 *
 * `overview()` is the probe because it is the LOWEST-privileged read on the
 * surface — `support`, which every staff role can do. A dedicated "what am I"
 * endpoint would have to be declared `staff()` to satisfy route coverage, and
 * would then need a role to ask whether you have a role.
 *
 * `totp_not_enrolled` is deliberately NOT a refusal here: it means the account
 * DOES hold a role and has not set the factor up yet, and the screens explain
 * that themselves with a link to the enrolment page. Bouncing it would hide
 * the one screen that fixes it.
 */
export function AdminGate({ children }: { readonly children: ReactNode }) {
  const router = useRouter();
  const admin = useAdmin();
  const probe = useLoad(() => admin.overview(), [admin]);

  // The two the API actually sends for "no usable session". There is no
  // `session_expired` code — the client raises `SessionExpiredError`, which
  // `codeOf` reports as `invalid_token`, and `useXetral`'s `onSignedOut` has
  // usually already redirected by then. This is the belt to that brace.
  const signedOut = probe.code === 'invalid_token' || probe.code === 'invalid_grant';

  useEffect(() => {
    if (signedOut) router.replace('/signin');
  }, [signedOut, router]);

  // Nothing about operations while we do not yet know. A flash of the sidebar
  // before a redirect is the same disclosure, one frame long.
  if (probe.loading || signedOut) {
    return (
      <main className="shell">
        <p className="spinner">Loading…</p>
      </main>
    );
  }

  if (probe.code === 'forbidden') {
    return (
      <main className="shell">
        <div className="card">
          <span className="verify-icon" aria-hidden="true">
            <Icon name="lock" size={22} />
          </span>
          <h1>This is the operations dashboard</h1>
          <p className="lead">
            Ask whoever administers this platform to grant you a role.
          </p>
          <Link href="/wallet" className="btn">
            Back to my wallet
          </Link>
        </div>
      </main>
    );
  }

  return <>{children}</>;
}
