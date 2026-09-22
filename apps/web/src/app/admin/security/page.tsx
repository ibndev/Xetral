'use client';

import { useState } from 'react';
import { Icon } from '@/ui/icon';
import { useLoad, useSubmit, useXetral } from '@/lib/hooks';
import { FormError } from '@/ui/form-error';
import { AdminTitle } from '@/app/admin/nav';
import { ago, shortDate } from '../age';

/**
 * Setting up the staff second factor.
 *
 * THIS SCREEN DID NOT EXIST, and its absence made the whole operations
 * dashboard unusable for a new operator.
 *
 * `POST /v1/auth/totp/enrol` and `/totp/confirm` have been on the API since
 * the factor landed. Nothing in either client called them. Meanwhile every
 * `/v1/admin/` route refuses with `totp_not_enrolled` until the factor is
 * confirmed — so the first operator granted a role opened the dashboard, found
 * every screen refusing, and had no way to satisfy the requirement short of
 * curl. The screens looked empty, and were reported as empty.
 *
 * It lives under /admin because it is about the operations surface, and it is
 * deliberately reachable while every other operations screen is refusing: this
 * is the one page whose whole purpose is to be usable before the factor
 * exists. Nothing here is gated on a staff role either — the route it calls is
 * an ordinary authenticated one, and gating the fix on the thing it fixes is
 * the loop this page exists to break.
 */
export default function StaffSecurity() {
  const client = useXetral();
  const status = useLoad(() => client.totpStatus(), [client]);
  const { busy, error, code, done, run } = useSubmit();
  const [enrolment, setEnrolment] = useState<{ secret: string; otpauth_url: string }>();
  const [totp, setTotp] = useState('');

  const enrolled = status.data?.enrolled === true;

  return (
    <div className="panel auth-card">
      <AdminTitle>Your authenticator</AdminTitle>

      {/*
        THE TILE. In the comp it is a code to scan; here it is the SECRET while
        setting up — typed rather than scanned, because rendering a QR would
        mean a QR library or an image service with the secret in its URL, and
        every authenticator app takes a typed key — and a shield once it is
        on. Once confirmed the secret is never shown again, anywhere.
      */}
      <div className={enrolled ? 'auth-tile on' : 'auth-tile'} aria-hidden={enrolment === undefined}>
        {enrolment !== undefined ? (
          <span className="mono auth-secret">{groups(enrolment.secret)}</span>
        ) : (
          <Icon name={enrolled ? 'shield' : 'lock'} size={52} />
        )}
      </div>

      <div className="auth-body">
        <div className="auth-head">
          <span className="sec">Your authenticator</span>
          {status.data !== undefined &&
            (enrolled ? (
              <span className="badge ok">
                <span className="dot" />
                Enabled
              </span>
            ) : (
              <span className="badge warn">Not set up</span>
            ))}
        </div>

        {enrolled && status.data?.confirmed_at != null && (
          <>
            <p className="auth-copy">
              Authenticator app added {shortDate(status.data.confirmed_at)}. This is the second factor for your own operator sign-in, and every
              operations screen asks for it — reads included.
            </p>
            {status.data.last_used_at !== null && (
              <p className="auth-line">
                Last used · <span className="mono">{ago(status.data.last_used_at)}</span>
              </p>
            )}
            {/*
              NO RESET HERE, deliberately. A confirmed factor cannot be swapped
              from a session: re-enrolling onto an attacker's phone is the
              quiet takeover 014 exists to stop, and nothing in the audit log
              would look odd. Replacing it is an administrator's action.
            */}
            <p className="auth-copy">
              Changing phones? Replacing a confirmed authenticator is an
              administrator&rsquo;s action — it cannot be done from a signed-in
              session, because that is exactly what a stolen one would do.
            </p>
          </>
        )}

        {status.data !== undefined && !enrolled && enrolment === undefined && (
          <>
            <p className="auth-copy">
              Every operations screen asks for a second factor, reads included.
              You will get a secret to add to an authenticator app, then type one
              code to prove it works. It is shown once.
            </p>
            <div className="actions">
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    setEnrolment(await client.beginTotpEnrolment());
                    return undefined;
                  })
                }
              >
                {busy ? 'Working…' : 'Start setup'}
              </button>
            </div>
          </>
        )}

        {enrolment !== undefined && (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void run(async () => {
                await client.confirmTotpEnrolment(totp);
                setTotp('');
                setEnrolment(undefined);
                status.reload();
                return 'Your authenticator is set up. The operations screens will answer now.';
              });
            }}
          >
            <p className="auth-copy">
              <strong>Add the key on the left to your authenticator app now.</strong>{' '}
              Shown once — lose it before confirming and you start again. The{' '}
              <span className="mono">otpauth://</span> line is below for an app that
              takes one.
            </p>
            <p className="hint mono" style={{ wordBreak: 'break-all' }}>
              {enrolment.otpauth_url}
            </p>
            <label>
              Six-digit code
              <input
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]{6}"
                maxLength={6}
                value={totp}
                onChange={(e) => setTotp(e.target.value)}
                required
              />
              <span className="hint">Codes change every 30 seconds.</span>
            </label>
            <div className="actions">
              <button type="submit" disabled={busy || totp.length !== 6}>
                {busy ? 'Checking…' : 'Confirm and turn it on'}
              </button>
            </div>
          </form>
        )}

        {status.error !== undefined && <p className="error">{status.error}</p>}
        <FormError error={error} code={code} />
        {done !== undefined && (
          <p className="ok">
            <Icon name="check" size={16} /> {done}
          </p>
        )}
      </div>
    </div>
  );
}

/** A base32 secret in fours, which is how a person types one without losing
 *  their place. The spaces are ignored by every authenticator app. */
function groups(secret: string): string {
  return secret.replace(/(.{4})/g, '$1 ').trim();
}
