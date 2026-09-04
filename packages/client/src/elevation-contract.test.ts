import { describe, expect, it } from 'vitest';
import { AdminClient } from './admin.js';
import { XetralClient } from './client.js';

/**
 * THE ELEVATION PROXY CAN ONLY WRAP A CLIENT THAT CAN ELEVATE.
 *
 * THE FAILURE THIS EXISTS FOR, which broke every acting route on the
 * operations dashboard.
 *
 * `elevation.tsx` wraps the admin client in a Proxy: a `totp_required`
 * refusal becomes a prompt, the six-digit code is exchanged for an elevated
 * session, and the original call is retried. Correct in shape, and it reached
 * for the exchange through a CAST —
 * `(target as { elevateStaffSession(c: string): Promise<void> })` — on a class
 * that did not have the method. `XetralClient` had it; `AdminClient`, which is
 * what the dashboard actually wraps, did not.
 *
 * A cast asserts, it does not check. So the compiler was satisfied, every
 * unit suite passed, and the failure appeared only when a real operator
 * submitted a real code: a `TypeError`, which is not an `ApiError`, so
 * `messageFor` fell through to "Something went wrong. Please try again."
 *
 * An operator holding a CORRECT PIN and a CORRECT code was told, every single
 * time, that something had gone wrong — and nothing on the dashboard could be
 * saved: not a fee, not a kill switch, not the funding rail. The dashboard
 * was, in effect, read-only, and nothing said so.
 *
 * The Proxy is constrained rather than cast now, so this is a build failure in
 * the app. This file is the second half: the constraint lives in `apps/web`
 * and the method lives here, so a refactor that removed it from the client
 * would break the app's build rather than this package's. Asserting it in the
 * package that owns it means the mistake cannot cross the boundary again.
 */

/** The shape `useElevating` demands of anything it wraps. */
interface Elevatable {
  elevateStaffSession(code: string): Promise<void>;
}

describe('every client the dashboard wraps can elevate a session', () => {
  it('AdminClient has elevateStaffSession', () => {
    // On the PROTOTYPE, because that is where the Proxy's `Reflect.get` finds
    // it — an instance field would satisfy a hand-written check here and not
    // the code that matters.
    expect(typeof AdminClient.prototype.elevateStaffSession).toBe('function');
  });

  it('XetralClient has it too, and the two agree', () => {
    // The customer client is not wrapped today. It carries the method because
    // `/v1/auth/totp/elevate` is declared `authenticated` rather than `staff`
    // — its whole purpose is to be reachable by a session that is NOT yet
    // elevated, which is every caller by definition.
    expect(typeof XetralClient.prototype.elevateStaffSession).toBe('function');
    expect(AdminClient.prototype.elevateStaffSession.length).toBe(
      XetralClient.prototype.elevateStaffSession.length,
    );
  });

  it('satisfies the interface the Proxy constrains on', () => {
    // Compile-time, and the point of the file: if `AdminClient` loses the
    // method this line stops type-checking, in the package that owns it.
    const admin: Elevatable = AdminClient.prototype;
    expect(admin).toBeDefined();
  });
});
