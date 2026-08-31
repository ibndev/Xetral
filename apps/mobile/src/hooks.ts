import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { router } from 'expo-router';
import { randomUUID } from 'expo-crypto';
import type { ApiErrorCode, XetralClient } from '@xetral/client';
import { codeOf, messageFor } from '@xetral/client';
import { xetral } from '@/session';
import { readPreference, writePreference } from '@/preferences';

/**
 * The same four hooks the web screens are built on, for the phone.
 *
 * `apps/web/src/lib/hooks.ts` is the original and CLAUDE.md records that every
 * customer-facing web screen goes through it. The phone had none of them, so
 * each of its seven screens hand-rolled busy/error/loading state — which is
 * why none of them carried the error CODE, and why a refusal on the phone
 * could not offer a way out the way the web's can.
 *
 * They are re-implemented rather than shared because they are React state, and
 * the two apps' navigation differs (`expo-router` vs `next/navigation`). What
 * IS shared is everything they carry: the client, the sentences, the codes.
 */

/** The client, wired to send the customer to sign-in when the session ends. */
export function useXetral(): XetralClient {
  return useMemo(() => xetral(() => router.replace('/signin')).client, []);
}

/**
 * An idempotency key that belongs to the ATTEMPT, not to the submit handler.
 *
 * Generated once when the form mounts and kept across retries, so a customer
 * who taps Send, loses signal on a bus, and taps again sends the SAME key and
 * the server answers `replayed` rather than moving the money twice. A phone on
 * a patchy connection is exactly where double-sends happen, so this matters
 * more here than it does on a laptop.
 */
export function useIdempotencyKey(): { key: string; next: () => void } {
  const [key, setKey] = useState(() => newKey());
  return { key, next: useCallback(() => setKey(newKey()), []) };
}

/**
 * `crypto.randomUUID` is not in React Native's Hermes runtime, so the web
 * hook's one-liner would throw here.
 *
 * `expo-crypto` RATHER THAN `Math.random`, and the first version of this did
 * use `Math.random` with a comment arguing that an idempotency key is not a
 * credential. The argument is true and it is the wrong instinct in a file
 * inside a money app: CodeQL flagged it high as insecure randomness, and it
 * was right to, because the next person to want a random string here reaches
 * for whatever is already imported. A native CSPRNG costs one module in an app
 * that already ships six, and removes the question.
 *
 * It also makes the key genuinely unique. `Math.random` is seeded per JS
 * context, and two attempts from a phone that was killed and relaunched are
 * exactly the case this key exists to tell apart.
 */
function newKey(): string {
  return randomUUID();
}

/**
 * Loads something once, with the loading, error and cancelled states that
 * every screen otherwise reimplements slightly differently.
 *
 * The `cancelled` flag matters more on a phone than in a browser: a customer
 * who taps back mid-request would otherwise get a state update on an unmounted
 * component, and on a slow connection a stale response can land after a newer
 * one and overwrite a fresher balance with an older one.
 */
export function useLoad<T>(
  load: () => Promise<T>,
  deps: readonly unknown[] = [],
): {
  data: T | undefined;
  error: string | undefined;
  /** Some refusals need a whole panel with a way forward rather than a line
   *  of red text — `kyc_required` and `pin_not_set` are both. */
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

/**
 * A preference this device remembers.
 *
 * The web's equivalent reads `localStorage` synchronously in an effect; here
 * the store is async, so the first render is always the FALLBACK and callers
 * pick one that is safe to be wrong about. For the balance that is `hidden`:
 * a moment of dots for somebody who wanted the figure costs nothing, and a
 * moment of the figure for somebody who asked for dots is the whole point of
 * the control.
 */
export function useRemembered<T extends string>(
  key: string,
  fallback: T,
  accepts: (stored: string) => boolean,
): [T, (next: T) => void] {
  const [value, setValue] = useState<T>(fallback);
  const check = useRef(accepts);
  check.current = accepts;

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const stored = await readPreference(key);
      // Validated rather than cast: the store is shared with everything else
      // this app keeps, and this value reaches a currency code and a render.
      if (!cancelled && stored !== undefined && check.current(stored)) setValue(stored as T);
    })();
    return () => {
      cancelled = true;
    };
  }, [key]);

  const write = useCallback(
    (next: T) => {
      setValue(next);
      void writePreference(key, next);
    },
    [key],
  );

  return [value, write];
}
