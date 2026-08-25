'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { XetralClient } from '@xetral/client';
import { AdminClient } from '@xetral/client';
import { xetral } from '@/lib/session';
import { codeOf, messageFor } from '@/lib/errors';
import type { ApiErrorCode } from '@xetral/client';

/**
 * The client, wired to send the customer to sign-in when the session ends.
 *
 * Every page needs the same three lines and one of them is easy to forget: the
 * `onSignedOut` callback. A page without it renders an empty screen and no
 * explanation when a refresh token is finally rejected, which is the moment a
 * customer most needs to be told what happened.
 */
export function useXetral(): XetralClient {
  const router = useRouter();
  const signedOut = useCallback(() => router.push('/signin'), [router]);
  return useMemo(() => xetral(signedOut).client, [signedOut]);
}

/** The same, for the operations surface. */
export function useAdmin(): AdminClient {
  const router = useRouter();
  const signedOut = useCallback(() => router.push('/signin'), [router]);
  return useMemo(
    () => new AdminClient({ baseUrl: '/api/x', session: xetral(signedOut).session }),
    [signedOut],
  );
}

/**
 * An idempotency key that belongs to the ATTEMPT, not to the submit handler.
 *
 * Generated once when the form mounts and kept across retries, so a customer
 * who taps Send, loses signal, and taps again sends the SAME key and the
 * server answers `replayed` rather than moving the money twice. Generating one
 * inside the handler — the obvious place — defeats the guard entirely, and a
 * phone on a patchy connection is exactly where double-sends happen.
 *
 * `next()` is for after a SUCCESS: the form is now available for a genuinely
 * new transfer, and reusing the old key would have the server replay the
 * previous one and report success for money that never moved.
 */
export function useIdempotencyKey(): { key: string; next: () => void } {
  const [key, setKey] = useState(() => crypto.randomUUID());
  return { key, next: useCallback(() => setKey(crypto.randomUUID()), []) };
}

/**
 * Loads something once, with the loading, error and cancelled states that
 * every screen otherwise reimplements slightly differently.
 *
 * The `cancelled` flag matters: without it a customer who navigates away
 * mid-request gets a state update on an unmounted component, and — worse on a
 * slow connection — a stale response can land after a newer one and overwrite
 * a fresher balance with an older one.
 */
export function useLoad<T>(
  load: () => Promise<T>,
  deps: readonly unknown[] = [],
): {
  data: T | undefined;
  error: string | undefined;
  /**
   * The API's code for that error, when there was one.
   *
   * Carried alongside the sentence because some refusals need a whole screen
   * rather than a line of red text — `kyc_required` is one, and a hook that
   * flattened everything to a string forced every caller to either show a
   * dead end or re-parse the message it had just been handed.
   */
  code: ApiErrorCode | undefined;
  loading: boolean;
  reload: () => void;
} {
  const [data, setData] = useState<T | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [code, setCode] = useState<ApiErrorCode | undefined>();
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);
  const latest = useRef(load);
  latest.current = load;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(undefined);
    setCode(undefined);

    void (async () => {
      try {
        const result = await latest.current();
        if (!cancelled) setData(result);
      } catch (cause) {
        if (!cancelled) {
          setError(messageFor(cause));
          setCode(codeOf(cause));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nonce, ...deps]);

  return { data, error, code, loading, reload: useCallback(() => setNonce((n) => n + 1), []) };
}

/**
 * A form submission: busy while it runs, one message afterwards.
 *
 * `busy` disables the button, which is the cheapest of the three defences
 * against a double submission — the other two being the idempotency key and
 * the server's own constraint. It is also the only one the customer can see.
 */
export function useSubmit(): {
  busy: boolean;
  error: string | undefined;
  /** See `useLoad` — some refusals need a screen, not a line of red text. */
  code: ApiErrorCode | undefined;
  done: string | undefined;
  run: (action: () => Promise<string | undefined>) => Promise<void>;
  clear: () => void;
} {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [code, setCode] = useState<ApiErrorCode | undefined>();
  const [done, setDone] = useState<string | undefined>();

  const run = useCallback(async (action: () => Promise<string | undefined>) => {
    setBusy(true);
    setError(undefined);
    setCode(undefined);
    setDone(undefined);
    try {
      setDone(await action());
    } catch (cause) {
      setError(messageFor(cause));
      setCode(codeOf(cause));
    } finally {
      setBusy(false);
    }
  }, []);

  return {
    busy,
    error,
    code,
    done,
    run,
    clear: useCallback(() => {
      setError(undefined);
      setDone(undefined);
    }, []),
  };
}
