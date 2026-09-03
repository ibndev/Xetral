'use client';

import Link from 'next/link';
import { useState } from 'react';
import { xetral } from '@/lib/session';
import { useSubmit } from '@/lib/hooks';
import { Logo } from '@/ui/logo';
import { Icon } from '@/ui/icon';
import { ThemeToggle } from '@/ui/theme-toggle';
import { AuthAside } from '@/ui/auth-aside';

/**
 * Asking for a way back in.
 *
 * THIS SCREEN DID NOT EXIST, on either platform, while the API has had
 * `/v1/auth/password/forgot` and `/reset` since Tier 2 — so a customer who
 * forgot their password had no route back to their money at all, and the two
 * endpoints that exist to give them one were unreachable from anywhere.
 *
 * IT ANSWERS THE SAME THING WHETHER OR NOT THE ADDRESS EXISTS, and that is not
 * this screen being vague — it is the server's decision showing through. The
 * API returns 204 for every well-formed identifier and mints and hashes a
 * token either way so the two paths do not differ in timing, because an
 * endpoint that answered differently would turn any address list into a
 * customer list. The client cannot tell, and the words here are written so
 * that a customer who typed the wrong address is not left believing mail is
 * coming.
 */
export default function Forgot() {
  const [identifier, setIdentifier] = useState('');
  const [sent, setSent] = useState(false);
  const { busy, error, run } = useSubmit();

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    await run(async () => {
      await xetral().session.forgotPassword(identifier.trim());
      setSent(true);
      return undefined;
    });
  }

  return (
    <main className="auth">
      <AuthAside />

      <div className="auth-main">
        <div className="auth-toggle">
          <ThemeToggle />
        </div>

        <div className="auth-inner">
          <div className="auth-brand animate-in">
            <Logo size={32} />
          </div>

          <div className="auth-head animate-in d1">
            <h1>{sent ? 'Check your inbox' : 'Reset your password'}</h1>
            <p>
              {sent
                ? 'If that address has a Xetral account, a link is on its way.'
                : 'We will email you a link to set a new one'}
            </p>
          </div>

          {sent ? (
            <div className="auth-card animate-in d2">
              {/* NO CONFIRMATION THAT ANYTHING WAS SENT. The server does not
                  tell us, on purpose, and inventing certainty here would undo
                  that from the outside — and would leave somebody who mistyped
                  their address waiting for mail that is not coming. */}
              <p className="lead">
                The link lasts one hour and can be used once. If nothing arrives,
                check the address you typed and try again.
              </p>
              <Link className="btn block" href="/signin">
                Back to sign in
              </Link>
            </div>
          ) : (
            <form className="auth-card animate-in d2" onSubmit={submit}>
              <div className="field">
                <label htmlFor="identifier">Email address</label>
                <input
                  id="identifier"
                  type="email"
                  inputMode="email"
                  placeholder="you@example.com"
                  value={identifier}
                  autoComplete="email"
                  onChange={(e) => setIdentifier(e.target.value)}
                  required
                />
              </div>

              <button type="submit" className="block" disabled={busy || identifier.trim() === ''}>
                {busy ? 'Sending…' : 'Email me a link'}
              </button>

              {error !== undefined && (
                <p className="error"><Icon name="alert" size={16} /> {error}</p>
              )}
            </form>
          )}

          <p className="auth-foot animate-in d3">
            Remembered it? <Link href="/signin">Sign in</Link>
          </p>
        </div>
      </div>
    </main>
  );
}
