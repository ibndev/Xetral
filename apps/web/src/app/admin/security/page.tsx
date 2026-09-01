'use client';

import { useState } from 'react';
import { Icon } from '@/ui/icon';
import { useSubmit, useXetral } from '@/lib/hooks';
import { FormError } from '@/ui/form-error';

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
  const { busy, error, code, done, run } = useSubmit();
  const [enrolment, setEnrolment] = useState<{ secret: string; otpauth_url: string }>();
  const [totp, setTotp] = useState('');

  return (
    <div className="panel">
      <h1>Your authenticator</h1>
      <h2>Required before any operations screen will answer</h2>

      <p className="lead">
        Every screen here asks for a second factor, reads included.
      </p>

      {enrolment === undefined ? (
        <>
          <p className="lead">
            You will get a secret to add to an authenticator app, then type one code
            to prove it works. It is shown once.
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
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void run(async () => {
              await client.confirmTotpEnrolment(totp);
              setTotp('');
              // Dropped from state the moment it is confirmed. It has no
              // further use here and every render it survives is another
              // place it can be read from.
              setEnrolment(undefined);
              return 'Your authenticator is set up. The operations screens will answer now.';
            });
          }}
        >
          {/*
            The secret in text, not a QR code. Rendering one would mean pulling
            in a QR library or calling an image service with the secret in the
            URL — and every authenticator app accepts a typed key. The
            otpauth:// line is there for anyone whose app takes one.
          */}
          <div className="notice warn">
            <p>
              <strong>Add this to your authenticator app now.</strong>
            </p>
            <p className="mono" style={{ wordBreak: 'break-all' }}>
              {enrolment.secret}
            </p>
            <p className="hint">
              Shown once. Lose it before confirming and you start again.
            </p>
          </div>

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
            <span className="hint">
              From the app you just added the secret to. Codes change every 30
              seconds.
            </span>
          </label>

          <div className="actions">
            <button type="submit" disabled={busy || totp.length !== 6}>
              {busy ? 'Checking…' : 'Confirm and turn it on'}
            </button>
          </div>
        </form>
      )}

      <FormError error={error} code={code} />
      {done !== undefined && (
        <p className="ok">
          <Icon name="check" size={16} /> {done}
        </p>
      )}
    </div>
  );
}
