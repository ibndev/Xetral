'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { xetral } from '@/lib/session';
import { useSubmit } from '@/lib/hooks';
import { Logo } from '@/ui/logo';
import { Icon } from '@/ui/icon';
import { ThemeToggle } from '@/ui/theme-toggle';
import { AuthAside } from '@/ui/auth-aside';

/**
 * Setting a new password from the link in the email.
 *
 * THE PATH IS NOT ARBITRARY. `PasswordResetService.#resetUrl` builds
 * `${APP_BASE_URL}/reset-password?token=…`, so this directory's NAME is half
 * of a contract whose other half is a string in another workspace — the exact
 * shape of the `/pay` bug, where the service built a link to a route that did
 * not exist and every one of them answered 404. `reset-link.test.ts` compares
 * the two.
 *
 * IT ISSUES NO SESSION. The API answers 204 and the customer signs in with the
 * password they just set, which is also what proves the reset worked. A leaked
 * link therefore grants a password that can be used, not an immediately live
 * session — and using it revokes every other live session, because finishing a
 * reset while an intruder is still signed in is theatre.
 */
export default function ResetPasswordPage() {
  // `useSearchParams` suspends, so the screen it is read on must sit inside a
  // boundary or the whole route opts out of static rendering.
  return (
    <Suspense fallback={null}>
      <ResetPassword />
    </Suspense>
  );
}

function ResetPassword() {
  const router = useRouter();
  const params = useSearchParams();
  const token = params.get('token') ?? '';

  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [mismatch, setMismatch] = useState(false);
  const [show, setShow] = useState(false);
  const { busy, error, run } = useSubmit();

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    // Checked here rather than on the server, because the server never sees the
    // second field — a confirmation is about what the customer typed.
    if (password !== confirm) {
      setMismatch(true);
      return;
    }
    setMismatch(false);

    await run(async () => {
      await xetral().session.resetPassword(token, password);
      // To SIGN IN, not to the wallet: there is no session to carry, by
      // design, and sending them anywhere else would be a page that
      // immediately bounces them back here.
      router.push('/signin');
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
            <h1>Set a new password</h1>
            <p>Then sign in with it</p>
          </div>

          {token === '' ? (
            /* A link that carried no token, or one somebody typed by hand. Said
               plainly rather than shown as a form that cannot work. */
            <div className="auth-card animate-in d2">
              <p className="lead">
                This link is missing its token. Ask for a new one and open the
                most recent email.
              </p>
              <Link className="btn block" href="/forgot">
                Email me a new link
              </Link>
            </div>
          ) : (
            <form className="auth-card animate-in d2" onSubmit={submit}>
              <div className="field">
                <label htmlFor="password">New password</label>
                <div className="input-affix">
                  <input
                    id="password"
                    type={show ? 'text' : 'password'}
                    placeholder="At least 10 characters"
                    value={password}
                    autoComplete="new-password"
                    onChange={(e) => setPassword(e.target.value)}
                    required
                  />
                  <button
                    type="button"
                    className="affix"
                    onClick={() => setShow((v) => !v)}
                    aria-label={show ? 'Hide password' : 'Show password'}
                  >
                    <Icon name={show ? 'eyeOff' : 'eye'} size={19} />
                  </button>
                </div>
                <p className="hint">
                  Length beats punctuation — a phrase you remember is stronger
                  than P@ssw0rd.
                </p>
              </div>

              <div className="field">
                <label htmlFor="confirm">Confirm password</label>
                <input
                  id="confirm"
                  type="password"
                  placeholder="Type it again"
                  value={confirm}
                  autoComplete="new-password"
                  onChange={(e) => setConfirm(e.target.value)}
                  required
                />
              </div>

              <button type="submit" className="block" disabled={busy}>
                {busy ? 'Saving…' : 'Set my password'}
              </button>

              {mismatch && (
                <p className="error">
                  <Icon name="alert" size={16} /> Those two passwords are not the same.
                </p>
              )}
              {error !== undefined && (
                <p className="error"><Icon name="alert" size={16} /> {error}</p>
              )}
            </form>
          )}

          <p className="auth-foot animate-in d3">
            <Link href="/signin">Back to sign in</Link>
          </p>
        </div>
      </div>
    </main>
  );
}
