'use client';

import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { codeOf } from '@/lib/errors';

/**
 * ONE CODE, ONE WORK SESSION, AND EVERY ACTION GETS IT WITHOUT ASKING.
 *
 * The acting half of the operations dashboard was unreachable. Elevation is
 * recorded on the session, and only two things could ever set it: confirming
 * an enrolment, which happens once, and an acting request carrying a code —
 * which no client ever sent. So the dashboard worked for the ten minutes after
 * somebody enrolled and then refused every action for ever.
 *
 * What made it hard to see is that the refusal was articulate and pointed at
 * the wrong thing. `totp_required` renders as "Enter the six-digit code from
 * your authenticator app", and the only field on the provider-key form is the
 * transaction PIN — so the code went in there, the PIN check refused it, and
 * an operator with a correct code and a correct PIN was told they were wrong.
 *
 * THE PROMPT IS AT THE CLIENT BOUNDARY, NOT ON EACH FORM. `AdminClient` has
 * forty-seven methods; asking each one to catch `totp_required`, render a
 * field and retry is forty-seven chances to forget, and the one that forgot
 * would be a dead end again. A Proxy around the client wraps every method
 * there is — including any added later, which is the part a hand-written list
 * cannot promise. Same argument as wrapping provider ports at the injection
 * boundary rather than writing seven adapters by hand.
 */

/** Asks the operator for a code and resolves with it; rejects if they cancel. */
type Demand = () => Promise<string>;

const ElevationContext = createContext<Demand | undefined>(undefined);

/**
 * Wraps an admin client so a `totp_required` refusal becomes a prompt and a
 * retry rather than an error the operator has to interpret.
 *
 * Returns the client unchanged when there is no provider above it — every
 * customer-facing screen — so this cannot alter behaviour outside `/admin`.
 */
export function useElevating<T extends object>(client: T): T {
  const demand = useContext(ElevationContext);

  return useMemo(() => {
    if (demand === undefined) return client;

    return new Proxy(client, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver) as unknown;
        if (typeof value !== 'function') return value;

        return async (...args: unknown[]) => {
          try {
            return await (value as (...a: unknown[]) => Promise<unknown>).apply(target, args);
          } catch (cause) {
            if (codeOf(cause) !== 'totp_required') throw cause;

            // The operator supplies a code, the SESSION is elevated, and the
            // original call is repeated. Retried ONCE: a second refusal is a
            // real one, and a loop here would ask for a code for ever.
            const code = await demand();
            await (target as { elevateStaffSession(c: string): Promise<void> })
              .elevateStaffSession(code);
            return await (value as (...a: unknown[]) => Promise<unknown>).apply(target, args);
          }
        };
      },
    });
  }, [client, demand]);
}

export function ElevationProvider({ children }: { children: ReactNode }) {
  const [asking, setAsking] = useState(false);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  /** Set while a prompt is open; settled by the form or by cancelling. */
  const pending = useRef<
    { resolve: (code: string) => void; reject: (e: unknown) => void } | undefined
  >(undefined);

  const demand = useCallback<Demand>(() => {
    setCode('');
    setError(undefined);
    setAsking(true);
    return new Promise<string>((resolve, reject) => {
      pending.current = { resolve, reject };
    });
  }, []);

  function close(): void {
    setAsking(false);
    setBusy(false);
    // Rejected rather than left hanging: the caller is awaiting this, and an
    // unsettled promise is a submit button that spins for ever.
    pending.current?.reject(new Error('cancelled'));
    pending.current = undefined;
  }

  function submit(event: React.FormEvent): void {
    event.preventDefault();
    if (!/^[0-9]{6}$/.test(code)) {
      setError('That is six digits from your authenticator app.');
      return;
    }
    setBusy(true);
    const settle = pending.current;
    pending.current = undefined;
    setAsking(false);
    settle?.resolve(code);
  }

  return (
    <ElevationContext.Provider value={demand}>
      {children}

      {asking && (
        <div className="scrim" role="presentation" onClick={close}>
          <form
            className="card elevate-card"
            role="dialog"
            aria-modal="true"
            aria-labelledby="elevate-title"
            onClick={(e) => e.stopPropagation()}
            onSubmit={submit}
          >
            <h2 id="elevate-title">Confirm it is you</h2>
            <p className="lead">
              Open your authenticator app and enter the six-digit code. It covers
              everything you do for the next few minutes, so you will not be asked
              again for each action.
            </p>

            <label>
              Authenticator code
              <input
                // NOT the transaction PIN, and the label says so. Confusing the
                // two is the whole reason this dialog exists.
                autoFocus
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                placeholder="000000"
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
              />
            </label>

            {error !== undefined && <p className="error">{error}</p>}

            <div className="actions">
              <button type="submit" disabled={busy}>
                {busy ? 'Checking…' : 'Continue'}
              </button>
              <button type="button" className="ghost" onClick={close}>
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}
    </ElevationContext.Provider>
  );
}
