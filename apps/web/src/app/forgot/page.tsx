'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { xetral } from '@/lib/session';
import { useSubmit } from '@/lib/hooks';
import { Logo } from '@/ui/logo';
import { Icon } from '@/ui/icon';
import { ThemeToggle } from '@/ui/theme-toggle';
import { AuthAside } from '@/ui/auth-aside';

/**
 * Asking for a way back in, and taking it — BOTH STEPS ON ONE SCREEN.
 *
 * IT WAS A LINK, AND THE LINK NEEDED AN ADDRESS. With `APP_BASE_URL` unset the
 * API refused the whole flow before it did anything — "Password resets are
 * unavailable right now. Contact support." — on the one path whose premise is
 * that the customer has nothing left to contact support WITH.
 *
 * A CODE NEEDS NO ADDRESS, so this works on a deployment that has never been
 * told its own hostname. It is also the right shape on a phone, where
 * following a link means leaving the app for a browser and hoping something
 * hands the session back; here the customer reads six digits off one screen
 * and types them into the one they are already on.
 *
 * IT ANSWERS THE SAME THING WHETHER OR NOT THE ADDRESS EXISTS, and that is not
 * this screen being vague — it is the server's decision showing through. The
 * API returns 204 for every well-formed identifier and mints and hashes a code
 * either way so the two paths do not differ in timing, because an endpoint
 * that answered differently would turn any address list into a customer list.
 * So the second step appears for an address with no account too, and the
 * refusal comes when a code is presented rather than when one is asked for.
 */
export default function Forgot() {
  const router = useRouter();
  const [identifier, setIdentifier] = useState('');
  /*
   * WHAT WAS ASKED FOR, kept separate from what is in the box.
   *
   * The code is bound to the address it was issued against, so the second step
   * has to send the SAME identifier — and the field is still on screen and
   * still editable, because a customer who mistyped their address needs to fix
   * it. Sending whatever the box holds at submit time would silently present
   * the code against a different account.
   */
  const [asked, setAsked] = useState<string | undefined>();
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [mismatch, setMismatch] = useState(false);
  const [show, setShow] = useState(false);
  const { busy, error, run } = useSubmit();

  async function ask(event: React.FormEvent) {
    event.preventDefault();
    await run(async () => {
      const wanted = identifier.trim();
      await xetral().session.forgotPassword(wanted);
      setAsked(wanted);
      return undefined;
    });
  }

  async function finish(event: React.FormEvent) {
    event.preventDefault();
    // Checked here rather than on the server, because the server never sees
    // the second field — a confirmation is about what the customer typed.
    if (password !== confirm) {
      setMismatch(true);
      return;
    }
    setMismatch(false);

    await run(async () => {
      await xetral().session.resetPassword(asked ?? identifier.trim(), code, password);
      // To SIGN IN, not to the wallet: there is no session to carry, by
      // design — a leaked code grants a password that can be used, not a live
      // session — and using it revoked every other session on the account.
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
            <h1>{asked === undefined ? 'Reset your password' : 'Enter your code'}</h1>
            <p>
              {asked === undefined
                ? 'We will email you a six-digit code'
                : 'If that address has a Xetral account, a code is on its way'}
            </p>
          </div>

          {asked === undefined ? (
            <form className="auth-card animate-in d2" onSubmit={ask}>
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
                {busy ? 'Sending…' : 'Email me a code'}
              </button>

              {error !== undefined && (
                <p className="error"><Icon name="alert" size={16} /> {error}</p>
              )}
            </form>
          ) : (
            <form className="auth-card animate-in d2" onSubmit={finish}>
              <div className="field">
                <label htmlFor="code">Code from the email</label>
                <input
                  id="code"
                  // `text`, not `number`: a code with a leading zero is a real
                  // code, and a number input eats it. `inputMode` is what puts
                  // the digit keypad up on a phone.
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  placeholder="123456"
                  maxLength={16}
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  required
                />
                <p className="hint">
                  It expires in thirty minutes and works once. Five wrong tries
                  and you will need a new one.
                </p>
              </div>

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

              <button type="submit" className="block" disabled={busy || code.trim() === ''}>
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

              {/* The way out of a code that will never work — a mistyped
                  address, or five wrong tries. Without it the only escape is
                  reloading the page. */}
              <button
                type="button"
                className="link"
                onClick={() => {
                  setAsked(undefined);
                  setCode('');
                }}
              >
                Use a different address, or ask for a new code
              </button>
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
